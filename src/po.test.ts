import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { pino } from "pino";
import { Store } from "./db.js";
import { OdooConnector } from "./erp/odoo.js";
import { WebhookConnector } from "./erp/webhook.js";
import { renderPurchaseOrderPdf } from "./po/pdf.js";
import { PurchaseOrderService } from "./po/service.js";
import type { ActionButton, IncomingMessage, Notice, OutgoingOptions, Transport } from "./transports/types.js";

const log = pino({ level: "silent" });

/** Records everything the bot sends. Chat ids are plain phone numbers, like the Cloud API. */
class FakeTransport implements Transport {
  readonly name = "fake";
  sent: { chatId: string; text: string; opts?: OutgoingOptions }[] = [];
  buttons: { chatId: string; text: string; buttons: ActionButton[]; notice?: Notice }[] = [];
  docs: { chatId: string; data: Buffer; filename: string }[] = [];
  async start() {}
  async send(chatId: string, text: string, opts?: OutgoingOptions) {
    this.sent.push({ chatId, text, opts });
  }
  async sendDocument(chatId: string, data: Buffer, filename: string) {
    this.docs.push({ chatId, data, filename });
  }
  async sendButtons(chatId: string, text: string, buttons: ActionButton[], _fallback: string, notice?: Notice) {
    this.buttons.push({ chatId, text, buttons, notice });
  }
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

/** Minimal Odoo JSON-2 stand-in: vendors, products, purchase.order create / button_confirm / read / search_read. */
async function fakeOdoo(opts: { failCreate?: boolean } = {}) {
  const calls: { path: string; auth?: string; body: any }[] = [];
  const orders: { id: number; name: string; state: string; origin: string; vals: any }[] = [];
  let failCreate = !!opts.failCreate;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url!, auth: req.headers.authorization, body });
      const reply = (status: number, data: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(data));
      };
      const [, , , model, method] = req.url!.split("/");
      if (model === "res.partner" && method === "search_read") return reply(200, [{ id: 7, display_name: "Al-Noor Traders", supplier_rank: 3 }]);
      if (model === "product.product" && method === "search_read") {
        return reply(200, [{ id: 41, display_name: "A4 Paper 80gsm", default_code: "PAP-A4", standard_price: 950, uom_id: [1, "Units"] }]);
      }
      if (model === "purchase.order" && method === "search_read") {
        const origin = body.domain?.[0]?.[2];
        return reply(200, orders.filter((o) => o.origin === origin).map((o) => ({ id: o.id, name: o.name, state: o.state })));
      }
      if (model === "purchase.order" && method === "create") {
        if (failCreate) return reply(500, { message: "Odoo is down" });
        const vals = body.vals_list[0];
        const id = orders.length + 100;
        orders.push({ id, name: `P${String(id).padStart(5, "0")}`, state: "draft", origin: vals.origin, vals });
        return reply(200, [id]);
      }
      if (model === "purchase.order" && method === "button_confirm") {
        for (const o of orders) if (body.ids.includes(o.id)) o.state = "purchase";
        return reply(200, true);
      }
      if (model === "purchase.order" && method === "read") {
        return reply(200, orders.filter((o) => body.ids.includes(o.id)).map((o) => ({ id: o.id, name: o.name })));
      }
      reply(404, { message: `unexpected ${req.url}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return {
    calls,
    orders,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setFailCreate: (v: boolean) => (failCreate = v),
    close: () => server.close(),
  };
}

async function fakeErp() {
  const received: { body: string; signature?: string; key?: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ body: raw, signature: req.headers["x-signature-256"] as string, key: req.headers["idempotency-key"] as string });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ reference: "ERP-555" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const STAFF = "923001111111";
const MANAGER = "923009999999";
const OTHER_MANAGER = "923008888888";

function msgFrom(number: string, name: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return { chatId: number, isGroup: false, senderId: number, senderName: name, text: "", addressedToBot: true, timestamp: Date.now(), ...extra };
}

async function setup(odooOpts: { failCreate?: boolean } = {}) {
  const odoo = await fakeOdoo(odooOpts);
  const erp = await fakeErp();
  const store = new Store("", ":memory:");
  const transport = new FakeTransport();
  const connector = new OdooConnector({ url: odoo.url, database: "acme", api: "json2", login: "", apiKey: "key123", confirm: true });
  const service = new PurchaseOrderService(
    store,
    transport,
    [connector, new WebhookConnector({ url: erp.url, secret: "s3cret" })],
    connector,
    { staffNumbers: [STAFF], managerNumbers: [MANAGER, OTHER_MANAGER], companyName: "Acme", currency: "PKR", numberPrefix: "PO-", timezone: "Asia/Karachi" },
    log,
  );
  return { odoo, erp, store, transport, service, close: () => (odoo.close(), erp.close()) };
}

const newPo = {
  supplierName: "Al-Noor Traders",
  supplierRef: "7",
  notes: "Deliver to warehouse 2",
  items: [{ description: "A4 Paper 80gsm", quantity: 10, unit: "box", unit_price: 950, product_ref: "41", product_code: "PAP-A4" }],
};

test("po: roles come from STAFF_NUMBERS and MANAGER_NUMBERS", async () => {
  const s = await setup();
  assert.equal(s.service.roleOf(STAFF), "staff");
  assert.equal(s.service.roleOf(MANAGER), "manager");
  assert.equal(s.service.roleOf("923000000000"), "none");
  s.close();
});

test("po: full flow, create -> approve button -> Odoo + custom ERP -> requester told", async () => {
  const s = await setup();
  const { po, managersNotified } = await s.service.create(msgFrom(STAFF, "Ali"), newPo);
  assert.equal(po.number, "PO-00001");
  assert.equal(po.status, "pending");
  assert.equal(managersNotified, 2);
  assert.deepEqual(s.transport.buttons.map((b) => b.chatId).sort(), [MANAGER, OTHER_MANAGER].sort());
  assert.deepEqual(s.transport.buttons[0].buttons.map((b) => b.id), ["po:approve:1", "po:reject:1"]);
  assert.match(s.transport.buttons[0].text, /10 box × A4 Paper 80gsm @ PKR 950\.00/);

  const reply = await s.service.handleAction(msgFrom(MANAGER, "Sara", { action: "po:approve:1" }));
  assert.match(reply!, /Approved PO-00001\. Odoo: P00100, ERP: ERP-555/);

  // Odoo got the right create call, with Odoo's [0, 0, values] line command, then confirm.
  const create = s.odoo.calls.find((c) => c.path === "/json/2/purchase.order/create")!;
  assert.equal(create.auth, "bearer key123");
  const vals = create.body.vals_list[0];
  assert.equal(vals.partner_id, 7);
  assert.equal(vals.origin, "WhatsApp PO-00001");
  assert.deepEqual(vals.order_line, [[0, 0, { product_id: 41, product_qty: 10, name: "A4 Paper 80gsm", price_unit: 950 }]]);
  assert.ok(s.odoo.calls.some((c) => c.path === "/json/2/purchase.order/button_confirm"));
  assert.equal(s.odoo.orders[0].state, "purchase");

  // The custom ERP got a signed payload.
  const hook = s.erp.received[0];
  assert.equal(hook.signature, `sha256=${createHmac("sha256", "s3cret").update(hook.body).digest("hex")}`);
  assert.equal(hook.key, "PO-00001");
  const payload = JSON.parse(hook.body);
  assert.equal(payload.event, "purchase_order.approved");
  assert.equal(payload.items[0].odoo_product_id, 41);
  assert.equal(payload.approved_by, "Sara");

  const stored = s.store.findPurchaseOrder("PO-00001")!;
  assert.equal(stored.status, "synced");
  assert.deepEqual(JSON.parse(stored.erp_refs), { odoo: "P00100", custom_erp: "ERP-555" });
  const told = s.transport.sent.find((m) => m.chatId === STAFF)!;
  assert.match(told.text, /PO-00001 was approved\* by Sara/);
  assert.equal(told.opts?.notice?.kind, "update");

  // A second manager tapping Approve later changes nothing.
  const again = await s.service.handleAction(msgFrom(OTHER_MANAGER, "Omar", { action: "po:approve:1" }));
  assert.match(again!, /already synced \(by Sara\)/);
  assert.equal(s.odoo.calls.filter((c) => c.path.endsWith("/create")).length, 1);
  s.close();
});

test("po: only managers decide, and not on their own orders", async () => {
  const s = await setup();
  const { po } = await s.service.create(msgFrom(MANAGER, "Sara"), newPo);
  // The creator isn't asked to approve their own order.
  assert.deepEqual(s.transport.buttons.map((b) => b.chatId), [OTHER_MANAGER]);
  assert.match((await s.service.decide(msgFrom(MANAGER, "Sara"), po, "approve", null)).message, /another manager/);
  assert.match((await s.service.decide(msgFrom(STAFF, "Ali"), po, "approve", null)).message, /Only managers/);
  const r = await s.service.decide(msgFrom(OTHER_MANAGER, "Omar"), po, "reject", "Too expensive");
  assert.equal(r.po.status, "rejected");
  assert.match(s.transport.sent.find((m) => m.chatId === MANAGER)!.text, /rejected\* by Omar\nReason: Too expensive/);
  assert.equal(s.odoo.calls.filter((c) => c.path.endsWith("/create")).length, 0);
  s.close();
});

test("po: if Odoo fails, the order is kept as sync_failed and a retry doesn't duplicate", async () => {
  const s = await setup({ failCreate: true });
  const { po } = await s.service.create(msgFrom(STAFF, "Ali"), newPo);
  const r = await s.service.decide(msgFrom(MANAGER, "Sara"), po, "approve", null);
  assert.equal(r.po.status, "sync_failed");
  assert.match(r.message, /Odoo is down/);
  // The custom ERP still got it; the retry only re-sends to Odoo.
  assert.equal(s.erp.received.length, 1);

  s.odoo.setFailCreate(false);
  const retried = await s.service.submit(s.store.getPurchaseOrder(po.id)!);
  assert.equal(retried.status, "synced");
  assert.equal(s.erp.received.length, 1);
  assert.equal(s.odoo.orders.length, 1);
  // Retrying again finds the existing Odoo order instead of creating another.
  s.store.transitionPurchaseOrder(po.id, ["synced"], "sync_failed", { erp_refs: JSON.stringify({ custom_erp: "ERP-555" }) });
  await s.service.submit(s.store.getPurchaseOrder(po.id)!);
  assert.equal(s.odoo.orders.length, 1);
  s.close();
});

test("po: cancel only while pending, by the requester", async () => {
  const s = await setup();
  const { po } = await s.service.create(msgFrom(STAFF, "Ali"), newPo);
  assert.equal(s.service.cancel(msgFrom("923007777777", "Eve"), po).ok, false);
  assert.equal(s.service.cancel(msgFrom(STAFF, "Ali"), po).ok, true);
  assert.equal(s.service.cancel(msgFrom(STAFF, "Ali"), s.store.getPurchaseOrder(po.id)!).ok, false);
  s.close();
});

test("po: Odoo catalog lookups", async () => {
  const s = await setup();
  const connector = new OdooConnector({ url: s.odoo.url, database: "", api: "json2", login: "", apiKey: "k", confirm: true });
  assert.deepEqual(await connector.findSuppliers("noor"), [{ ref: "7", name: "Al-Noor Traders" }]);
  assert.deepEqual(await connector.findProducts("a4"), [{ ref: "41", name: "A4 Paper 80gsm", code: "PAP-A4", cost: 950, unit: "Units" }]);
  const productQuery = s.odoo.calls.find((c) => c.path === "/json/2/product.product/search_read")!.body;
  assert.deepEqual(productQuery.domain, [["purchase_ok", "=", true], "|", ["name", "ilike", "a4"], ["default_code", "ilike", "a4"]]);
  s.close();
});

test("po: Odoo legacy JSON-RPC mode logs in and uses execute_kw", async () => {
  const calls: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      calls.push(body.params);
      const { service, method, args } = body.params;
      let result: unknown = null;
      if (service === "common" && method === "login") result = 2;
      else if (args[4] === "search_read") result = [{ id: 7, display_name: "Al-Noor Traders" }];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c = new OdooConnector({ url, database: "acme", api: "jsonrpc", login: "bot@acme.com", apiKey: "k", confirm: true });
  await c.findSuppliers("noor");
  server.close();
  assert.deepEqual(calls[0], { service: "common", method: "login", args: ["acme", "bot@acme.com", "k"] });
  assert.deepEqual(calls[1].args.slice(0, 5), ["acme", 2, "k", "res.partner", "search_read"]);
});

test("po: PDF renders", async () => {
  const s = await setup();
  const { po } = await s.service.create(msgFrom(STAFF, "Ali"), newPo);
  const pdf = await renderPurchaseOrderPdf(po, { companyName: "Acme", currency: "PKR", timezone: "Asia/Karachi" });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1000);
  await s.service.sendPdf(STAFF, po);
  assert.equal(s.transport.docs[0].filename, "PO-00001.pdf");
  s.close();
});
