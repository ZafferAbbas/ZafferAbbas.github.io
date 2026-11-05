import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { Logger } from "pino";
import qrcode from "qrcode-terminal";
import type { IncomingMessage, OutgoingOptions, Transport } from "./types.js";

export interface BaileysOptions {
  authDir: string;
  /** If set, log in with an 8-character pairing code for this number instead of a QR code. */
  pairingNumber?: string;
  groupTriggers: string[];
  log: Logger;
}

/**
 * Connects as a linked device (like WhatsApp Web) to an existing WhatsApp or WhatsApp Business app account.
 * Unlike the Cloud API, this can be added to any group like a normal member.
 */
export class BaileysTransport implements Transport {
  readonly name = "baileys";
  private sock?: WASocket;
  private onMessage?: (msg: IncomingMessage) => void;
  private sentIds = new Set<string>();

  constructor(private opts: BaileysOptions) {}

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { log } = this.opts;
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      auth: state,
      version,
      logger: log.child({ module: "baileys" }, { level: "warn" }) as never,
      markOnlineOnConnect: false,
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    let pairingRequested = false;
    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        if (this.opts.pairingNumber && !pairingRequested) {
          pairingRequested = true;
          const code = await sock.requestPairingCode(this.opts.pairingNumber);
          log.info(`Pairing code: ${code}  (WhatsApp > Linked devices > Link with phone number)`);
        } else if (!this.opts.pairingNumber) {
          log.info("Scan this QR code: WhatsApp > Linked devices > Link a device");
          qrcode.generate(qr, { small: true });
        }
      }
      if (connection === "open") log.info({ id: sock.user?.id }, "WhatsApp connected");
      if (connection === "close") {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          log.error(`Logged out. Delete ${this.opts.authDir} and restart to link again.`);
          process.exit(1);
        }
        log.warn({ status }, "connection closed, reconnecting");
        setTimeout(() => void this.connect(), 3000);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        try {
          const parsed = this.parse(m);
          if (parsed) this.onMessage?.(parsed);
        } catch (err) {
          log.error({ err }, "failed to parse message");
        }
      }
    });
  }

  private botIds(): Set<string> {
    const ids = new Set<string>();
    const u = this.sock?.user;
    if (u?.id) ids.add(jidNormalizedUser(u.id));
    if (u?.lid) ids.add(jidNormalizedUser(u.lid));
    return ids;
  }

  private parse(m: WAMessage): IncomingMessage | null {
    if (!m.message || m.key.fromMe) return null;
    const chatId = m.key.remoteJid;
    if (!chatId || chatId === "status@broadcast" || chatId.endsWith("@newsletter")) return null;

    const msg = m.message;
    const text =
      msg.conversation ??
      msg.extendedTextMessage?.text ??
      msg.imageMessage?.caption ??
      msg.videoMessage?.caption ??
      msg.documentMessage?.caption ??
      "";
    if (!text.trim()) return null;

    const ctxInfo =
      msg.extendedTextMessage?.contextInfo ??
      msg.imageMessage?.contextInfo ??
      msg.videoMessage?.contextInfo ??
      msg.documentMessage?.contextInfo;

    const isGroup = chatId.endsWith("@g.us");
    const senderId = jidNormalizedUser(isGroup ? (m.key.participant ?? "") : chatId);
    const me = this.botIds();
    const mentioned = (ctxInfo?.mentionedJid ?? []).some((j) => me.has(jidNormalizedUser(j)));
    const repliedToBot =
      !!ctxInfo?.quotedMessage &&
      ((!!ctxInfo.participant && me.has(jidNormalizedUser(ctxInfo.participant))) ||
        (!!ctxInfo.stanzaId && this.sentIds.has(ctxInfo.stanzaId)));
    const lower = text.toLowerCase();
    const triggered = this.opts.groupTriggers.some((t) => lower.startsWith(t) || lower.includes(`@${t}`));

    const quoted = ctxInfo?.quotedMessage;
    const quotedText = quoted?.conversation ?? quoted?.extendedTextMessage?.text ?? quoted?.imageMessage?.caption ?? undefined;

    return {
      chatId,
      isGroup,
      senderId,
      senderName: m.pushName ?? senderId.split("@")[0],
      text,
      addressedToBot: !isGroup || mentioned || repliedToBot || triggered,
      quotedText: quotedText ?? undefined,
      timestamp: Number(m.messageTimestamp ?? 0) * 1000 || Date.now(),
    };
  }

  mentionTag(userId: string): string {
    return `@${userId.split("@")[0]}`;
  }

  async send(chatId: string, text: string, opts?: OutgoingOptions): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp socket not connected");
    const isGroup = chatId.endsWith("@g.us");
    const sent = await this.sock.sendMessage(chatId, {
      text,
      mentions: isGroup ? (opts?.mentions ?? []) : [],
    });
    const id = sent?.key.id;
    if (id) {
      this.sentIds.add(id);
      if (this.sentIds.size > 2000) this.sentIds.delete(this.sentIds.values().next().value!);
    }
  }

  async setTyping(chatId: string, on: boolean): Promise<void> {
    await this.sock?.sendPresenceUpdate(on ? "composing" : "paused", chatId).catch(() => {});
  }
}
