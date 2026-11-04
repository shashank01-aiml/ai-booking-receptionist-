# AI Booking Receptionist — Codebase Analysis

## Project Overview

A full-stack AI-powered restaurant booking system with three components: a **voice agent** that takes reservations over a phone call, an **Express backend** that manages the database, and a **React dashboard** for staff to monitor bookings in real time.

## Architecture

```
┌─────────────┐      WebSocket/RTC       ┌──────────────┐
│  Caller      │ ◄──────────────────────► │  Voice Agent │
│  (Phone)     │                          │  (LiveKit)   │
└─────────────┘                           └──────┬───────┘
                                                 │ HTTP (REST API)
┌─────────────┐       REST API            ┌──────▼───────┐
│  Frontend    │ ◄──────────────────────► │   Backend    │
│  (React)     │   GET/POST/PATCH/DELETE  │  (Express)   │
└─────────────┘                           └──────┬───────┘
                                                 │
                                          ┌──────▼───────┐
                                          │   SQLite DB  │
                                          │  (booking.db)│
                                          └──────────────┘
```

## Component Breakdown

### 1. Voice Agent (`voice-agent/agent.py`)

| Item       | Detail                                                    |
|------------|-----------------------------------------------------------|
| Runtime    | Python, LiveKit Agents SDK 1.8                            |
| LLM        | Groq-hosted `openai/gpt-oss-120b` via `livekit-plugins-groq`|
| STT / TTS  | Deepgram / Cartesia                                       |
| VAD        | Silero (voice activity detection)                         |
| Agent name | `restaurant-receptionist`                                 |
| Status     | **Operational** — equipped with 5 tools to manage bookings |

**Function Tools:** `check_availability`, `create_booking`, `get_booking`, `modify_booking`, and `cancel_booking`. All tools call the Express REST API asynchronously via `httpx`.

### 2. Backend (`backend/src/server.ts`)

Express 5 + TypeScript server on port 5000 with `better-sqlite3`.

**Database schema** — 3 tables with foreign keys enforced:
- `restaurants` (id, name, address, phone)
- `dining_tables` (id, restaurant_id, table_number, capacity)
- `bookings` (id, restaurant_id, table_id, customer_name, phone, date, time, guests, status)

**REST API endpoints:**

| Method   | Route                        | Purpose                    |
|----------|------------------------------|----------------------------|
| `GET`    | `/api/restaurants`           | List all restaurants       |
| `GET`    | `/api/tables`                | List tables for restaurant |
| `GET`    | `/api/bookings/availability` | Check slot availability    |
| `POST`   | `/api/bookings`              | Create a booking           |
| `GET`    | `/api/bookings`              | List all bookings          |
| `GET`    | `/api/bookings/:id`          | Get booking by ID          |
| `PATCH`  | `/api/bookings/:id`          | Modify a booking           |
| `DELETE` | `/api/bookings/:id`          | Cancel a booking (soft)    |

Auto-seeds a "Demo Restaurant" with 5 tables (T1-T5, capacities 2-6). Includes conflict detection and automatic best-fit table assignment.

### 3. Frontend (`frontend/src/App.tsx`)

React 19 + Vite single-page app. Polls `localhost:5000` every 2 seconds.

**Dashboard panels:**
1. **Live Overview** — metric cards + visual table layout (available / reserved / arrived).
2. **Agent Bookings** — searchable list of all bookings (filters by ID, name, phone, table).
3. **Booking Details** — selected booking info, table reassignment, and "Mark Arrived" action.
