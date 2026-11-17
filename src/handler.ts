import type { Logger } from "pino";
import { respond } from "./agent.js";
import type { Store } from "./db.js";
import { TransientLlmError, type Attachment, type LlmBackend } from "./llm/types.js";
import type { PurchaseOrderService } from "./po/service.js";
import { purchaseOrderTools } from "./po/tools.js";
import type { SpeechToText } from "./stt.js";
import type { IncomingMessage, Transport } from "./transports/types.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export interface HandlerDeps {
  store: Store;
  transport: Transport;
  backend: LlmBackend;
  purchaseOrders: PurchaseOrderService | null;
  stt: SpeechToText | null;
  /** Phone numbers allowed to use the bot in direct chats. Empty = everyone. */
  allowedNumbers: string[];
  log: Logger;
}

/** Turns one incoming WhatsApp message into a reply. */
export function createHandler(deps: HandlerDeps) {
  const { store, transport, backend, purchaseOrders: po, stt, log } = deps;

  function allowed(msg: IncomingMessage): boolean {
    if (msg.isGroup || deps.allowedNumbers.length === 0) return true;
    if (po && po.roleOf(msg.senderId) !== "none") return true;
    const n = transport.numberOf(msg.senderId);
    return !!n && deps.allowedNumbers.includes(n);
  }

  async function handle(msg: IncomingMessage): Promise<void> {
    const text = msg.text.trim();
    if (text.toLowerCase() === "/reset") {
      store.clearHistory(msg.chatId);
      await transport.send(msg.chatId, "Conversation context cleared. Saved notes and reminders are kept.");
      return;
    }

    try {
      // A tapped Approve / Reject button needs no AI.
      if (msg.action && po) {
        const reply = await po.handleAction(msg);
        if (reply) return void (await transport.send(msg.chatId, reply));
      }

      let turnText = msg.text;
      let sent: string | undefined;
      const attachments: Attachment[] = [];
      const m = msg.media;
      if (m?.kind === "audio") {
        if (!stt?.enabled) return void (await transport.send(msg.chatId, "Sorry, I can't listen to voice notes yet. Please type it instead."));
        const transcript = await stt.transcribe(m.data, m.mimeType);
        if (!transcript) return void (await transport.send(msg.chatId, "I couldn't make out that voice note. Could you try again or type it?"));
        log.info({ chat: msg.chatId, chars: transcript.length }, "voice note transcribed");
        turnText = transcript;
        sent = "voice note (this is its transcript; spellings of names and products may be off)";
      } else if (m) {
        const kind = m.kind === "image" && IMAGE_TYPES.has(m.mimeType) ? "image" : m.mimeType === "application/pdf" ? "pdf" : null;
        if (!kind) return void (await transport.send(msg.chatId, "Sorry, I can only read photos and PDF files."));
        if (!backend.readsAttachments) {
          return void (await transport.send(msg.chatId, "Sorry, I can't read photos or documents with the current AI setup. Please type it instead."));
        }
        attachments.push({ kind, mediaType: kind === "pdf" ? "application/pdf" : m.mimeType, data: m.data.toString("base64") });
        sent = kind === "image" ? "photo (attached)" : `PDF${m.filename ? ` "${m.filename}"` : ""} (attached)`;
      }

      const reply = await respond(backend, msg, store, {
        reminderWarning: transport.reminderWarning?.bind(transport),
        extraTools: po ? purchaseOrderTools(msg, store, po) : [],
        attachments,
        text: turnText,
        sent,
      });
      await transport.send(msg.chatId, reply);
    } catch (err) {
      log.error({ err, chat: msg.chatId }, "failed to respond");
      const busy = err instanceof TransientLlmError;
      await transport
        .send(msg.chatId, busy ? "I'm a bit overloaded right now, please try again in a minute." : "Sorry, something went wrong on my side.")
        .catch(() => {});
    }
  }

  return { allowed, handle };
}
