import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage as HttpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import type { Store } from "../db.js";
import {
  UndeliverableError,
  type ActionButton,
  type IncomingMedia,
  type IncomingMessage,
  type Notice,
  type OutgoingOptions,
  type Transport,
} from "./types.js";

/** Meta only allows free-form messages within 24h of the user's last message. Keep a small safety margin. */
const WINDOW_MS = 24 * 3600_000 - 10 * 60_000;
/** Graph API error code for "outside the 24-hour window, use a template". */
const RE_ENGAGEMENT_ERROR = 131047;
/** Largest incoming media file the bot downloads. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface CloudOptions {
  port: number;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  graphVersion: string;
  /** Approved template with one body variable, for reminders outside the 24h window. */
  reminderTemplate: string;
  /** Approved template with one body variable, for purchase-order updates outside the 24h window. */
  updateTemplate: string;
  /** Approved template with one body variable and two quick-reply buttons (approve, reject). */
  approvalTemplate: string;
  templateLang: string;
  store: Store;
  log: Logger;
  /** Graph API base URL. Only changed in tests. */
  graphBaseUrl?: string;
}

interface WebhookMedia {
  id: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

interface WebhookMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WebhookMedia;
  audio?: WebhookMedia;
  document?: WebhookMedia;
  interactive?: { type: string; button_reply?: { id: string; title: string } };
  button?: { payload?: string; text?: string };
  context?: { id?: string; from?: string };
}

interface WebhookBody {
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: WebhookMessage[];
      };
    }[];
  }[];
}

/**
 * Official Meta WhatsApp Business Cloud API. Direct messages only: a Cloud API number cannot be added to
 * ordinary WhatsApp groups. Free-form messages are only allowed within 24h of the user's last message;
 * outside that window the bot can only send approved templates.
 */
export class CloudTransport implements Transport {
  readonly name = "cloud";
  private server?: Server;

  constructor(private opts: CloudOptions) {
    for (const k of ["verifyToken", "accessToken", "phoneNumberId"] as const) {
      if (!opts[k]) throw new Error(`Cloud API transport needs ${k} (see .env.example)`);
    }
    if (!opts.appSecret) opts.log.warn("WA_APP_SECRET not set: webhook signatures will not be verified");
    if (!opts.reminderTemplate) {
      opts.log.warn("WA_REMINDER_TEMPLATE not set: reminders due more than 24h after someone's last message can't be delivered");
    }
  }

  private get graph(): string {
    return `${this.opts.graphBaseUrl ?? "https://graph.facebook.com"}/${this.opts.graphVersion}`;
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    const { log } = this.opts;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") return void res.writeHead(200).end("ok");
      if (url.pathname !== "/webhook") return void res.writeHead(404).end();

      if (req.method === "GET") {
        const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === this.opts.verifyToken;
        return void (ok ? res.writeHead(200).end(url.searchParams.get("hub.challenge") ?? "") : res.writeHead(403).end());
      }
      if (req.method !== "POST") return void res.writeHead(405).end();

      let raw: Buffer;
      try {
        raw = await readBody(req);
      } catch {
        return void res.writeHead(413).end();
      }
      if (this.opts.appSecret && !this.validSignature(raw, req.headers["x-hub-signature-256"])) {
        log.warn("rejected webhook with bad signature");
        return void res.writeHead(401).end();
      }
      // Answer Meta straight away; downloading media and replying happen afterwards.
      res.writeHead(200).end();

      let body: WebhookBody;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const v = change.value;
          for (const m of v?.messages ?? []) {
            try {
              const msg = await this.parse(m, v?.contacts?.find((c) => c.wa_id === m.from)?.profile?.name);
              if (msg) onMessage(msg);
            } catch (err) {
              log.error({ err, type: m.type }, "failed to read incoming message");
            }
          }
        }
      }
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.opts.port, resolve));
    log.info(`Cloud API webhook listening on :${this.port}/webhook`);
  }

  /** The port the webhook server listens on. */
  get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? this.opts.port;
  }

  stop(): void {
    this.server?.close();
  }

  private async parse(m: WebhookMessage, profileName: string | undefined): Promise<IncomingMessage | null> {
    const timestamp = Number(m.timestamp) * 1000 || Date.now();
    this.opts.store.touchInbound(m.from, timestamp);
    const base = { chatId: m.from, isGroup: false, senderId: m.from, senderName: profileName ?? m.from, addressedToBot: true, timestamp };

    switch (m.type) {
      case "text":
        return m.text?.body.trim() ? { ...base, text: m.text.body } : null;
      case "interactive": {
        const reply = m.interactive?.button_reply;
        return reply ? { ...base, text: reply.title, action: reply.id } : null;
      }
      case "button":
        // A quick-reply button on a template message.
        return m.button?.payload ? { ...base, text: m.button.text ?? "", action: m.button.payload } : null;
      case "image":
      case "audio":
      case "document": {
        const meta = m[m.type]!;
        const media = await this.downloadMedia(m.type, meta);
        return { ...base, text: meta.caption ?? "", media };
      }
      default:
        this.opts.log.info({ type: m.type }, "ignoring unsupported message type");
        return null;
    }
  }

  private async downloadMedia(kind: IncomingMedia["kind"], meta: WebhookMedia): Promise<IncomingMedia> {
    const auth = { Authorization: `Bearer ${this.opts.accessToken}` };
    const infoRes = await fetch(`${this.graph}/${meta.id}`, { headers: auth });
    if (!infoRes.ok) throw new Error(`media lookup failed: ${infoRes.status} ${await infoRes.text()}`);
    const info = (await infoRes.json()) as { url: string; mime_type?: string; file_size?: number };
    if ((info.file_size ?? 0) > MAX_MEDIA_BYTES) throw new Error(`media too large (${info.file_size} bytes)`);
    const fileRes = await fetch(info.url, { headers: auth });
    if (!fileRes.ok) throw new Error(`media download failed: ${fileRes.status}`);
    const data = Buffer.from(await fileRes.arrayBuffer());
    if (data.length > MAX_MEDIA_BYTES) throw new Error(`media too large (${data.length} bytes)`);
    const mimeType = (meta.mime_type ?? info.mime_type ?? "application/octet-stream").split(";")[0].trim();
    return { kind, mimeType, data, filename: meta.filename };
  }

  private validSignature(raw: Buffer, header: string | string[] | undefined): boolean {
    if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", this.opts.appSecret).update(raw).digest();
    const got = Buffer.from(header.slice(7), "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  mentionTag(): string {
    return "";
  }

  chatIdForNumber(digits: string): string {
    return digits;
  }

  numberOf(senderId: string): string | null {
    return senderId.replace(/\D/g, "") || null;
  }

  private windowOpenAt(chatId: string, at: number): boolean {
    const last = this.opts.store.lastInbound(chatId);
    return last !== null && at - last < WINDOW_MS;
  }

  reminderWarning(chatId: string, dueAt: number): string | null {
    if (this.opts.reminderTemplate || this.windowOpenAt(chatId, dueAt)) return null;
    return "WhatsApp only lets this bot message someone within 24 hours of their last message, and this reminder is due after that. Tell the user it will only arrive if they message you again during the 24 hours before it is due.";
  }

  async send(chatId: string, text: string, opts?: OutgoingOptions): Promise<void> {
    const notice = opts?.notice;
    if (notice && !this.windowOpenAt(chatId, Date.now())) return this.sendNoticeTemplate(chatId, notice);
    try {
      await this.post({ messaging_product: "whatsapp", to: chatId, type: "text", text: { body: text, preview_url: false } });
    } catch (err) {
      // Our record of the window can be off (e.g. messages sent before this bot was set up); Meta's answer wins.
      if (notice && err instanceof GraphError && err.code === RE_ENGAGEMENT_ERROR) return this.sendNoticeTemplate(chatId, notice);
      throw err;
    }
  }

  async sendDocument(chatId: string, data: Buffer, filename: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([new Uint8Array(data)], { type: "application/pdf" }), filename);
    const res = await fetch(`${this.graph}/${this.opts.phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}` },
      body: form,
    });
    if (!res.ok) throw new Error(`media upload failed: ${res.status} ${await res.text()}`);
    const { id } = (await res.json()) as { id: string };
    await this.post({ messaging_product: "whatsapp", to: chatId, type: "document", document: { id, filename, caption } });
  }

  async sendButtons(chatId: string, text: string, buttons: ActionButton[], fallbackText: string, notice?: Notice): Promise<void> {
    if (this.windowOpenAt(chatId, Date.now())) {
      try {
        await this.post({
          messaging_product: "whatsapp",
          to: chatId,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: text.slice(0, 1024) },
            action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
          },
        });
        return;
      } catch (err) {
        if (!(err instanceof GraphError && err.code === RE_ENGAGEMENT_ERROR)) throw err;
      }
    }
    if (!notice) throw new UndeliverableError("24-hour window closed");
    if (this.opts.approvalTemplate && buttons.length === 2) {
      // The template defines two quick-reply buttons; their payloads are set per message.
      await this.post({
        messaging_product: "whatsapp",
        to: chatId,
        type: "template",
        template: {
          name: this.opts.approvalTemplate,
          language: { code: this.opts.templateLang },
          components: [
            { type: "body", parameters: [{ type: "text", text: templateParam(notice.text) }] },
            ...buttons.map((b, i) => ({
              type: "button",
              sub_type: "quick_reply",
              index: String(i),
              parameters: [{ type: "payload", payload: b.id }],
            })),
          ],
        },
      });
      return;
    }
    await this.sendNoticeTemplate(chatId, notice);
  }

  private async sendNoticeTemplate(chatId: string, notice: Notice): Promise<void> {
    const name = notice.kind === "reminder" ? this.opts.reminderTemplate : this.opts.updateTemplate;
    if (!name) {
      const variable = notice.kind === "reminder" ? "WA_REMINDER_TEMPLATE" : "WA_UPDATE_TEMPLATE";
      throw new UndeliverableError(`24-hour window closed and ${variable} is not set`);
    }
    await this.post({
      messaging_product: "whatsapp",
      to: chatId,
      type: "template",
      template: {
        name,
        language: { code: this.opts.templateLang },
        components: [{ type: "body", parameters: [{ type: "text", text: templateParam(notice.text) }] }],
      },
    });
  }

  private async post(payload: unknown): Promise<void> {
    const res = await fetch(`${this.graph}/${this.opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      let code: number | undefined;
      try {
        code = JSON.parse(body)?.error?.code;
      } catch {
        // not JSON
      }
      throw new GraphError(`Cloud API send failed: ${res.status} ${body}`, code);
    }
  }
}

/** Template variables may not contain newlines, tabs or more than 4 spaces in a row. */
function templateParam(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 1000) || "-";
}

class GraphError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

function readBody(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) req.destroy(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
