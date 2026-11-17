import { pino } from "pino";
import { createBackend } from "./agent.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import { OdooConnector } from "./erp/odoo.js";
import type { ErpConnector } from "./erp/types.js";
import { WebhookConnector } from "./erp/webhook.js";
import { createHandler } from "./handler.js";
import { PurchaseOrderService } from "./po/service.js";
import { startScheduler } from "./scheduler.js";
import { parseRemap, SpeechToText } from "./stt.js";
import { BaileysTransport } from "./transports/baileys.js";
import { CloudTransport } from "./transports/cloud.js";
import type { Transport } from "./transports/types.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const store = new Store(config.dataDir);
const backend = await createBackend();

const transport: Transport =
  config.transport === "cloud"
    ? new CloudTransport({ ...config.cloud, store, log })
    : new BaileysTransport({
        authDir: config.baileys.authDir,
        pairingNumber: config.baileys.pairingNumber || undefined,
        groupTriggers: [config.botName.toLowerCase(), ...config.groupTriggers],
        log,
      });

// ERP connectors for approved purchase orders.
const odoo = config.odoo.url ? new OdooConnector(config.odoo) : null;
const connectors: ErpConnector[] = [];
if (odoo) connectors.push(odoo);
if (config.customErp.url) connectors.push(new WebhookConnector(config.customErp));

const purchaseOrders = new PurchaseOrderService(
  store,
  transport,
  connectors,
  odoo,
  { ...config.purchaseOrders, timezone: config.timezone, allowSelfApproval: process.env.PO_ALLOW_SELF_APPROVAL === "true" },
  log,
);
if (!purchaseOrders.enabled) log.info("Purchase orders are off: set MANAGER_NUMBERS to turn them on");
else if (connectors.length === 0) log.warn("Purchase orders are on, but no ERP is set up (ODOO_URL / CUSTOM_ERP_URL)");

const stt = config.speechToText.url
  ? new SpeechToText({ ...config.speechToText, remap: parseRemap(config.speechToText.remap) })
  : null;
const { allowed, handle } = createHandler({
  store,
  transport,
  backend,
  purchaseOrders: purchaseOrders.enabled ? purchaseOrders : null,
  stt,
  allowedNumbers: config.allowedNumbers,
  log,
});

// One turn at a time per chat, so replies stay in order and history stays consistent.
const queues = new Map<string, Promise<void>>();
function enqueue(chatId: string, job: () => Promise<void>): void {
  const prev = queues.get(chatId) ?? Promise.resolve();
  const next = prev.then(job, job).finally(() => {
    if (queues.get(chatId) === next) queues.delete(chatId);
  });
  queues.set(chatId, next);
}

const typing = transport instanceof BaileysTransport ? transport : undefined;

await transport.start((msg) => {
  if (!msg.addressedToBot || !allowed(msg)) return;
  // Ignore backlog delivered on reconnect.
  if (Date.now() - msg.timestamp > 10 * 60_000) return;
  log.info({ chat: msg.chatId, from: msg.senderName, group: msg.isGroup, media: msg.media?.kind, action: msg.action }, "message");
  enqueue(msg.chatId, async () => {
    await typing?.setTyping(msg.chatId, true);
    try {
      await handle(msg);
    } finally {
      await typing?.setTyping(msg.chatId, false);
    }
  });
});

startScheduler(store, transport, log);
setInterval(() => store.pruneHistory(config.historyTurns * 2), 3600_000).unref();
log.info(
  {
    transport: transport.name,
    llm: backend.name,
    timezone: config.timezone,
    purchaseOrders: purchaseOrders.enabled,
    erp: connectors.map((c) => c.name),
    voiceNotes: !!stt,
  },
  `${config.botName} is running`,
);
