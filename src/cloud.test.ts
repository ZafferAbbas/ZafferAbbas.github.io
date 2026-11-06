import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { pino } from "pino";
import { Store } from "./db.js";
import { CloudTransport } from "./transports/cloud.js";
import { UndeliverableError } from "./transports/types.js";

/** Stand-in for Meta's Graph API. `textError` makes free-form text sends fail with that error code. */
async function fakeGraph(textError?: number) {
  const sent: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      sent.push(msg);
      res.setHeader("content-type", "application/json");
      if (msg.type === "text" && textError) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: textError, message: "Re-engagement message" } }));
      }
      res.end(JSON.stringify({ messages: [{ id: "wamid.x" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { sent, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function transport(store: Store, graphBaseUrl: string, reminderTemplate = "") {
  return new CloudTransport({
    port: 0,
    verifyToken: "v",
    accessToken: "t",
    phoneNumberId: "123",
    appSecret: "s",
    graphVersion: "v23.0",
    reminderTemplate,
    reminderTemplateLang: "en",
    store,
    log: pino({ level: "silent" }),
    graphBaseUrl,
  });
}

const HOUR = 3600_000;

test("cloud: inside the 24h window a reminder goes out as plain text", async () => {
  const g = await fakeGraph();
  const store = new Store("", ":memory:");
  store.touchInbound("92300", Date.now() - HOUR);
  await transport(store, g.url, "reminder").send("92300", "⏰ *Reminder*\nCall Ali", { reminderText: "Call Ali" });
  g.close();
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].type, "text");
});

test("cloud: outside the window it uses the template, with a variable that has no line breaks", async () => {
  const g = await fakeGraph();
  const store = new Store("", ":memory:");
  store.touchInbound("92300", Date.now() - 30 * HOUR);
  await transport(store, g.url, "reminder").send("92300", "⏰ *Reminder*\nCall Ali", { reminderText: "Call Ali\nabout\tthe   invoice" });
  g.close();
  assert.equal(g.sent[0].type, "template");
  assert.equal(g.sent[0].template.name, "reminder");
  assert.equal(g.sent[0].template.components[0].parameters[0].text, "Call Ali about the invoice");
});

test("cloud: outside the window with no template, the reminder is undeliverable", async () => {
  const g = await fakeGraph();
  const store = new Store("", ":memory:");
  const t = transport(store, g.url);
  await assert.rejects(t.send("92300", "x", { reminderText: "x" }), UndeliverableError);
  g.close();
  assert.equal(g.sent.length, 0);
});

test("cloud: if Meta says the window is closed, it falls back to the template", async () => {
  const g = await fakeGraph(131047);
  const store = new Store("", ":memory:");
  store.touchInbound("92300", Date.now() - HOUR);
  await transport(store, g.url, "reminder").send("92300", "x", { reminderText: "Call Ali" });
  g.close();
  assert.deepEqual(
    g.sent.map((m) => m.type),
    ["text", "template"],
  );
});

test("cloud: warns when a reminder falls outside the window and no template is set", async () => {
  const store = new Store("", ":memory:");
  store.touchInbound("92300", Date.now());
  const noTemplate = transport(store, "http://unused");
  assert.equal(noTemplate.reminderWarning("92300", Date.now() + 2 * HOUR), null);
  assert.match(noTemplate.reminderWarning("92300", Date.now() + 48 * HOUR) ?? "", /24 hours/);
  assert.equal(transport(store, "http://unused", "reminder").reminderWarning("92300", Date.now() + 48 * HOUR), null);
});
