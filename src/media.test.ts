import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { pino } from "pino";
import { Store } from "./db.js";
import { createHandler } from "./handler.js";
import type { ChatTurn, LlmBackend, UserTurn } from "./llm/types.js";
import { PurchaseOrderService } from "./po/service.js";
import { SpeechToText } from "./stt.js";
import type { ToolSpec } from "./tools.js";
import { CloudTransport } from "./transports/cloud.js";
import { UndeliverableError, type IncomingMessage, type OutgoingOptions, type Transport } from "./transports/types.js";

const log = pino({ level: "silent" });
const HOUR = 3600_000;

async function listen(handler: (req: any, body: Buffer, res: any) => void) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

class RecordingBackend implements LlmBackend {
  readonly name = "recording";
  turns: { user: UserTurn; tools: string[] }[] = [];
  constructor(readonly readsAttachments = true) {}
  async run(_system: string, _history: ChatTurn[], user: UserTurn, tools: ToolSpec[]) {
    this.turns.push({ user, tools: tools.map((t) => t.name) });
    return "ok";
  }
}

class SimpleTransport implements Transport {
  readonly name = "simple";
  sent: string[] = [];
  async start() {}
  async send(_c: string, text: string, _o?: OutgoingOptions) {
    this.sent.push(text);
  }
  async sendDocument() {}
  async sendButtons() {}
  mentionTag() {
    return "";
  }
  chatIdForNumber(d: string) {
    return d;
  }
  numberOf(id: string) {
    return id;
  }
}

function msg(extra: Partial<IncomingMessage>): IncomingMessage {
  return { chatId: "923001111111", isGroup: false, senderId: "923001111111", senderName: "Ali", text: "", addressedToBot: true, timestamp: Date.now(), ...extra };
}

function setup(opts: { readsAttachments?: boolean; sttUrl?: string } = {}) {
  const store = new Store("", ":memory:");
  const transport = new SimpleTransport();
  const backend = new RecordingBackend(opts.readsAttachments ?? true);
  const po = new PurchaseOrderService(
    store,
    transport,
    [],
    null,
    { staffNumbers: ["923001111111"], managerNumbers: ["923009999999"], companyName: "Acme", currency: "", numberPrefix: "PO-", timezone: "UTC" },
    log,
  );
  const stt = opts.sttUrl ? new SpeechToText({ url: opts.sttUrl, model: "whisper-small", language: "" }) : null;
  const h = createHandler({ store, transport, backend, purchaseOrders: po, stt, allowedNumbers: ["923005555555"], log });
  return { store, transport, backend, h };
}

test("handler: a voice note is transcribed and the transcript goes to the AI", async () => {
  let form = "";
  const sttServer = await listen((req, body, res) => {
    form = body.toString("latin1");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: " Make a PO for 10 boxes of A4 paper from Al-Noor. " }));
  });
  const s = setup({ sttUrl: sttServer.url });
  await s.h.handle(msg({ media: { kind: "audio", mimeType: "audio/ogg", data: Buffer.from("OggS fake") } }));
  sttServer.close();
  assert.match(form, /name="model"\r\n\r\nwhisper-small/);
  assert.match(form, /filename="voice\.ogg"/);
  const turn = s.backend.turns[0].user;
  assert.match(turn.text, /\[Sent: voice note/);
  assert.match(turn.text, /\nMake a PO for 10 boxes of A4 paper from Al-Noor\.$/);
  assert.equal(s.transport.sent[0], "ok");
});

test("handler: a voice note without a speech-to-text server gets a polite reply", async () => {
  const s = setup();
  await s.h.handle(msg({ media: { kind: "audio", mimeType: "audio/ogg", data: Buffer.from("x") } }));
  assert.match(s.transport.sent[0], /voice notes nahi sun sakta/);
  assert.equal(s.backend.turns.length, 0);
});

test("handler: a photo is passed to the AI as an image, a PDF as a document", async () => {
  const s = setup();
  await s.h.handle(msg({ text: "make this PO", media: { kind: "image", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) } }));
  await s.h.handle(msg({ media: { kind: "document", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4"), filename: "order.pdf" } }));
  const [photo, pdf] = s.backend.turns.map((t) => t.user);
  assert.deepEqual(photo.attachments, [{ kind: "image", mediaType: "image/jpeg", data: "/9j/" }]);
  assert.match(photo.text, /\[Sent: photo \(attached\)\]/);
  assert.equal(pdf.attachments[0].kind, "pdf");
  assert.match(pdf.text, /PDF "order\.pdf"/);
});

test("handler: unsupported files and models that can't see get a clear reply", async () => {
  const s = setup({ readsAttachments: false });
  await s.h.handle(msg({ media: { kind: "image", mimeType: "image/jpeg", data: Buffer.from("x") } }));
  await s.h.handle(msg({ media: { kind: "document", mimeType: "application/zip", data: Buffer.from("x") } }));
  assert.match(s.transport.sent[0], /can't read photos/);
  assert.match(s.transport.sent[1], /only read photos and PDF/);
  assert.equal(s.backend.turns.length, 0);
});

test("handler: staff get purchase-order tools, managers also get approval tools, others none", async () => {
  const s = setup();
  await s.h.handle(msg({ text: "hi" }));
  await s.h.handle(msg({ chatId: "923009999999", senderId: "923009999999", text: "hi" }));
  await s.h.handle(msg({ chatId: "923005555555", senderId: "923005555555", text: "hi" }));
  const [staff, manager, other] = s.backend.turns.map((t) => t.tools);
  assert.ok(staff.includes("create_purchase_order") && !staff.includes("approve_purchase_order"));
  assert.ok(manager.includes("approve_purchase_order") && manager.includes("retry_purchase_order_sync"));
  assert.ok(!other.includes("create_purchase_order"));
  assert.ok(other.includes("save_note"));
});

test("handler: staff and managers are allowed even when ALLOWED_NUMBERS doesn't list them", () => {
  const s = setup();
  assert.equal(s.h.allowed(msg({})), true);
  assert.equal(s.h.allowed(msg({ senderId: "923005555555" })), true);
  assert.equal(s.h.allowed(msg({ senderId: "923004444444" })), false);
});

test("handler: an Approve button tap is handled without the AI", async () => {
  const s = setup();
  await s.h.handle(msg({ chatId: "923009999999", senderId: "923009999999", text: "Approve", action: "po:approve:99" }));
  assert.match(s.transport.sent[0], /no longer exists/);
  assert.equal(s.backend.turns.length, 0);
});

// ---- Cloud API transport ----

async function fakeGraph() {
  const requests: { method: string; path: string; body: Buffer; auth?: string }[] = [];
  const g = await listen((req, body, res) => {
    requests.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v23.0/MEDIA1") {
      return res.end(JSON.stringify({ url: `${g.url}/files/MEDIA1`, mime_type: "image/jpeg", file_size: 3 }));
    }
    if (req.method === "GET" && req.url === "/files/MEDIA1") {
      res.setHeader("content-type", "image/jpeg");
      return res.end(Buffer.from([0xff, 0xd8, 0xff]));
    }
    if (req.url === "/v23.0/123/media") return res.end(JSON.stringify({ id: "UPLOADED9" }));
    res.end(JSON.stringify({ messages: [{ id: "wamid.x" }] }));
  });
  return { ...g, requests };
}

function cloud(store: Store, graphBaseUrl: string, templates: Partial<{ approvalTemplate: string; updateTemplate: string }> = {}) {
  return new CloudTransport({
    port: 0,
    verifyToken: "v",
    accessToken: "TOKEN",
    phoneNumberId: "123",
    appSecret: "",
    graphVersion: "v23.0",
    reminderTemplate: "",
    updateTemplate: templates.updateTemplate ?? "",
    approvalTemplate: templates.approvalTemplate ?? "",
    templateLang: "en",
    store,
    log,
    graphBaseUrl,
  });
}

async function postWebhook(port: number, messages: unknown[]) {
  await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: "923001111111", profile: { name: "Ali" } }], messages } }] }] }),
  });
}

test("cloud: downloads incoming photos and reads button taps", async () => {
  const g = await fakeGraph();
  const store = new Store("", ":memory:");
  const t = cloud(store, g.url);
  const got: IncomingMessage[] = [];
  await t.start((m) => got.push(m));
  const ts = String(Math.floor(Date.now() / 1000));
  await postWebhook(t.port, [
    { id: "a", from: "923001111111", timestamp: ts, type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "new PO" } },
    { id: "b", from: "923001111111", timestamp: ts, type: "interactive", interactive: { type: "button_reply", button_reply: { id: "po:approve:3", title: "Approve" } } },
    { id: "c", from: "923001111111", timestamp: ts, type: "button", button: { payload: "po:reject:3", text: "Reject" } },
  ]);
  for (let i = 0; i < 50 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  t.stop();
  g.close();
  assert.equal(got[0].text, "new PO");
  assert.deepEqual(got[0].media, { kind: "image", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]), filename: undefined });
  assert.ok(g.requests.filter((r) => r.path.includes("MEDIA1")).every((r) => r.auth === "Bearer TOKEN"));
  assert.equal(got[1].action, "po:approve:3");
  assert.equal(got[2].action, "po:reject:3");
  assert.ok(store.lastInbound("923001111111"));
});

test("cloud: sends a PDF by uploading it, then a document message", async () => {
  const g = await fakeGraph();
  const t = cloud(new Store("", ":memory:"), g.url);
  await t.sendDocument("923001111111", Buffer.from("%PDF-1.4 test"), "PO-00001.pdf", "PO-00001");
  g.close();
  const [upload, send] = g.requests;
  assert.equal(upload.path, "/v23.0/123/media");
  assert.match(upload.body.toString(), /filename="PO-00001\.pdf"/);
  assert.deepEqual(JSON.parse(send.body.toString()).document, { id: "UPLOADED9", filename: "PO-00001.pdf", caption: "PO-00001" });
});

test("cloud: approval buttons are interactive inside the 24h window, a template outside it", async () => {
  const g = await fakeGraph();
  const store = new Store("", ":memory:");
  const buttons = [
    { id: "po:approve:1", title: "Approve" },
    { id: "po:reject:1", title: "Reject" },
  ];
  const notice = { kind: "update" as const, text: "PO-00001 from Ali:\n10 A4" };

  store.touchInbound("923009999999", Date.now() - HOUR);
  await cloud(store, g.url, { approvalTemplate: "po_approval" }).sendButtons("923009999999", "Approve?", buttons, "fallback", notice);
  const interactive = JSON.parse(g.requests.at(-1)!.body.toString());
  assert.equal(interactive.type, "interactive");
  assert.deepEqual(interactive.interactive.action.buttons[0], { type: "reply", reply: { id: "po:approve:1", title: "Approve" } });

  store.touchInbound("923008888888", Date.now() - 30 * HOUR);
  await cloud(store, g.url, { approvalTemplate: "po_approval" }).sendButtons("923008888888", "Approve?", buttons, "fallback", notice);
  const template = JSON.parse(g.requests.at(-1)!.body.toString()).template;
  assert.equal(template.name, "po_approval");
  assert.equal(template.components[0].parameters[0].text, "PO-00001 from Ali: 10 A4");
  assert.deepEqual(template.components[2], { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "po:reject:1" }] });

  await assert.rejects(cloud(store, g.url).sendButtons("923008888888", "Approve?", buttons, "fallback", notice), UndeliverableError);
  g.close();
});
