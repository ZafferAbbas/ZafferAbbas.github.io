import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage as HttpRequest } from "node:http";
import type { Logger } from "pino";
import type { IncomingMessage, OutgoingOptions, Transport } from "./types.js";

export interface CloudOptions {
  port: number;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  graphVersion: string;
  reminderTemplate: string;
  reminderTemplateLang: string;
  log: Logger;
}

interface WebhookBody {
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: {
          id: string;
          from: string;
          timestamp: string;
          type: string;
          text?: { body: string };
          image?: { caption?: string };
          context?: { id?: string; from?: string };
        }[];
      };
    }[];
  }[];
}

/**
 * Official Meta WhatsApp Business Cloud API. Direct messages only: a Cloud API number cannot be added to
 * ordinary WhatsApp groups. Free-form messages are only allowed within 24h of the user's last message;
 * outside that window reminders need an approved template (WA_REMINDER_TEMPLATE).
 */
export class CloudTransport implements Transport {
  readonly name = "cloud";
  private lastInbound = new Map<string, number>();

  constructor(private opts: CloudOptions) {
    for (const k of ["verifyToken", "accessToken", "phoneNumberId"] as const) {
      if (!opts[k]) throw new Error(`Cloud API transport needs ${k} (see .env.example)`);
    }
    if (!opts.appSecret) opts.log.warn("WA_APP_SECRET not set: webhook signatures will not be verified");
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

      const raw = await readBody(req);
      if (this.opts.appSecret && !this.validSignature(raw, req.headers["x-hub-signature-256"])) {
        log.warn("rejected webhook with bad signature");
        return void res.writeHead(401).end();
      }
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
            const text = m.text?.body ?? m.image?.caption ?? "";
            if (!text.trim()) continue;
            this.lastInbound.set(m.from, Date.now());
            const name = v?.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? m.from;
            onMessage({
              chatId: m.from,
              isGroup: false,
              senderId: m.from,
              senderName: name,
              text,
              addressedToBot: true,
              timestamp: Number(m.timestamp) * 1000 || Date.now(),
            });
          }
        }
      }
    });
    await new Promise<void>((resolve) => server.listen(this.opts.port, resolve));
    log.info(`Cloud API webhook listening on :${this.opts.port}/webhook`);
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

  async send(chatId: string, text: string, opts?: OutgoingOptions): Promise<void> {
    const windowOpen = Date.now() - (this.lastInbound.get(chatId) ?? 0) < 23.5 * 3600_000;
    if (opts?.isReminder && !windowOpen && this.opts.reminderTemplate) {
      await this.post({
        messaging_product: "whatsapp",
        to: chatId,
        type: "template",
        template: {
          name: this.opts.reminderTemplate,
          language: { code: this.opts.reminderTemplateLang },
          components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 1000) }] }],
        },
      });
      return;
    }
    await this.post({ messaging_product: "whatsapp", to: chatId, type: "text", text: { body: text, preview_url: false } });
  }

  private async post(payload: unknown): Promise<void> {
    const res = await fetch(`https://graph.facebook.com/${this.opts.graphVersion}/${this.opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Cloud API send failed: ${res.status} ${await res.text()}`);
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
