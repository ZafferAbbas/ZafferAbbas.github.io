# WhatsApp Assistant Bot

An AI assistant for a WhatsApp Business number. People can message it directly or add it to groups. It **stores** things (notes, lists, numbers, decisions) and **notifies** people (one-off and recurring reminders), using Claude to understand plain-language requests.

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
WhatsApp ──► transport (Baileys or Cloud API) ──► per-chat queue ──► Claude + tools ──► reply
                                                                         │
                                         SQLite: notes, reminders, chat history
                                                                         │
                         scheduler (every 20s) ──► due reminders ──► transport ──► WhatsApp
```

- **Claude** (`claude-opus-5-5` by default) gets a small set of tools: `save_note`, `search_notes`, `delete_note`, `create_reminder`, `list_reminders`, `cancel_reminder`. The SDK tool runner handles the tool loop.
- **Storage** is a single SQLite file (`data/assistant.db`), using Node's built-in `node:sqlite`, so there is nothing to install.
- **Scoping:** notes and reminders belong to the chat they were made in. A group shares its notes; a direct chat's notes are private to that person.
- **Groups:** the bot only responds when it's @mentioned, when someone replies to one of its messages, or when a message starts with its name (or a `GROUP_TRIGGERS` word). It ignores everything else, and it doesn't store messages that aren't addressed to it.
- **Direct messages:** it responds to everything (restrict who can DM it with `ALLOWED_NUMBERS`).
- **Reminders** fire in the chat they were set in and tag the person who set them. Recurring reminders keep their local wall-clock time across daylight-saving changes. If the bot was offline, missed reminders are sent late with a note.
- Send `/reset` in a chat to clear the bot's conversation context (saved notes and reminders are kept).

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

Requires Node.js 22.13+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
cp .env.example .env        # then fill in ANTHROPIC_API_KEY, TIMEZONE, BOT_NAME
npm run dev                 # or: npm run build && npm start
```

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

```bash
docker build -t wa-assistant .
docker run -d --name wa-assistant --env-file .env -v wa-data:/data -p 3000:3000 wa-assistant
docker logs -f wa-assistant   # scan the QR code on first run (baileys)
```

Run **one** instance only: the scheduler and the WhatsApp session both assume a single process. Back up the `/data` volume; it holds every note, reminder and the WhatsApp login.

This repository used to be a GitHub Pages site. If GitHub Pages is still enabled for it, turn it off under **Settings → Pages**; the bot is a Node.js service and needs a host such as a VPS, Railway, Fly.io or Render, not Pages.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example). The ones you'll most likely change:

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
| `BOT_NAME` | `Assistant` | Name the bot uses; starting a group message with it addresses the bot |
| `TIMEZONE` | system zone | IANA zone for reading and sending reminder times, e.g. `Asia/Karachi` |
| `WA_TRANSPORT` | `baileys` | `baileys` or `cloud` |
| `CLAUDE_EFFORT` | `medium` | `low` is faster and cheaper; `high` thinks harder |
| `ALLOWED_NUMBERS` | (anyone) | Restrict who can DM the bot |

## Development

```bash
npm run typecheck
npm test
```

Code layout:

- `src/index.ts`: wiring, per-chat queue, error replies
- `src/agent.ts`: system prompt, tools, Claude call
- `src/db.ts`: SQLite store
- `src/scheduler.ts`: sends due reminders
- `src/time.ts`: time zones and recurrence
- `src/transports/`: `baileys.ts`, `cloud.ts`
