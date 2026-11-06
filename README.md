# WhatsApp Assistant Bot

An AI assistant for a WhatsApp Business number, using Meta's official WhatsApp Business Cloud API. People message it directly. It **stores** things (notes, lists, numbers, decisions) and **notifies** people (one-off and recurring reminders), using an AI model to understand plain-language requests.

By default the AI is a **free, open model you run yourself** (through [Ollama](https://ollama.com)) on the same VPS, so there are no API keys and no per-message costs. Claude is available as an optional paid backend.

```
You:  remember the office wifi is "Zeta-5G", password hunter2
Bot:  Saved ✅
You:  remind me every weekday at 9:30 to post standup updates
Bot:  Done. I'll remind you Mon–Fri at 09:30 (PKT). First one: Fri 6 Nov.
...
Bot:  ⏰ *Reminder*
      Post your standup updates
```

## How it works

```
WhatsApp ──► Cloud API webhook ──► per-chat queue ──► AI model + tools ──► reply
                                                                         │
                                         SQLite: notes, reminders, chat history
                                                                         │
                         scheduler (every 20s) ──► due reminders ──► transport ──► WhatsApp
```

- **The AI model** (local Ollama model by default, or Claude) gets a small set of tools: `save_note`, `search_notes`, `delete_note`, `create_reminder`, `list_reminders`, `cancel_reminder`. The model decides which to call; the bot runs them and the model writes the reply.
- **Storage** is a single SQLite file (`data/assistant.db`), using Node's built-in `node:sqlite`, so there is nothing to install.
- **Scoping:** each person's notes and reminders are private to their own chat.
- **Who can use it:** anyone who messages the number, unless you restrict it with `ALLOWED_NUMBERS`.
- **Reminders** are sent back to the person who set them. See [The 24-hour rule](#the-24-hour-rule) for what that needs. Recurring reminders keep their local wall-clock time across daylight-saving changes. If the bot was offline, missed reminders are sent late with a note.
- Send `/reset` in a chat to clear the bot's conversation context (saved notes and reminders are kept).

## Choosing the AI model

| `LLM_PROVIDER` | Cost | Quality | Needs |
|---|---|---|---|
| `ollama` (default) | Free software; you only pay for the VPS | Good for notes and simple reminders; can misread tricky times or long conversations | A VPS with enough RAM (below) |
| `claude` | Paid per message | Best at understanding messy requests | `ANTHROPIC_API_KEY` |

**Which local model?** Pick one that fits your VPS's RAM, set it as `OLLAMA_MODEL`. All three support tool calling, which the bot needs. Speeds are rough estimates for a CPU-only VPS, not measured with this bot:

| VPS RAM | `OLLAMA_MODEL` | Download | Reply time (4 vCPU, no GPU) |
|---|---|---|---|
| 4 GB | `qwen3:1.7b` | ~1.4 GB | a few seconds; makes more mistakes |
| 8 GB | `qwen3:4b` (default) | ~2.5 GB | ~5–20 s |
| 16 GB | `qwen3:8b` | ~5 GB | ~15–40 s; most reliable |

Tips:
- Free VPS option: Oracle Cloud's Always Free tier includes an ARM server, cut in mid-2026 from 24 GB to 12 GB RAM and 2 CPU cores. That still fits `qwen3:8b`, but replies will be slow. Ollama supports ARM.
- `OLLAMA_THINK=true` turns on the model's step-by-step reasoning. It's smarter at working out dates, but several times slower on a CPU.
- To make the bot easier for a small model, `create_reminder` accepts "in N minutes" directly, and each message shows the current local date, weekday and time.

## The 24-hour rule

WhatsApp only lets a business send free-form messages to someone within **24 hours of their last message**. After that, it may only send pre-approved **template** messages.

- A reminder due within 24 hours of the person's last message is sent as a normal message.
- A reminder due later is sent through your reminder template (`WA_REMINDER_TEMPLATE`), for example "Reminder: {{1}}". Without a template, those reminders can't be delivered: the bot warns the person when they set one, and skips it when it's due.
- The bot keeps track of each person's last message in its database, so this works across restarts.

## Costs

Prices are set by Meta and change; check [Meta's pricing page](https://developers.facebook.com/docs/whatsapp/pricing) for your country. As of late 2026:

- **Replies to someone who messaged in the last 24 hours:** the first 1,000 per month per number are free, then charged.
- **Template messages** (reminders outside the 24-hour window): charged per message, roughly $0.003 each in the US; it varies by country.

## Groups

The official API can't join ordinary WhatsApp groups. Meta's Groups API exists, but only for verified Official Business Accounts, the business must create the group itself, people join by invite link, and groups are limited to 8 members. This bot doesn't use it.

If you need groups, the bot also has an unofficial linked-device mode (`WA_TRANSPORT=baileys`) that joins groups like a normal member by scanning a QR code. It's against WhatsApp's terms, so the number can be banned. See [`.env.example`](.env.example).

## Setup

You need a VPS with Docker, a domain or subdomain (for HTTPS), and a phone number for the bot.

### 1. Meta (WhatsApp Cloud API)

1. Go to [developers.facebook.com](https://developers.facebook.com/), create an app of type **Business**, and add the **WhatsApp** product.
2. Under **WhatsApp → API Setup**, add your business phone number and verify it. A number used with the API normally can't stay in the WhatsApp Business app at the same time.
3. Create a permanent access token: in [Meta Business Settings](https://business.facebook.com/settings) → **System users**, add a system user, assign it your app and WhatsApp account, and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management` permissions. This is `WA_ACCESS_TOKEN`.
4. Copy the **Phone number ID** (WhatsApp → API Setup) into `WA_PHONE_NUMBER_ID`, and the **App secret** (App settings → Basic) into `WA_APP_SECRET`.
5. Create the reminder template under **WhatsApp Manager → Message templates**: category **Utility**, name `reminder`, body `Reminder: {{1}}`. Approval usually takes minutes to a day.

### 2. Server

1. Point your domain (e.g. `bot.yourdomain.com`) at the VPS with a DNS **A record**.
2. On the VPS, with [Docker](https://docs.docker.com/engine/install/) installed:

   ```bash
   git clone https://github.com/ZafferAbbas/ZafferAbbas.github.io.git wa-assistant
   cd wa-assistant
   cp .env.example .env    # fill in DOMAIN, the WA_* values, TIMEZONE, BOT_NAME, OLLAMA_MODEL
   docker compose up -d    # first start downloads the model (a few GB)
   docker compose logs -f bot
   ```

   [`docker-compose.yml`](docker-compose.yml) starts Caddy (which gets a free HTTPS certificate for `DOMAIN`), Ollama, downloads `OLLAMA_MODEL` once, then starts the bot.

### 3. Connect the webhook

1. In your Meta app: **WhatsApp → Configuration → Webhook → Edit**.
2. Callback URL: `https://bot.yourdomain.com/webhook`. Verify token: the `WA_VERIFY_TOKEN` from your `.env`.
3. Click **Verify and save**, then under **Webhook fields** subscribe to **messages**.
4. Send the number a WhatsApp message. The bot should answer.

Using Claude instead of a local model? Set `LLM_PROVIDER=claude` and `ANTHROPIC_API_KEY` in `.env`; Ollama is then unused.

Run **one** instance only: the reminder scheduler assumes a single process. Back up the `data` volume; it holds every note and reminder.

This repository used to be a GitHub Pages site. If GitHub Pages is still enabled for it, turn it off under **Settings → Pages**.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example). The ones you'll most likely change:

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` (free, self-hosted) or `claude` (paid) |
| `OLLAMA_MODEL` | `qwen3:4b` | Local model; see the table above |
| `ANTHROPIC_API_KEY` | | Only for `LLM_PROVIDER=claude` |
| `BOT_NAME` | `Assistant` | Name the bot uses for itself |
| `TIMEZONE` | system zone | IANA zone for reading and sending reminder times, e.g. `Asia/Karachi` |
| `DOMAIN` | | Domain for HTTPS; the webhook is `https://DOMAIN/webhook` |
| `WA_REMINDER_TEMPLATE` | | Approved template for reminders outside the 24-hour window |
| `WA_TRANSPORT` | `cloud` | `cloud` (official) or `baileys` (unofficial, supports groups) |
| `ALLOWED_NUMBERS` | (anyone) | Restrict who can message the bot |

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev     # needs .env and a running Ollama (ollama pull qwen3:4b)
```

Code layout:

- `src/index.ts`: wiring, per-chat queue, error replies
- `src/agent.ts`: picks the AI backend, builds each turn
- `src/tools.ts`: system prompt and the notes/reminders tools
- `src/llm/`: `ollama.ts` (local model), `claude.ts` (optional)
- `src/db.ts`: SQLite store
- `src/scheduler.ts`: sends due reminders
- `src/time.ts`: time zones and recurrence
- `src/transports/`: `cloud.ts` (official API), `baileys.ts` (unofficial)
