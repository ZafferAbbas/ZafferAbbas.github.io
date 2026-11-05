import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

// Stand-in for Ollama's /api/chat: first asks for a tool call (with a null optional field, as small models do),
// then answers in text once it sees the tool result.
test("ollama backend runs tool calls and returns the final reply", async () => {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const last = parsed.messages.at(-1);
      const message =
        last.role === "tool"
          ? { role: "assistant", content: "<think>ok</think>Saved it." }
          : {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "save_note", arguments: { content: "Gate code is 4471", tags: null } } }],
            };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message, done: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OLLAMA_MODEL = "test-model";

  const { Store } = await import("./db.js");
  const { createBackend, respond } = await import("./agent.js");
  const store = new Store("", ":memory:");
  const reply = await respond(
    await createBackend(),
    { chatId: "c1", isGroup: false, senderId: "u1", senderName: "Zaffer", text: "remember the gate code is 4471", addressedToBot: true, timestamp: Date.now() },
    store,
  );
  server.close();

  assert.equal(reply, "Saved it.");
  assert.equal(store.searchNotes("c1", "gate", 5)[0]?.content, "Gate code is 4471");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "test-model");
  assert.deepEqual(
    requests[0].tools.map((t: any) => t.function.name),
    ["save_note", "search_notes", "delete_note", "create_reminder", "list_reminders", "cancel_reminder"],
  );
  assert.equal(requests[0].tools[0].function.parameters.$schema, undefined);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.match(requests[1].messages.at(-1).content, /"saved":true/);
  assert.equal(store.recentHistory("c1", 10).length, 2);
});
