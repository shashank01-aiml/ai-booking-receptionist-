# LiveKit SIP Telephony Setup Guide

This guide explains how to connect a real telephone number (from Twilio, Telnyx, or standard SIP carrier) to the `restaurant-telephony` voice agent so callers can dial a phone number and talk to the AI receptionist.

---

## Architecture Overview

```
┌─────────────────┐       PSTN Phone Call      ┌────────────────────────┐
│  Caller's Phone │ ─────────────────────────► │ Telecom Carrier        │
└─────────────────┘                            │ (Twilio / Telnyx)      │
                                               └───────────┬────────────┘
                                                           │ SIP Trunk (INVITE)
                                               ┌───────────▼────────────┐
                                               │ LiveKit SIP Gateway    │
                                               │ (cloud.livekit.io)     │
                                               └───────────┬────────────┘
                                                           │ RoomAgentDispatch
                                               ┌───────────▼────────────┐
                                               │ Telephony Agent Worker │
                                               │ (restaurant-telephony) │
                                               └────────────────────────┘
```

---

## Step 1: Get a Phone Number from a Telecom Carrier

### Option A: Using Twilio
1. Log into your [Twilio Console](https://console.twilio.com/).
2. Buy or select a phone number (e.g., `+1 555 123 4567`).
3. Under **Voice & Fax**, set **Configure with** to **SIP Trunking** or **SIP Originating**.

### Option B: Using Telnyx
1. Log into your [Telnyx Portal](https://portal.telnyx.com/).
2. Purchase a phone number.
3. Assign it to a new SIP Connection pointed to your LiveKit SIP URI.

---

## Step 2: Configure LiveKit Inbound SIP Trunk

You can configure the SIP trunk in the **LiveKit Cloud Dashboard** or via the **LiveKit CLI (`lk`)**.

### Using the LiveKit Cloud Dashboard (Recommended)
1. Go to [cloud.livekit.io](https://cloud.livekit.io) and select your project (`p_3r3ktiygc57`).
2. Navigate to **Telephony** (or **SIP**) in the left navigation sidebar.
3. Click **Create Inbound Trunk**.
4. Configure the trunk:
   - **Trunk Name**: `Demo Restaurant Inbound Trunk`
   - **Phone Numbers**: Add your carrier phone number (in E.164 format, e.g. `+15551234567`).
   - **Authentication**: Choose IP-based or User/Password authentication depending on your carrier.
5. Save the trunk. Note the **SIP URI** provided by LiveKit (e.g. `your-project.sip.livekit.cloud`).
6. Point your Twilio/Telnyx SIP trunk to that LiveKit SIP URI.

---

## Step 3: Create a SIP Dispatch Rule

The dispatch rule tells LiveKit to automatically launch the `restaurant-telephony` agent when a telephone call arrives on that trunk.

In **LiveKit Cloud Dashboard** > **Telephony** > **Dispatch Rules**:
1. Click **Create Dispatch Rule**.
2. Select **Inbound Trunk**: Choose the trunk created in Step 2.
3. Set **Room Prefix**: `sip-call-`
4. Under **Agent Dispatch**:
   - Enable **Dispatch Agent to Room**.
   - **Agent Name**: `restaurant-telephony`
   - **Deployment**: `production`
5. Click **Save**.

### Or via LiveKit CLI (`lk`):
```json
{
  "name": "restaurant-telephony-dispatch",
  "trunk_ids": ["ST_YOUR_TRUNK_ID"],
  "rule": {
    "dispatch_rule_individual": {
      "room_prefix": "sip-call-",
      "room_agent_dispatch": {
        "agent_name": "restaurant-telephony"
      }
    }
  }
}
```
Run:
```bash
lk sip dispatch-rule create sip_dispatch.json
```

---

## Step 4: Run the Telephony Agent

Start the telephony agent worker:

```powershell
cd telephony-agent
& "..\voice-agent\.venv\Scripts\python.exe" agent.py dev
```

You will see:
```
INFO livekit.agents - registered worker {"agent_name": "restaurant-telephony", "deployment": "production"}
```

---

## Step 5: Test Inbound Phone Calls

1. Call your restaurant telephone number from any mobile or landline phone.
2. The LiveKit SIP Gateway will:
   - Accept the call.
   - Create a room named `sip-call-<callID>`.
   - Dispatch the `restaurant-telephony` agent into the room.
3. The agent will:
   - Automatically extract your caller ID (`sip.phoneNumber`).
   - Greet you: *"Thanks for calling Demo Restaurant! I see you are calling from a number ending in 1234. How may I help you today?"*
   - Check table availability and book your reservation.
   - Dispatch a confirmation SMS (if Twilio credentials are configured in `.env`).
