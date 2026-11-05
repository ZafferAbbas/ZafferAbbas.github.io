import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "./db.js";
import { isoInZone, nextOccurrence, parseWhen, wallToUtc } from "./time.js";

test("parseWhen reads offset-less times as local wall time", () => {
  assert.equal(parseWhen("2026-11-05T09:00", "Asia/Karachi"), Date.parse("2026-11-05T04:00:00Z"));
  assert.equal(parseWhen("2026-11-05T09:00:00+01:00", "Asia/Karachi"), Date.parse("2026-11-05T08:00:00Z"));
  assert.ok(Number.isNaN(parseWhen("tomorrow", "UTC")));
});

test("daily recurrence keeps wall-clock time across DST", () => {
  // 2026-03-29 is the EU spring-forward date.
  const start = wallToUtc({ year: 2026, month: 3, day: 28, hour: 9, minute: 0, second: 0 }, "Europe/London");
  const next = nextOccurrence(start, "daily", "Europe/London", start);
  assert.equal(isoInZone(next, "Europe/London"), "2026-03-29T09:00:00+01:00");
});

test("weekdays skips the weekend and monthly clamps the day", () => {
  const fri = wallToUtc({ year: 2026, month: 11, day: 6, hour: 8, minute: 0, second: 0 }, "UTC");
  assert.equal(isoInZone(nextOccurrence(fri, "weekdays", "UTC", fri), "UTC"), "2026-11-09T08:00:00+00:00");
  const jan31 = wallToUtc({ year: 2027, month: 1, day: 31, hour: 8, minute: 0, second: 0 }, "UTC");
  assert.equal(isoInZone(nextOccurrence(jan31, "monthly", "UTC", jan31), "UTC"), "2027-02-28T08:00:00+00:00");
});

test("store: notes are scoped per chat and searchable", () => {
  const s = new Store("", ":memory:");
  s.addNote({ chat_id: "g1", author_id: "u1", author_name: "A", content: "Office wifi password is hunter2", tags: "wifi" });
  s.addNote({ chat_id: "g2", author_id: "u1", author_name: "A", content: "Other chat wifi", tags: "" });
  assert.equal(s.searchNotes("g1", "wifi", 10).length, 1);
  assert.equal(s.searchNotes("g1", "100%", 10).length, 0);
  const [n] = s.searchNotes("g1", undefined, 10);
  assert.equal(s.deleteNote("g2", n.id), false);
  assert.equal(s.deleteNote("g1", n.id), true);
});

test("store: due reminders reschedule or deactivate", () => {
  const s = new Store("", ":memory:");
  const once = s.addReminder({ chat_id: "c", created_by: "u", created_by_name: "U", text: "call", due_at: 1000, recurrence: null });
  const rec = s.addReminder({ chat_id: "c", created_by: "u", created_by_name: "U", text: "standup", due_at: 1000, recurrence: "daily" });
  assert.equal(s.dueReminders(2000).length, 2);
  s.completeReminder(once.id, null);
  s.completeReminder(rec.id, 5000);
  assert.deepEqual(s.dueReminders(2000), []);
  assert.equal(s.listReminders("c").length, 1);
  assert.equal(s.cancelReminder("c", rec.id), true);
  assert.equal(s.listReminders("c").length, 0);
});
