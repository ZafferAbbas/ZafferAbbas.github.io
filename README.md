# WhatsApp Assistant Bot

An AI assistant for a WhatsApp Business number, using Meta's official WhatsApp Business Cloud API. Staff message it directly to:

- **Create purchase orders** by text, or a photo or PDF of a handwritten or printed order. Managers approve them on WhatsApp, and approved orders go into **Odoo** and your **custom ERP**.
- **Get a copy** of any purchase order as a PDF.
- **Store** notes and **set reminders**, one-off or recurring.

Claude reads text, photos and PDFs. Voice notes are **off by default** (they need an extra speech-to-text server); see [Voice notes](#voice-notes-optional).

```
Ali:  [photo of a handwritten list] PO for Al-Noor please
Bot:  Al-Noor Traders:
      - 10 box A4 Paper 80gsm @ PKR 950.00
      - 4 pack Blue pens (50) @ PKR 1,200.00
      Total PKR 14,300.00. Shall I send it for approval?
Ali:  yes
Bot:  Created PO-00012 and sent it to the managers for approval.

Sara (manager) gets:  🧾 Approval needed: PO-00012 …   [Approve] [Reject]
Sara taps Approve →   Approved PO-00012. Odoo: P00042, ERP: 8812
Ali gets:             ✅ PO-00012 was approved by Sara

Ali:  send me PO-00012
Bot:  [PO-00012.pdf]

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
WhatsApp ──► Cloud API webhook ──► per-chat queue ──► Claude + tools ──► reply
                                                 │
                          SQLite: purchase orders, notes, reminders
                                                 │
                     manager approves ──► Odoo (create + confirm) + custom ERP (signed JSON)
```

- **The AI model** (Claude, or a local Ollama model) gets tools for purchase orders (`find_suppliers`, `find_products`, `create_purchase_order`, `send_purchase_order_pdf`, …), notes and reminders. The model decides which to call; the bot runs them and the model writes the reply. Approve/Reject button taps are handled directly, without the AI.
- **Storage** is a single SQLite file (`data/assistant.db`), using Node's built-in `node:sqlite`, so there is nothing to install.
- **Scoping:** each person's notes and reminders are private to their own chat.
- **Who can use it:** anyone who messages the number, unless you restrict it with `ALLOWED_NUMBERS`.
- **Reminders** are sent back to the person who set them. See [The 24-hour rule](#the-24-hour-rule) for what that needs. Recurring reminders keep their local wall-clock time across daylight-saving changes. If the bot was offline, missed reminders are sent late with a note.
- Send `/reset` in a chat to clear the bot's conversation context (saved notes and reminders are kept).

## Purchase orders

**Who can do what** (by phone number, digits only, in `.env`):

| | Create, list, cancel own POs, get PDFs | Approve / reject, see everyone's POs, retry ERP sync |
|---|---|---|
| `STAFF_NUMBERS` (empty = everyone allowed to use the bot) | ✅ | |
| `MANAGER_NUMBERS` (required to turn purchase orders on) | ✅ | ✅ |

**The flow**

1. Staff send a request: text, or a **photo** or **PDF** of an order (or a voice note, if [turned on](#voice-notes-optional)). The bot reads the supplier and items, looks them up in Odoo (`find_suppliers`, `find_products`), asks about anything unclear, shows a summary and asks them to confirm.
2. It creates the purchase order (`PO-00012`, status *pending*) and sends every manager the summary with **Approve** and **Reject** buttons. A manager doesn't approve their own orders unless `PO_ALLOW_SELF_APPROVAL=true`.
3. The first manager to tap decides. Managers can also type "reject PO-00012, too expensive" to give a reason.
4. On approval, the order is created in **Odoo** (as a purchase order, confirmed unless `ODOO_CONFIRM=false`) and sent to your **custom ERP**. The requester is told, with the Odoo and ERP references.
5. If an ERP is down, the order is kept as *sync failed* and managers can ask the bot to "retry PO-00012". Retrying never creates a duplicate in Odoo.

Anyone involved can ask for a PO as a **PDF** ("send me PO-00012"). Products and vendors must exist in Odoo; the bot doesn't create new ones.

### Odoo

1. Create an Odoo user for the bot with **Purchase: User** access. If Odoo's own **Purchase Order Approval** setting is on, orders above its limit will also wait for approval inside Odoo, unless the bot user is a Purchase Administrator.
2. Log in as that user → **Preferences → Account Security → New API Key**. Put it in `ODOO_API_KEY`, and set `ODOO_URL` and `ODOO_DB`.
3. **Odoo 19 or later:** leave `ODOO_API=json2` (the new External JSON-2 API). **Odoo 18 or earlier:** set `ODOO_API=jsonrpc` and `ODOO_LOGIN` to the bot user's login.

The bot creates a `purchase.order` with origin `WhatsApp PO-00012`, one line per item (Odoo fills in prices from the vendor's price list when staff didn't give one), then calls `button_confirm`.

### Custom ERP

Set `CUSTOM_ERP_URL` and `CUSTOM_ERP_SECRET`. For each approved order the bot sends:

```http
POST <CUSTOM_ERP_URL>
Content-Type: application/json
X-Signature-256: sha256=<hex HMAC-SHA256 of the raw body, keyed with CUSTOM_ERP_SECRET>
Idempotency-Key: PO-00012
```

```json
{
  "event": "purchase_order.approved",
  "number": "PO-00012",
  "status": "approved",
  "created_at": "2026-11-17T06:27:00.000Z",
  "approved_at": "2026-11-17T06:40:00.000Z",
  "approved_by": "Sara",
  "requested_by": { "id": "923001111111", "name": "Ali" },
  "supplier": { "name": "Al-Noor Traders", "odoo_id": 7 },
  "notes": "Deliver to warehouse 2",
  "items": [
    { "description": "A4 Paper 80gsm", "quantity": 10, "unit": "box", "unit_price": 950, "product_code": "PAP-A4", "odoo_product_id": 41 }
  ],
  "erp_refs": { "odoo": "P00042" }
}
```

Your ERP should check the signature, save the order, and answer `2xx`, optionally with `{"reference": "8812"}` (shown to staff). It may receive the same order again after a retry, so use `Idempotency-Key` to ignore duplicates. Odoo is sent first, so `erp_refs.odoo` lets you link the two.

### Voice notes (optional)

Off by default. Without it, a staff member who sends a voice note is asked (in Roman Urdu and English) to type it or send a photo instead.

Claude can't listen to audio, so voice notes need a Whisper speech-to-text server ([speaches](https://github.com/speaches-ai/speaches)). It runs on the same VPS, but needs about 3 GB more RAM. To turn it on: set `STT_URL=http://stt:8000` in `.env` and start with `docker compose --profile voice up -d`. Voice notes are then turned into text on your own server and handled like a typed message.

- **Model:** `large-v3-turbo` by default (`STT_MODEL`). It's much better at Urdu and Farsi than the small Whisper models, needs about 2–3 GB of RAM, and downloads (~1.6 GB) on the first voice note, so that one is slow.
- **Languages:** detected automatically. Farsi works well, Urdu fairly well, Sindhi poorly (Whisper has very little Sindhi training data); English and mixed Urdu-English are fine. To force one language for everyone, set `STT_LANGUAGE`, e.g. `ur`.
- **Urdu heard as Hindi:** spoken Urdu and Hindi sound almost the same, so Whisper often picks Hindi and writes Devanagari script. When that happens the bot transcribes the note again as Urdu (`STT_LANGUAGE_REMAP=hi:ur`; set it to `none` to turn this off).
- A wrong transcript usually isn't fatal: Claude reads the transcript, asks about anything unclear, and matches items against Odoo before creating a purchase order.

## Languages

- **Replies:** in the language the person uses. Anyone using Urdu, whether in Urdu script, Roman Urdu or Hindi script (which voice typing often produces), gets replies in **Roman Urdu**. To use one language for everyone, set `REPLY_LANGUAGE`, e.g. `English` or `Roman Urdu`.
- **PDFs:** Urdu, Sindhi, Farsi and Arabic print correctly, right to left, using the bundled Noto Naskh Arabic font ([`assets/fonts`](assets/fonts), SIL Open Font License). Numbers and English words inside them keep their left-to-right order.
- **Purchase-order items** use the product and supplier names from Odoo, so orders stay consistent whatever language staff speak.
- A few fixed messages (like "Sorry, I can only read photos and PDF files") are in English.

## Choosing the AI model

| `LLM_PROVIDER` | Cost | Quality | Needs |
|---|---|---|---|
| `claude` (recommended) | Paid per message | Reads photos and PDFs; best at messy requests | `ANTHROPIC_API_KEY` |
| `ollama` | Free software; you only pay for the VPS | Text only: can't read photos or PDFs. Fine for notes and reminders | A VPS with enough RAM (below), and `docker compose --profile ollama up -d` |

With Claude, expect very roughly 2–10 US cents per message on the default model (`claude-opus-5-5`), more for a photo; that's an estimate, so check your Anthropic usage page after a week. `CLAUDE_MODEL=claude-sonnet-5-5` costs about half.

**Which local model?** Pick one that fits your VPS's RAM, set it as `OLLAMA_MODEL`. All three support tool calling, which the bot needs. Speeds are rough estimates for a CPU-only VPS, not measured with this bot:

| VPS RAM | `OLLAMA_MODEL` | Download | Reply time (4 vCPU, no GPU) |
|---|---|---|---|
| 4 GB | `qwen3:1.7b` | ~1.4 GB | a few seconds; makes more mistakes |
| 8 GB | `qwen3:4b` | ~2.5 GB | ~5–20 s |
| 16 GB | `qwen3:8b` | ~5 GB | ~15–40 s; most reliable |

Tips:
- Free VPS option: Oracle Cloud's Always Free tier includes an ARM server, cut in mid-2026 from 24 GB to 12 GB RAM and 2 CPU cores. That still fits `qwen3:8b`, but replies will be slow. Ollama supports ARM.
- `OLLAMA_THINK=true` turns on the model's step-by-step reasoning. It's smarter at working out dates, but several times slower on a CPU.
- To make the bot easier for a small model, `create_reminder` accepts "in N minutes" directly, and each message shows the current local date, weekday and time.

## The 24-hour rule

WhatsApp only lets a business send free-form messages to someone within **24 hours of their last message**. After that, it may only send pre-approved **template** messages.

- A reminder due within 24 hours of the person's last message is sent as a normal message.
- A reminder due later is sent through your reminder template (`WA_REMINDER_TEMPLATE`), for example "Reminder: {{1}}". Without a template, those reminders can't be delivered: the bot warns the person when they set one, and skips it when it's due.
- **Approval requests** go to managers as buttons if they messaged the bot in the last 24 hours, otherwise through `WA_APPROVAL_TEMPLATE` (with Approve / Reject quick-reply buttons). If neither works, the bot tells the requester to ask a manager to message the number; the manager can then approve it in chat.
- **Purchase-order updates** to staff (approved, rejected) use `WA_UPDATE_TEMPLATE` outside the window.
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
5. Create three templates under **WhatsApp Manager → Message templates**, all category **Utility**, language matching `WA_TEMPLATE_LANG`. Approval usually takes minutes to a day.

   | Name (`.env`) | Body | Buttons |
   |---|---|---|
   | `reminder` (`WA_REMINDER_TEMPLATE`) | `Reminder: {{1}}` | none |
   | `po_update` (`WA_UPDATE_TEMPLATE`) | `Purchase order update: {{1}}` | none |
   | `po_approval` (`WA_APPROVAL_TEMPLATE`) | `Approval needed: {{1}}` | two **Quick reply** buttons: `Approve`, then `Reject` (in that order) |

### 2. Server

1. Point your domain (e.g. `bot.yourdomain.com`) at the VPS with a DNS **A record**.
2. On the VPS, with [Docker](https://docs.docker.com/engine/install/) installed:

   ```bash
   git clone https://github.com/ZafferAbbas/ZafferAbbas.github.io.git wa-assistant
   cd wa-assistant
   cp .env.example .env    # fill in DOMAIN, WA_*, ANTHROPIC_API_KEY, MANAGER_NUMBERS, STAFF_NUMBERS, ODOO_*, ...
   docker compose up -d
   docker compose logs -f bot
   ```

   [`docker-compose.yml`](docker-compose.yml) starts Caddy (which gets a free HTTPS certificate for `DOMAIN`) and the bot. A small VPS with **1–2 GB of RAM** is enough, since the AI runs at Anthropic (Claude API) and WhatsApp at Meta. Turning on [voice notes](#voice-notes-optional) needs about 3 GB more.

### 3. Connect the webhook

1. In your Meta app: **WhatsApp → Configuration → Webhook → Edit**.
2. Callback URL: `https://bot.yourdomain.com/webhook`. Verify token: the `WA_VERIFY_TOKEN` from your `.env`.
3. Click **Verify and save**, then under **Webhook fields** subscribe to **messages**.
4. Send the number a WhatsApp message. The bot should answer.

Run **one** instance only: the reminder scheduler assumes a single process. Back up the `data` volume; it holds every purchase order, note and reminder.

This repository used to be a GitHub Pages site. If GitHub Pages is still enabled for it, turn it off under **Settings → Pages**.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example). The ones you'll most likely change:

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `claude` (set in `.env.example`) or `ollama` |
| `ANTHROPIC_API_KEY` | | For `LLM_PROVIDER=claude` |
| `MANAGER_NUMBERS` | | Who approves purchase orders; purchase orders are off until set |
| `STAFF_NUMBERS` | (everyone) | Who may create purchase orders |
| `COMPANY_NAME`, `CURRENCY` | | Shown on PDFs and summaries |
| `ODOO_URL`, `ODOO_DB`, `ODOO_API_KEY`, `ODOO_API` | | See [Odoo](#odoo) |
| `CUSTOM_ERP_URL`, `CUSTOM_ERP_SECRET` | | See [Custom ERP](#custom-erp) |
| `BOT_NAME` | `Assistant` | Name the bot uses for itself |
| `REPLY_LANGUAGE` | (person's own; Roman Urdu for Urdu) | Force one reply language |
| `STT_URL` | (off) | Turns on voice notes; see [Voice notes](#voice-notes-optional) |
| `TIMEZONE` | system zone | IANA zone for reading and sending reminder times, e.g. `Asia/Karachi` |
| `DOMAIN` | | Domain for HTTPS; the webhook is `https://DOMAIN/webhook` |
| `WA_REMINDER_TEMPLATE`, `WA_UPDATE_TEMPLATE`, `WA_APPROVAL_TEMPLATE` | | Approved templates for messages outside the 24-hour window |
| `WA_TRANSPORT` | `cloud` | `cloud` (official) or `baileys` (unofficial, supports groups) |
| `ALLOWED_NUMBERS` | (anyone) | Restrict who can message the bot |

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev     # needs a filled-in .env
```

Code layout:

- `src/index.ts`: wiring and the per-chat queue
- `src/handler.ts`: one incoming message → reply (photos, PDFs, voice notes, button taps)
- `src/agent.ts`: picks the AI backend, builds each turn
- `src/po/`: purchase orders: `service.ts` (create, approve, sync), `tools.ts` (AI tools), `pdf.ts`
- `src/erp/`: `odoo.ts` (JSON-2 and JSON-RPC), `webhook.ts` (custom ERP)
- `src/stt.ts`: voice-note transcription (optional)
- `src/tools.ts`: system prompt and the notes/reminders tools
- `src/llm/`: `ollama.ts` (local model), `claude.ts` (optional)
- `src/db.ts`: SQLite store
- `src/scheduler.ts`: sends due reminders
- `src/time.ts`: time zones and recurrence
- `src/transports/`: `cloud.ts` (official API), `baileys.ts` (unofficial)
