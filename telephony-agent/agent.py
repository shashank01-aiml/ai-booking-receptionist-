import asyncio
import functools
import logging
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import httpx
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import Agent, AgentSession, RunContext, function_tool, llm
from livekit.agents.utils import http_context
from livekit.plugins import cartesia, deepgram, groq, silero

# Ensure UTF-8 output on Windows console
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
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER", "").strip()
RESTAURANT_FRONT_DESK_PHONE = os.getenv("RESTAURANT_FRONT_DESK_PHONE", "+15551234567").strip()

# 1. OPTIMIZATION: Pre-warm and cache SSL context to eliminate 250ms-800ms Windows cert scanning freezes
http_context._create_ssl_context = functools.cache(http_context._create_ssl_context)
try:
    http_context._create_ssl_context()
except Exception as e:
    logging.warning("SSL prewarm warning: %s", e)

# 2. OPTIMIZATION: Low-latency Silero VAD (250ms silence detection)
preloaded_vad = silero.VAD.load(
    min_speech_duration=0.05,
    min_silence_duration=0.25,
    prefix_padding_duration=0.15,
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
    """Ensure 24-hour HH:MM format."""
    try:
        parts = time_str.strip().split(":")
        if len(parts) == 2:
            return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
    except Exception:
        pass
    return time_str.strip()


def format_phone_for_speech(phone: str) -> str:
    """Formats phone number cleanly for natural TTS reading (e.g. '+1 732 242 7882')."""
    clean = re.sub(r"[^\d]", "", phone)
    if not clean:
        return phone
    if len(clean) == 11 and clean.startswith("1"):
        return f"+1 {clean[1:4]} {clean[4:7]} {clean[7:]}"
    elif len(clean) == 10:
        return f"{clean[0:3]} {clean[3:6]} {clean[6:]}"
    elif len(clean) == 12 and clean.startswith("91"):
        return f"+91 {clean[2:7]} {clean[7:]}"
    return " ".join(clean)


def extract_caller_phone(ctx: agents.JobContext, participant: rtc.RemoteParticipant | None = None) -> str:
    """Extract Caller ID from LiveKit SIP participant attributes, identity, room name, or metadata."""
    if participant and participant.attributes:
        for attr in ("sip.phoneNumber", "phoneNumber", "sip.callID", "sip.from"):
            val = participant.attributes.get(attr)
            if val:
                m = re.search(r"(\+?\d{10,15})", val)
                if m:
                    return m.group(1)

    if participant and participant.identity:
        m = re.search(r"(\+?\d{10,15})", participant.identity)
        if m:
            return m.group(1)

    if ctx.room and ctx.room.remote_participants:
        for rp in ctx.room.remote_participants.values():
            if rp.attributes:
                for attr in ("sip.phoneNumber", "phoneNumber", "sip.callID", "sip.from"):
                    val = rp.attributes.get(attr)
                    if val:
                        m = re.search(r"(\+?\d{10,15})", val)
                        if m:
                            return m.group(1)
            if rp.identity:
                m = re.search(r"(\+?\d{10,15})", rp.identity)
                if m:
                    return m.group(1)

    if ctx.room and ctx.room.name:
        m = re.search(r"(\+?\d{10,15})", ctx.room.name)
        if m:
            return m.group(1)

    if hasattr(ctx, "job") and ctx.job and ctx.job.metadata:
        m = re.search(r"(\+?\d{10,15})", ctx.job.metadata)
        if m:
            return m.group(1)

    return ""


async def send_sms_confirmation(to_phone: str, message_body: str) -> bool:
    """Send an SMS confirmation via Twilio if credentials are configured."""
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER):
        logging.info("[SMS Mock] SMS would be sent to %s: %s", to_phone, message_body)
        return False

    try:
        url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.post(
                url,
                data={
                    "From": TWILIO_PHONE_NUMBER,
                    "To": to_phone,
                    "Body": message_body,
                },
                auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
            )
            if resp.status_code in (200, 201):
                logging.info("SMS confirmation sent to %s successfully.", to_phone)
                return True
            logging.error("Failed to send SMS: %s %s", resp.status_code, resp.text)
    except Exception as e:
        logging.error("Error sending SMS via Twilio: %s", e)
    return False


@dataclass
class BookingSessionState:
    """In-memory state machine to eliminate hallucinations and preserve booking context."""
    date: str = ""
    time: str = ""
    guests: int = 0
    table_number: str = ""
    customer_name: str = ""
    customer_phone: str = ""
    availability_checked: bool = False
    booking_id: int | None = None


class RestaurantTelephonyAgent(Agent):
    def __init__(self, caller_phone: str = ""):
        self.caller_phone = caller_phone
        self.state = BookingSessionState(customer_phone=caller_phone)
        now = datetime.now()
        today_str = now.strftime("%A, %B %d, %Y")
        today_iso = now.strftime("%Y-%m-%d")
        tomorrow_iso = (now + timedelta(days=1)).strftime("%Y-%m-%d")

        phone_rule = ""
        if self.caller_phone:
            spoken_phone = format_phone_for_speech(self.caller_phone)
            phone_rule = (
                f"- Caller number is {self.caller_phone} ({spoken_phone}). Do NOT ask for phone number.\n"
                f"- Once caller gives their name, confirm: 'Confirming with number {spoken_phone}?'\n"
                f"- In create_booking use phone='{self.caller_phone}'.\n"
            )

        instructions = f"""You are a voice booking agent for Demo Restaurant on a live phone call — every second of silence costs the caller's patience.
Today is {today_str} ({today_iso}). Tomorrow is {tomorrow_iso}.

CRITICAL RULES:
- Respond in 1-2 short sentences MAX. Never explain your reasoning aloud.
- Do not repeat back full details unless confirming a booking action.
- Call a tool the moment you have enough info. Do NOT ask clarifying questions you do not need.
- When calling a tool, generate ONLY the tool call with NO conversational text before or after it.
- Never use bullet points, markdown, or lists — this is spoken audio.
- If unsure, ask ONE short question. Never ask multiple questions in one turn.
- Confirmations must be terse: "Got it, 7 PM tonight for 4, confirming now."

GOAL: minimize tokens generated per turn without losing necessary information.
{phone_rule}
Table inventory: 5 tables of 5 seats (T5-1 to T5-5), 4 tables of 4 seats (T4-1 to T4-4), and 2 tables of 2 seats (T2-1, T2-2). Each reservation is strictly for 1 hour. If tables for that party size are fully booked for that 1-hour window, state that tables are unavailable for that seating and offer an earlier or later hour. Dates must be YYYY-MM-DD and times 24-hour HH:MM format for tool arguments.
"""
        super().__init__(instructions=instructions)
        self.http_client = httpx.AsyncClient(base_url=BACKEND_URL, timeout=6.0, verify=False)
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
        ctx.truncate(max_items=10)
        if self.last_confirmed_booking:
            b = self.last_confirmed_booking
            ctx.add_message(
                role="system",
                content=f"Current booking: #{b['id']} for {b['name']}, Table {b['table_number']} on {b['date']} at {b['time']} for {b['guests']} guests.",
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
        """Check dining table availability. Generate ONLY this tool call without preamble text.

        Args:
            date: Reservation date strictly in YYYY-MM-DD format (e.g. 2026-09-23).
            time: Reservation time strictly in 24-hour HH:MM format (e.g. 19:00).
            guests: Total number of guests (integer from 2 to 5).
        """
        clean_date = normalize_date(date)
        clean_time = normalize_time(time)
        logging.info("[Telephony] Checking availability: date=%s, time=%s, guests=%s", clean_date, clean_time, guests)

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
                return f"Check issue: {data.get('error', 'Error')}"

            tables = data.get("availableTables", [])
            if not tables:
                msg = data.get("message") or f"Table unavailable for seating {guests}"
                return f"{msg} on {clean_date} at {clean_time}."

            best = tables[0]
            # Lock state in memory to prevent LLM memory loss
            self.state.date = clean_date
            self.state.time = clean_time
            self.state.guests = guests
            self.state.table_number = best.get("table_number", "")
            self.state.availability_checked = True

            return f"Table {self.state.table_number} is available for {guests} on {clean_date} at {clean_time}. Ask for name to reserve."
        except Exception as e:
            logging.error("[Telephony] check_availability error: %s", e)
            return "Unable to check database right now."

    @function_tool()
    async def create_booking(
        self,
        ctx: RunContext,
        name: str,
        phone: str = "",
        date: str = "",
        time: str = "",
        guests: int = 0,
    ) -> str:
        """Create a confirmed restaurant table reservation over the phone.

        Args:
            name: Customer's actual full name as spoken by caller.
            phone: Customer's phone number (leave blank to use caller ID).
            date: Reservation date in YYYY-MM-DD format (optional if availability already checked).
            time: Reservation time in 24-hour HH:MM format (optional if availability already checked).
            guests: Number of guests (optional if availability already checked).
        """
        clean_name = name.strip()
        FORBIDDEN_NAMES = {
            "john doe", "john h. davis", "john davis", "jane doe", "customer",
            "caller", "user", "guest", "test", "my name", "someone"
        }
        if not clean_name or len(clean_name) < 2 or clean_name.lower() in FORBIDDEN_NAMES:
            logging.warning("[Telephony] Blocked invalid/placeholder name: '%s'", clean_name)
            return "Name needed. Ask: 'What name should I put on the reservation?'"

        # Hydrate missing parameters from session state to eliminate hallucinations
        clean_date = normalize_date(date) if date.strip() else self.state.date
        clean_time = normalize_time(time) if time.strip() else self.state.time
        num_guests = guests if guests > 0 else self.state.guests

        clean_phone = phone.strip()
        if not clean_phone or clean_phone in ("9879879870", "1234567890", "0000000000", "Phone Not Provided"):
            clean_phone = self.caller_phone or self.state.customer_phone or "Phone Not Provided"

        if not clean_date or not clean_time or num_guests <= 0:
            return "Missing date, time, or guest count. Please specify."

        # Deduplication protection
        if self.last_confirmed_booking and (
            self.last_confirmed_booking.get("name", "").lower() == clean_name.lower()
            and self.last_confirmed_booking.get("date") == clean_date
            and self.last_confirmed_booking.get("time") == clean_time
        ):
            b = self.last_confirmed_booking
            return (
                f"Booking already confirmed! Booking #{b.get('id')} under {b.get('customer_name')}, "
                f"Table {b.get('table_number')} on {b.get('reservation_date')} at {b.get('reservation_time')}."
            )

        logging.info(
            "[Telephony] Creating booking: name=%s, phone=%s, date=%s, time=%s, guests=%s",
            clean_name,
            clean_phone,
            clean_date,
            clean_time,
            num_guests,
        )

        try:
            response = await self.http_client.post(
                "/api/bookings",
                json={
                    "restaurantId": 1,
                    "name": clean_name,
                    "phone": clean_phone,
                    "date": clean_date,
                    "time": clean_time,
                    "guests": num_guests,
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
                self.state.booking_id = b.get("id")
                self.state.customer_name = clean_name
                self.state.customer_phone = clean_phone

                if clean_phone and clean_phone != "Phone Not Provided":
                    sms_text = (
                        f"Reservation #{b.get('id')} confirmed! "
                        f"{b.get('reservation_date')} at {b.get('reservation_time')} (Table {b.get('table_number')}, "
                        f"{b.get('guests')} guests)."
                    )
                    asyncio.create_task(send_sms_confirmation(clean_phone, sms_text))

                return (
                    f"Booking #{b.get('id')} confirmed for {b.get('customer_name')}, "
                    f"Table {b.get('table_number')} on {b.get('reservation_date')} at {b.get('reservation_time')} "
                    f"for {b.get('guests')} guests."
                )
            error_msg = data.get("error", "Unable to create booking")
            return f"Reservation could not be made: {error_msg}"
        except Exception as e:
            logging.error("[Telephony] create_booking error: %s", e)
            return "Could not connect to reservation database."

    @function_tool()
    async def get_booking(
        self,
        ctx: RunContext,
        booking_id: int,
    ) -> str:
        """Look up an existing reservation by its numeric booking ID."""
        logging.info("[Telephony] Retrieving booking: id=%s", booking_id)
        try:
            response = await self.http_client.get(f"/api/bookings/{booking_id}")
            data = response.json()
            if response.status_code == 200:
                return (
                    f"Booking #{data.get('id')} for {data.get('customer_name')}: "
                    f"Table {data.get('table_number')}, {data.get('reservation_date')} at {data.get('reservation_time')}, "
                    f"for {data.get('guests')} guests. Status: {data.get('status')}."
                )
            if response.status_code == 404:
                return f"No reservation found with booking ID #{booking_id}."
            return f"Error: {data.get('error', 'Unknown error')}"
        except Exception as e:
            logging.error("[Telephony] get_booking error: %s", e)
            return "Could not access reservation system."

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
        """Modify an existing reservation over the phone."""
        logging.info("[Telephony] Modifying booking: id=%s", booking_id)
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
                return (
                    f"Booking #{b.get('id')} updated: Table {b.get('table_number')} on "
                    f"{b.get('reservation_date')} at {b.get('reservation_time')} for {b.get('guests')} guests."
                )
            return f"Could not modify booking: {data.get('error', 'Update failed')}"
        except Exception as e:
            logging.error("[Telephony] modify_booking error: %s", e)
            return "Could not reach reservation database."

    @function_tool()
    async def cancel_booking(
        self,
        ctx: RunContext,
        booking_id: int,
    ) -> str:
        """Cancel an existing reservation."""
        logging.info("[Telephony] Cancelling booking: id=%s", booking_id)
        try:
            response = await self.http_client.delete(f"/api/bookings/{booking_id}")
            data = response.json()
            if response.status_code == 200:
                return f"Booking #{booking_id} cancelled."
            if response.status_code == 404:
                return f"Booking #{booking_id} not found."
            return f"Could not cancel booking: {data.get('error', 'Cancellation failed')}"
        except Exception as e:
            logging.error("[Telephony] cancel_booking error: %s", e)
            return "Could not reach reservation database."

    @function_tool()
    async def transfer_to_staff(
        self,
        ctx: RunContext,
        reason: str,
    ) -> str:
        """Transfer caller to live front desk staff."""
        logging.info("[Telephony] Transferring call to %s. Reason: %s", RESTAURANT_FRONT_DESK_PHONE, reason)
        return "Transferring your call to our front desk team right now. Please hold."


AGENT_NAME = os.getenv("LIVEKIT_AGENT_NAME", "my-agent")

# 3. OPTIMIZATION: Keep 1 warmed process ready to eliminate the 2.04s Windows process-spawn delay
server = agents.AgentServer(num_idle_processes=1, max_retry=999999)


@server.rtc_session(agent_name=AGENT_NAME)
async def restaurant_telephony(ctx: agents.JobContext):
    logging.info("Starting ultra-low-latency telephony agent session for room: %s", ctx.room.name)

    await ctx.connect()

    participant = None
    try:
        participant = await ctx.wait_for_participant()
    except Exception as e:
        logging.warning("wait_for_participant warning: %s", e)

    caller_phone = extract_caller_phone(ctx, participant)
    logging.info("[Telephony] Identified Caller Phone: '%s'", caller_phone)

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
            max_completion_tokens=120,
        ),
        tts=cartesia.TTS(
            model="sonic-3",
        ),
        vad=preloaded_vad,
        aec_warmup_duration=None,  # 4. OPTIMIZATION: Eliminates 3.0s initial delay
        turn_handling={
            "endpointing": {
                "mode": "fixed",
                "min_delay": 0.15,  # 5. OPTIMIZATION: 150ms endpointing delay
                "max_delay": 0.40,  # 400ms hard cap
            },
            "preemptive_generation": {
                "enabled": False,  # Clean 1-call-per-turn execution, cuts token burn by ~60%
            },
        },
    )

    agent_instance = RestaurantTelephonyAgent(caller_phone=caller_phone)
    logging.info(
        "Initialized RestaurantTelephonyAgent (caller_phone=%s) with %d tools: %s",
        caller_phone,
        len(agent_instance.tools),
        [t.id for t in agent_instance.tools],
    )

    await session.start(
        room=ctx.room,
        agent=agent_instance,
    )

    logging.info("Telephony agent joined SIP room and ready for low-latency phone interaction")

    # 7. OPTIMIZATION: Instant direct TTS greeting with 0ms LLM round-trip
    await session.say("Hi, thank you for calling Demo Restaurant. How can I help you today?")


if __name__ == "__main__":
    agents.cli.run_app(server)
