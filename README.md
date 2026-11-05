# WhatsApp Assistant Bot

An AI assistant for a WhatsApp Business number. People can message it directly or add it to groups. It **stores** things (notes, lists, numbers, decisions) and **notifies** people (one-off and recurring reminders), using an AI model to understand plain-language requests.

By default the AI is a **free, open model you run yourself** (through [Ollama](https://ollama.com)) on the same VPS, so there are no API keys and no per-message costs. Claude is available as an optional paid backend.

```
You:  @Assistant remember the office wifi is "Zeta-5G", password hunter2
Bot:  Saved ✅
You:  @Assistant remind us every weekday at 9:30 to post standup updates
Bot:  Done. I'll post "Post your standup updates" here Mon–Fri at 09:30 (PKT). First one: Thu 5 Nov.
...
Bot:  ⏰ *Reminder* for @Zaffer
      Post your standup updates
```

## How it works

```
WhatsApp ──► transport (Baileys or Cloud API) ──► per-chat queue ──► AI model + tools ──► reply
                                                                         │
                                         SQLite: notes, reminders, chat history
                                                                         │
                         scheduler (every 20s) ──► due reminders ──► transport ──► WhatsApp
```

- **The AI model** (local Ollama model by default, or Claude) gets a small set of tools: `save_note`, `search_notes`, `delete_note`, `create_reminder`, `list_reminders`, `cancel_reminder`. The model decides which to call; the bot runs them and the model writes the reply.
- **Storage** is a single SQLite file (`data/assistant.db`), using Node's built-in `node:sqlite`, so there is nothing to install.
- **Scoping:** notes and reminders belong to the chat they were made in. A group shares its notes; a direct chat's notes are private to that person.
- **Groups:** the bot only responds when it's @mentioned, when someone replies to one of its messages, or when a message starts with its name (or a `GROUP_TRIGGERS` word). It ignores everything else, and it doesn't store messages that aren't addressed to it.
- **Direct messages:** it responds to everything (restrict who can DM it with `ALLOWED_NUMBERS`).
- **Reminders** fire in the chat they were set in and tag the person who set them. Recurring reminders keep their local wall-clock time across daylight-saving changes. If the bot was offline, missed reminders are sent late with a note.
- Send `/reset` in a chat to clear the bot's conversation context (saved notes and reminders are kept).

## Choosing the AI model

| `LLM_PROVIDER` | Cost | Quality | Needs |
|---|---|---|---|
| `ollama` (default) | Free software; you only pay for the VPS | Good for notes and simple reminders; can misread tricky times or long group conversations | A VPS with enough RAM (below) |
| `claude` | Paid per message | Best at understanding messy requests | `ANTHROPIC_API_KEY` |

**Which local model?** Pick one that fits your VPS's RAM, set it as `OLLAMA_MODEL`. All three support tool calling, which the bot needs. Speeds are rough estimates for a CPU-only VPS, not measured with this bot:

| VPS RAM | `OLLAMA_MODEL` | Download | Reply time (4 vCPU, no GPU) |
|---|---|---|---|
| 4 GB | `qwen3:1.7b` | ~1.4 GB | a few seconds; makes more mistakes |
| 8 GB | `qwen3:4b` (default) | ~2.5 GB | ~5–20 s |
| 16 GB | `qwen3:8b` | ~5 GB | ~15–40 s; most reliable |

Tips:
- Free VPS option: Oracle Cloud's Always Free tier includes ARM servers with up to 24 GB RAM, which can run `qwen3:8b`. Ollama supports ARM.
- `OLLAMA_THINK=true` turns on the model's step-by-step reasoning. It's smarter at working out dates, but several times slower on a CPU.
- To make the bot easier for a small model, `create_reminder` accepts "in N minutes" directly, and each message shows the current local date, weekday and time.

## Choosing a WhatsApp transport

| | `baileys` (default) | `cloud` |
|---|---|---|
| What it is | Links to your existing WhatsApp / WhatsApp Business **app** account as a linked device (like WhatsApp Web) | Meta's official **WhatsApp Business Cloud API** |
| Can be added to groups | ✅ Yes, like any member | ❌ No (Cloud API numbers can't join normal groups) |
| Direct messages | ✅ | ✅ |
| Reminders any time | ✅ | Only within 24h of the user's last message, unless you set an approved template (`WA_REMINDER_TEMPLATE`) |
| Setup | Scan a QR code | Meta developer app, webhook, public HTTPS URL |
| Risk | Unofficial; against WhatsApp's terms, so the number **can be banned**. Use a number you can afford to lose and don't send bulk or unsolicited messages | Officially supported; per-conversation pricing from Meta |

Since you want the bot in groups, `baileys` is the default. If you'd rather stay fully official, use `cloud` and accept DMs only.

## Setup

The easiest way is Docker Compose, which runs the bot and Ollama together (see [Running in production](#running-in-production)). To run it directly instead, you need Node.js 22.13+ and [Ollama](https://ollama.com/download):

```bash
ollama pull qwen3:4b
npm install
cp .env.example .env        # then set TIMEZONE, BOT_NAME, OLLAMA_MODEL
npm run dev                 # or: npm run build && npm start
```

To use Claude instead, set `LLM_PROVIDER=claude` and `ANTHROPIC_API_KEY` in `.env`.

### Baileys (groups + DMs)

1. Keep the WhatsApp Business app installed on the phone that owns the number.
2. Run the bot. A QR code appears in the terminal.
3. On the phone: **WhatsApp Business → Settings → Linked devices → Link a device**, then scan it.
   On a headless server, set `WA_PAIRING_NUMBER` to the bot's number instead: the bot prints an 8-character code to enter under **Link with phone number**.
4. The session is saved in `data/baileys-auth/`, so you only link once. Keep that folder private: it's a login.
5. Add the number to groups as usual.

### Cloud API (official, DMs only)

1. Create an app at [developers.facebook.com](https://developers.facebook.com/), add the **WhatsApp** product and register your business number.
2. Set `WA_TRANSPORT=cloud`, plus `WA_ACCESS_TOKEN` (a permanent system-user token), `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET` and any `WA_VERIFY_TOKEN` you choose.
3. Deploy somewhere with a public HTTPS URL and set the webhook to `https://your-host/webhook` with the same verify token. Subscribe to the `messages` field.
4. For reminders sent more than 24h after someone last wrote, create a utility template with one body variable (e.g. `Reminder: {{1}}`) and set `WA_REMINDER_TEMPLATE` to its name.

## Running in production

On a Linux VPS with [Docker](https://docs.docker.com/engine/install/) installed:

```bash
git clone https://github.com/ZafferAbbas/ZafferAbbas.github.io.git wa-assistant
cd wa-assistant
cp .env.example .env          # set TIMEZONE, BOT_NAME, OLLAMA_MODEL
docker compose up -d          # first start downloads the model (a few GB)
docker compose logs -f bot    # scan the QR code on first run (baileys)
```

[`docker-compose.yml`](docker-compose.yml) starts Ollama, downloads `OLLAMA_MODEL` once, then starts the bot. Using Claude instead? Run just the bot: `docker build -t wa-assistant . && docker run -d --env-file .env -v wa-data:/data -p 3000:3000 wa-assistant`.

Run **one** instance only: the scheduler and the WhatsApp session both assume a single process. Back up the `data` volume; it holds every note, reminder and the WhatsApp login.

This repository used to be a GitHub Pages site. If GitHub Pages is still enabled for it, turn it off under **Settings → Pages**; the bot is a Node.js service and needs a host such as a VPS, Railway, Fly.io or Render, not Pages.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example). The ones you'll most likely change:

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` (free, self-hosted) or `claude` (paid) |
| `OLLAMA_MODEL` | `qwen3:4b` | Local model; see the table above |
| `ANTHROPIC_API_KEY` | | Only for `LLM_PROVIDER=claude` |
| `BOT_NAME` | `Assistant` | Name the bot uses; starting a group message with it addresses the bot |
| `TIMEZONE` | system zone | IANA zone for reading and sending reminder times, e.g. `Asia/Karachi` |
| `WA_TRANSPORT` | `baileys` | `baileys` or `cloud` |
| `ALLOWED_NUMBERS` | (anyone) | Restrict who can DM the bot |

## Development

```bash
npm run typecheck
npm test
```

Code layout:

- `src/index.ts`: wiring, per-chat queue, error replies
- `src/agent.ts`: picks the AI backend, builds each turn
- `src/tools.ts`: system prompt and the notes/reminders tools
- `src/llm/`: `ollama.ts` (local model), `claude.ts` (optional)
- `src/db.ts`: SQLite store
- `src/scheduler.ts`: sends due reminders
- `src/time.ts`: time zones and recurrence
- `src/transports/`: `baileys.ts`, `cloud.ts`
