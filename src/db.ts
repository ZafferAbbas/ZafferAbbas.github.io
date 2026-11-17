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

export type PoStatus = "pending" | "approved" | "rejected" | "cancelled" | "synced" | "sync_failed";

export interface PoItem {
  description: string;
  quantity: number;
  unit: string;
  /** Null = let the ERP use its own price (e.g. the supplier's price list). */
  unit_price: number | null;
  /** Odoo product.product id, when matched. */
  product_ref: string | null;
  product_code: string | null;
}

export interface PurchaseOrder {
  id: number;
  number: string;
  chat_id: string;
  requester_id: string;
  requester_name: string;
  supplier_name: string;
  /** Odoo res.partner id, when matched. */
  supplier_ref: string | null;
  notes: string;
  status: PoStatus;
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
  reject_reason: string | null;
  /** JSON object: connector name -> reference in that system (e.g. {"odoo": "P00042"}). */
  erp_refs: string;
  sync_error: string | null;
  items: PoItem[];
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
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        requester_name TEXT NOT NULL DEFAULT '',
        supplier_name TEXT NOT NULL,
        supplier_ref TEXT,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        decided_by TEXT,
        decided_at INTEGER,
        reject_reason TEXT,
        erp_refs TEXT NOT NULL DEFAULT '{}',
        sync_error TEXT
      );
      CREATE INDEX IF NOT EXISTS po_status ON purchase_orders(status, created_at);
      CREATE TABLE IF NOT EXISTS po_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
        position INTEGER NOT NULL,
        description TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL DEFAULT '',
        unit_price REAL,
        product_ref TEXT,
        product_code TEXT
      );
      CREATE INDEX IF NOT EXISTS po_items_po ON po_items(po_id, position);
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

  // ---- purchase orders ----
  createPurchaseOrder(
    po: Pick<PurchaseOrder, "chat_id" | "requester_id" | "requester_name" | "supplier_name" | "supplier_ref" | "notes" | "items">,
    numberPrefix: string,
  ): PurchaseOrder {
    const created_at = Date.now();
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare(
          "INSERT INTO purchase_orders (chat_id, requester_id, requester_name, supplier_name, supplier_ref, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(po.chat_id, po.requester_id, po.requester_name, po.supplier_name, po.supplier_ref, po.notes, created_at);
      const id = Number(r.lastInsertRowid);
      this.db.prepare("UPDATE purchase_orders SET number = ? WHERE id = ?").run(`${numberPrefix}${String(id).padStart(5, "0")}`, id);
      const insertItem = this.db.prepare(
        "INSERT INTO po_items (po_id, position, description, quantity, unit, unit_price, product_ref, product_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      po.items.forEach((it, i) =>
        insertItem.run(id, i, it.description, it.quantity, it.unit, it.unit_price, it.product_ref, it.product_code),
      );
      this.db.exec("COMMIT");
      return this.getPurchaseOrder(id)!;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getPurchaseOrder(id: number): PurchaseOrder | null {
    const row = this.db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id) as unknown as
      | Omit<PurchaseOrder, "items">
      | undefined;
    if (!row) return null;
    const items = this.db
      .prepare("SELECT description, quantity, unit, unit_price, product_ref, product_code FROM po_items WHERE po_id = ? ORDER BY position")
      .all(id) as unknown as PoItem[];
    return { ...row, items };
  }

  /** Finds a purchase order by its number ("PO-00012", "12", "po12"). */
  findPurchaseOrder(ref: string): PurchaseOrder | null {
    const exact = this.db.prepare("SELECT id FROM purchase_orders WHERE upper(number) = upper(?)").get(ref.trim()) as
      | { id: number }
      | undefined;
    if (exact) return this.getPurchaseOrder(exact.id);
    const digits = ref.replace(/\D/g, "");
    return digits ? this.getPurchaseOrder(Number(digits)) : null;
  }

  listPurchaseOrders(filter: { requesterId?: string; status?: PoStatus[]; limit?: number }): PurchaseOrder[] {
    let sql = "SELECT id FROM purchase_orders WHERE 1 = 1";
    const params: (string | number)[] = [];
    if (filter.requesterId) {
      sql += " AND requester_id = ?";
      params.push(filter.requesterId);
    }
    if (filter.status?.length) {
      sql += ` AND status IN (${filter.status.map(() => "?").join(",")})`;
      params.push(...filter.status);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(filter.limit ?? 20);
    const rows = this.db.prepare(sql).all(...params) as unknown as { id: number }[];
    return rows.map((r) => this.getPurchaseOrder(r.id)!);
  }

  /**
   * Moves a purchase order from one of `from` to `to`. Returns false if it was not in one of those states,
   * so two managers tapping Approve at once only approve it once.
   */
  transitionPurchaseOrder(
    id: number,
    from: PoStatus[],
    to: PoStatus,
    fields: Partial<Pick<PurchaseOrder, "decided_by" | "decided_at" | "reject_reason" | "erp_refs" | "sync_error">> = {},
  ): boolean {
    const sets = ["status = ?"];
    const params: (string | number | null)[] = [to];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      params.push(v as string | number | null);
    }
    const sql = `UPDATE purchase_orders SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`;
    return this.db.prepare(sql).run(...params, id, ...from).changes > 0;
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
