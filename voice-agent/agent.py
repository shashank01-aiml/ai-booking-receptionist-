import asyncio
import functools
import logging
import os
import sys
import threading
import time
from datetime import datetime, timedelta
from typing import Any

import httpx
from dotenv import load_dotenv
from livekit import agents, api
from livekit.agents import Agent, AgentSession, RunContext, function_tool, llm
from livekit.agents.metrics import AgentSessionUsage
from livekit.plugins import cartesia, deepgram, groq, silero

# Ensure UTF-8 output on Windows console to avoid encoding errors
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:5000").rstrip("/")

# Optimize Windows SSL context scanning to eliminate 500ms-850ms event loop freezes
if sys.platform == "win32":
    try:
        from livekit.agents.utils import http_context
        http_context._create_ssl_context = functools.cache(http_context._create_ssl_context)
    except Exception as e:
        logging.debug("SSL cache bypass: %s", e)

# Balanced Silero VAD: 350ms silence detection allows natural human pauses without premature cutoffs or stacked latency
preloaded_vad = silero.VAD.load(
    min_speech_duration=0.10,     # Ignore pops & clicks < 100ms
    min_silence_duration=0.35,    # 350ms allows natural speech pauses
    prefix_padding_duration=0.25, # Retains start of words
)


def normalize_date(date_str: str) -> str:
    """Ensure YYYY-MM-DD format."""
    try:
        parts = date_str.strip().split("-")
        if len(parts) == 3:
            return f"{int(parts[0]):04d}-{int(parts[1]):02d}-{int(parts[2]):02d}"
    except Exception:
        pass
    return date_str.strip()


def normalize_time(time_str: str) -> str:
    """Ensure HH:MM 24-hour format."""
    try:
        parts = time_str.strip().split(":")
        if len(parts) == 2:
            return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
    except Exception:
        pass
    return time_str.strip()


class RestaurantReceptionist(Agent):
    def __init__(self):
        now = datetime.now()
        today_iso = now.strftime("%Y-%m-%d")
        tomorrow_iso = (now + timedelta(days=1)).strftime("%Y-%m-%d")

        instructions = f"""You are the voice receptionist for Demo Restaurant.
Today is {today_iso}, tomorrow is {tomorrow_iso}.
Rules:
- Speak in 1-2 short, spoken sentences. Never use markdown or bullet points.
- Available tables: 5x5-seaters (T5-1 to T5-5), 4x4-seaters (T4-1 to T4-4), 2x2-seaters (T2-1, T2-2).
- Reservations are strictly 1 hour. If fully booked, say tables are unavailable for that seating and offer earlier or later hours.
- Briefly confirm name, date, time, and party size before booking.
- Dates must be YYYY-MM-DD, times 24h HH:MM format for tool arguments.
"""
        super().__init__(instructions=instructions)
        # Persistent HTTP client to avoid blocking event loop
        self.http_client = httpx.AsyncClient(base_url=BACKEND_URL, timeout=8.0, verify=False)
        self.last_confirmed_booking: dict[str, Any] | None = None

    async def aclose(self):
        try:
            await self.http_client.aclose()
        except Exception:
            pass

    async def llm_node(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        model_settings: Any,
    ):
        ctx = chat_ctx.copy()
        # Safe pruning: preserves system instructions at index 0, cleans orphaned tool pairs
        ctx.truncate(max_items=10)

        # Inject active booking state so caller details are never forgotten after truncation
        if self.last_confirmed_booking:
            b = self.last_confirmed_booking
            ctx.add_message(
                role="system",
                content=f"Current booking: #{b['id']} for {b['customer_name']}, Table {b['table_number']} on {b['date']} at {b['time']} for {b['guests']} guests.",
            )

        async for chunk in Agent.default.llm_node(self, ctx, tools, model_settings):
            yield chunk

    @function_tool()
    async def check_availability(
        self,
        ctx: RunContext,
        date: str,
        time: str,
        guests: int,
    ) -> str:
        """Check table availability. date YYYY-MM-DD, time HH:MM, guests int."""
        clean_date = normalize_date(date)
        clean_time = normalize_time(time)
        logging.info("Checking availability: date=%s, time=%s, guests=%s", clean_date, clean_time, guests)

        try:
            response = await self.http_client.get(
                "/api/bookings/availability",
                params={
                    "restaurantId": 1,
                    "date": clean_date,
                    "time": clean_time,
                    "guests": guests,
                },
            )
            data = response.json()
            if response.status_code != 200:
                return f"Check failed: {data.get('error', 'Error')}"

            tables = data.get("availableTables", [])
            if not tables:
                msg = data.get("message") or f"Table unavailable for seating {guests}"
                return f"{msg} on {clean_date} at {clean_time}."

            best = tables[0]
            return f"Table {best.get('table_number')} is available for {guests} guests on {clean_date} at {clean_time}. Ask for name and phone to book."
        except Exception as e:
            logging.error("check_availability error: %s", e)
            return "Unable to check database right now."

    @function_tool()
    async def create_booking(
        self,
        ctx: RunContext,
        name: str,
        phone: str,
        date: str,
        time: str,
        guests: int,
    ) -> str:
        """Create confirmed reservation. name str, phone str, date YYYY-MM-DD, time HH:MM, guests int."""
        clean_date = normalize_date(date)
        clean_time = normalize_time(time)
        clean_name = name.strip()
        clean_phone = phone.strip()
        FORBIDDEN_NAMES = {
            "john doe", "john h. davis", "john davis", "jane doe", "customer",
            "caller", "user", "guest", "test", "my name", "someone"
        }
        if not clean_name or len(clean_name) < 2 or clean_name.lower() in FORBIDDEN_NAMES:
            logging.warning("create_booking blocked invalid name: %s", clean_name)
            return "Name needed. Ask: 'What name should I put on the reservation?'"

        # Deduplication protection: if this exact booking was just created in this session, return it
        if self.last_confirmed_booking and (
            self.last_confirmed_booking.get("name", "").lower() == clean_name.lower()
            and self.last_confirmed_booking.get("date") == clean_date
            and self.last_confirmed_booking.get("time") == clean_time
        ):
            b = self.last_confirmed_booking
            return f"Booking #{b.get('id')} already confirmed for {b.get('customer_name')}, Table {b.get('table_number')}."

        logging.info("Creating booking: name=%s, phone=%s, date=%s, time=%s, guests=%s", clean_name, clean_phone, clean_date, clean_time, guests)

        try:
            response = await self.http_client.post(
                "/api/bookings",
                json={
                    "restaurantId": 1,
                    "name": clean_name,
                    "phone": clean_phone,
                    "date": clean_date,
                    "time": clean_time,
                    "guests": guests,
                },
            )
            data = response.json()
            if response.status_code == 201:
                b = data.get("booking", {})
                self.last_confirmed_booking = {
                    "id": b.get("id"),
                    "name": clean_name,
                    "customer_name": b.get("customer_name"),
                    "table_number": b.get("table_number"),
                    "reservation_date": b.get("reservation_date"),
                    "reservation_time": b.get("reservation_time"),
                    "guests": b.get("guests"),
                    "date": clean_date,
                    "time": clean_time,
                }
                return f"Booking #{b.get('id')} confirmed for {b.get('customer_name')}, Table {b.get('table_number')} on {b.get('reservation_date')} at {b.get('reservation_time')} for {b.get('guests')} guests."
            error_msg = data.get("error", "Unable to create booking")
            return f"Reservation could not be made: {error_msg}"
        except Exception as e:
            logging.error("create_booking error: %s", e)
            return "Could not connect to database."

    @function_tool()
    async def get_booking(
        self,
        ctx: RunContext,
        booking_id: int,
    ) -> str:
        """Get reservation details by numeric booking ID."""
        logging.info("Retrieving booking: id=%s", booking_id)
        try:
            response = await self.http_client.get(f"/api/bookings/{booking_id}")
            data = response.json()
            if response.status_code == 200:
                return f"Booking #{data.get('id')} for {data.get('customer_name')}: Table {data.get('table_number')}, {data.get('reservation_date')} at {data.get('reservation_time')} for {data.get('guests')} guests. Status: {data.get('status')}."
            if response.status_code == 404:
                return f"No reservation found with ID #{booking_id}."
            return f"Error: {data.get('error', 'Unknown error')}"
        except Exception as e:
            logging.error("get_booking error: %s", e)
            return "Could not access database."

    @function_tool()
    async def modify_booking(
        self,
        ctx: RunContext,
        booking_id: int,
        name: str = "",
        phone: str = "",
        date: str = "",
        time: str = "",
        guests: int = 0,
    ) -> str:
        """Modify booking details. booking_id int required; optional: name, phone, date YYYY-MM-DD, time HH:MM, guests int."""
        logging.info("Modifying booking: id=%s", booking_id)
        body: dict[str, Any] = {}
        if name.strip():
            body["name"] = name.strip()
        if phone.strip():
            body["phone"] = phone.strip()
        if date.strip():
            body["date"] = normalize_date(date)
        if time.strip():
            body["time"] = normalize_time(time)
        if guests > 0:
            body["guests"] = guests

        if not body:
            return "No modification details specified."

        try:
            response = await self.http_client.patch(
                f"/api/bookings/{booking_id}",
                json=body,
            )
            data = response.json()
            if response.status_code == 200:
                b = data.get("booking", {})
                return f"Booking #{b.get('id')} updated: Table {b.get('table_number')} on {b.get('reservation_date')} at {b.get('reservation_time')} for {b.get('guests')} guests."
            return f"Could not modify booking: {data.get('error', 'Update failed')}"
        except Exception as e:
            logging.error("modify_booking error: %s", e)
            return "Could not reach database."

    @function_tool()
    async def cancel_booking(
        self,
        ctx: RunContext,
        booking_id: int,
    ) -> str:
        """Cancel reservation by numeric booking ID."""
        logging.info("Cancelling booking: id=%s", booking_id)
        try:
            response = await self.http_client.delete(f"/api/bookings/{booking_id}")
            data = response.json()
            if response.status_code == 200:
                return f"Booking #{booking_id} cancelled."
            if response.status_code == 404:
                return f"Booking #{booking_id} not found."
            return f"Could not cancel booking: {data.get('error', 'Cancellation failed')}"
        except Exception as e:
            logging.error("cancel_booking error: %s", e)
            return "Could not reach database."


server = agents.AgentServer(
    num_idle_processes=1,
    max_retry=999999,
)


@server.rtc_session(agent_name="restaurant-receptionist")
async def restaurant_receptionist(ctx: agents.JobContext):
    logging.info("Starting optimized ultra-low-latency receptionist agent session for room: %s", ctx.room.name)

    await ctx.connect()

    try:
        await ctx.wait_for_participant()
    except Exception as e:
        logging.warning("wait_for_participant warning: %s", e)

    session = AgentSession(
        stt=deepgram.STT(
            model="nova-3",
            interim_results=True,
            no_delay=True,
            endpointing_ms=25,
        ),
        llm=groq.LLM(
            model="qwen/qwen3.8-27b",
            temperature=0.1,
            max_completion_tokens=120,  # Caps completion tokens & reasoning
        ),
        tts=cartesia.TTS(
            model="sonic-3",
        ),
        vad=preloaded_vad,
        aec_warmup_duration=None,
        turn_handling={
            "endpointing": {
                "mode": "fixed",
                "min_delay": 0.20,   # Fast 200ms fixed delay after speech ends
                "max_delay": 0.45,  # 450ms max delay
            },
            "preemptive_generation": {
                "enabled": False,  # Clean 1-call-per-turn execution, cuts token burn by ~60%
            },
        },
    )

    @session.on("session_usage_updated")
    def _on_session_usage(ev: Any):
        try:
            usage = getattr(ev, "usage", ev)
            model_usage = getattr(usage, "model_usage", {})
            for model_name, model_use in model_usage.items():
                logging.info(
                    "[TOKEN USAGE] model=%s prompt_tokens=%d completion_tokens=%d total=%d",
                    model_name,
                    getattr(model_use, "prompt_tokens", 0),
                    getattr(model_use, "completion_tokens", 0),
                    getattr(model_use, "total_tokens", 0),
                )
        except Exception as e:
            logging.debug("Token usage logging exception: %s", e)

    agent_instance = RestaurantReceptionist()
    logging.info(
        "Initialized RestaurantReceptionist with %d tools: %s",
        len(agent_instance.tools),
        [t.id for t in agent_instance.tools],
    )

    await session.start(
        room=ctx.room,
        agent=agent_instance,
    )

    logging.info("Agent joined the LiveKit room and ready for low-latency interactions")

    await session.say("Hi, welcome to Demo Restaurant. How can I help you today?")


async def auto_dispatch_active_rooms():
    """Scans for active rooms with connected participants and automatically dispatches the agent."""
    try:
        lkapi = api.LiveKitAPI()
        res = await lkapi.room.list_rooms(api.ListRoomsRequest())
        for r in res.rooms:
            if r.num_participants > 0:
                logging.info("Found active room '%s' with %d participants. Auto-dispatching agent...", r.name, r.num_participants)
                await lkapi.agent_dispatch.create_dispatch(
                    api.CreateAgentDispatchRequest(
                        agent_name="restaurant-receptionist",
                        room=r.name,
                    )
                )
        await lkapi.aclose()
    except Exception as e:
        logging.debug("Auto-dispatch scan: %s", e)


def _delayed_auto_dispatch():
    time.sleep(3)
    try:
        asyncio.run(auto_dispatch_active_rooms())
    except Exception:
        pass


if __name__ == "__main__":
    threading.Thread(target=_delayed_auto_dispatch, daemon=True).start()
    agents.cli.run_app(server)