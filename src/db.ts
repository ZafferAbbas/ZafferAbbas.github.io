import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Recurrence } from "./time.js";

export interface Note {
  id: number;
  chat_id: string;
  author_id: string;
  author_name: string;
  content: string;
  tags: string;
  created_at: number;
}

export interface Reminder {
  id: number;
  chat_id: string;
  created_by: string;
  created_by_name: string;
  text: string;
  due_at: number;
  recurrence: Recurrence | null;
  active: number;
  created_at: number;
}

export interface HistoryRow {
  role: "user" | "assistant";
  content: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string, filename = "assistant.db") {
    if (filename !== ":memory:") mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(filename === ":memory:" ? filename : join(dataDir, filename));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_chat ON notes(chat_id, created_at);
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_by_name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        recurrence TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(active, due_at);
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_chat ON history(chat_id, id);
      CREATE TABLE IF NOT EXISTS chat_activity (
        chat_id TEXT PRIMARY KEY,
        last_inbound_at INTEGER NOT NULL
      );
    `);
  }

  // ---- notes ----
  addNote(n: Omit<Note, "id" | "created_at">): Note {
    const created_at = Date.now();
    const r = this.db
      .prepare("INSERT INTO notes (chat_id, author_id, author_name, content, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(n.chat_id, n.author_id, n.author_name, n.content, n.tags, created_at);
    return { ...n, id: Number(r.lastInsertRowid), created_at };
  }

  searchNotes(chatId: string, query: string | undefined, limit: number): Note[] {
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    let sql = "SELECT * FROM notes WHERE chat_id = ?";
    const params: string[] = [chatId];
    for (const w of words) {
      sql += " AND (lower(content) LIKE ? ESCAPE '\\' OR lower(tags) LIKE ? ESCAPE '\\')";
      const like = `%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      params.push(like, like);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    return this.db.prepare(sql).all(...params, limit) as unknown as Note[];
  }

  deleteNote(chatId: string, id: number): boolean {
    return this.db.prepare("DELETE FROM notes WHERE chat_id = ? AND id = ?").run(chatId, id).changes > 0;
  }

  // ---- reminders ----
  addReminder(r: Omit<Reminder, "id" | "created_at" | "active">): Reminder {
    const created_at = Date.now();
    const res = this.db
      .prepare(
        "INSERT INTO reminders (chat_id, created_by, created_by_name, text, due_at, recurrence, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
      )
      .run(r.chat_id, r.created_by, r.created_by_name, r.text, r.due_at, r.recurrence, created_at);
    return { ...r, id: Number(res.lastInsertRowid), active: 1, created_at };
  }

  listReminders(chatId: string): Reminder[] {
    return this.db
      .prepare("SELECT * FROM reminders WHERE chat_id = ? AND active = 1 ORDER BY due_at")
      .all(chatId) as unknown as Reminder[];
  }

  cancelReminder(chatId: string, id: number): boolean {
    return this.db.prepare("UPDATE reminders SET active = 0 WHERE chat_id = ? AND id = ? AND active = 1").run(chatId, id).changes > 0;
  }

  dueReminders(now: number): Reminder[] {
    return this.db
      .prepare("SELECT * FROM reminders WHERE active = 1 AND due_at <= ? ORDER BY due_at LIMIT 100")
      .all(now) as unknown as Reminder[];
  }

  /** Marks a reminder as sent: reschedules a recurring one, deactivates a one-off. */
  completeReminder(id: number, nextDueAt: number | null): void {
    if (nextDueAt === null) this.db.prepare("UPDATE reminders SET active = 0 WHERE id = ?").run(id);
    else this.db.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").run(nextDueAt, id);
  }

  // ---- conversation history ----
  addHistory(chatId: string, role: "user" | "assistant", content: string): void {
    this.db.prepare("INSERT INTO history (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(chatId, role, content, Date.now());
  }

  recentHistory(chatId: string, limit: number): HistoryRow[] {
    const rows = this.db
      .prepare("SELECT role, content FROM history WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
      .all(chatId, limit) as unknown as HistoryRow[];
    return rows.reverse();
  }

  pruneHistory(keepPerChat: number): void {
    this.db
      .prepare(
        `DELETE FROM history WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY id DESC) AS rn FROM history
           ) WHERE rn > ?
         )`,
      )
      .run(keepPerChat);
  }

  // ---- last message from each chat (for the Cloud API's 24-hour window) ----
  touchInbound(chatId: string, at = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO chat_activity (chat_id, last_inbound_at) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET last_inbound_at = max(last_inbound_at, excluded.last_inbound_at)",
      )
      .run(chatId, at);
  }

  lastInbound(chatId: string): number | null {
    const row = this.db.prepare("SELECT last_inbound_at FROM chat_activity WHERE chat_id = ?").get(chatId) as
      | { last_inbound_at: number }
      | undefined;
    return row ? Number(row.last_inbound_at) : null;
  }

  clearHistory(chatId: string): void {
    this.db.prepare("DELETE FROM history WHERE chat_id = ?").run(chatId);
  }
}
