import type { Logger } from "pino";
import type { PoItem, PurchaseOrder, Store } from "../db.js";
import type { ErpCatalog, ErpConnector } from "../erp/types.js";
import { formatTime } from "../time.js";
import type { IncomingMessage, Transport } from "../transports/types.js";
import { renderPurchaseOrderPdf } from "./pdf.js";

export type Role = "manager" | "staff" | "none";

export interface PurchaseOrderOptions {
  /** Empty = anyone allowed to use the bot counts as staff. */
  staffNumbers: string[];
  managerNumbers: string[];
  companyName: string;
  currency: string;
  numberPrefix: string;
  timezone: string;
  /** Let a manager approve their own purchase orders. */
  allowSelfApproval?: boolean;
}

export interface NewPurchaseOrder {
  supplierName: string;
  supplierRef: string | null;
  notes: string;
  items: PoItem[];
}

const ACTION = /^po:(approve|reject):(\d+)$/;

/** Purchase orders: creation by staff, approval by managers on WhatsApp, then submission to the ERPs. */
export class PurchaseOrderService {
  constructor(
    private store: Store,
    private transport: Transport,
    private connectors: ErpConnector[],
    readonly catalog: ErpCatalog | null,
    private opts: PurchaseOrderOptions,
    private log: Logger,
  ) {}

  get enabled(): boolean {
    return this.opts.managerNumbers.length > 0;
  }

  roleOf(senderId: string): Role {
    if (!this.enabled) return "none";
    const n = this.transport.numberOf(senderId);
    if (n && this.opts.managerNumbers.includes(n)) return "manager";
    if (this.opts.staffNumbers.length === 0) return "staff";
    return n && this.opts.staffNumbers.includes(n) ? "staff" : "none";
  }

  /** Creates a purchase order pending approval and asks the managers. Returns it with how many managers were reached. */
  async create(msg: IncomingMessage, input: NewPurchaseOrder): Promise<{ po: PurchaseOrder; managersNotified: number }> {
    if (input.items.length === 0) throw new Error("A purchase order needs at least one item");
    const po = this.store.createPurchaseOrder(
      {
        chat_id: msg.chatId,
        requester_id: msg.senderId,
        requester_name: msg.senderName,
        supplier_name: input.supplierName,
        supplier_ref: input.supplierRef,
        notes: input.notes,
        items: input.items,
      },
      this.opts.numberPrefix,
    );
    this.log.info({ po: po.number, by: msg.senderName }, "purchase order created");
    const managersNotified = await this.requestApproval(po);
    return { po, managersNotified };
  }

  private async requestApproval(po: PurchaseOrder): Promise<number> {
    const requester = this.transport.numberOf(po.requester_id);
    const managers = this.opts.managerNumbers.filter((m) => this.opts.allowSelfApproval || m !== requester);
    const text = `🧾 *Approval needed: ${po.number}*\n${this.summary(po)}`;
    const fallback = `${text}\n\nReply *approve ${po.number}* or *reject ${po.number} <reason>*`;
    let reached = 0;
    for (const m of managers) {
      try {
        await this.transport.sendButtons(
          this.transport.chatIdForNumber(m),
          text,
          [
            { id: `po:approve:${po.id}`, title: "Approve" },
            { id: `po:reject:${po.id}`, title: "Reject" },
          ],
          fallback,
          { kind: "update", text: `${po.number} from ${po.requester_name || "staff"}: ${this.oneLine(po)}` },
        );
        reached++;
      } catch (err) {
        this.log.warn({ err, po: po.number, manager: m }, "could not send approval request");
      }
    }
    return reached;
  }

  /** Handles a tapped Approve / Reject button. Returns the reply for the manager, or null if it isn't a PO action. */
  async handleAction(msg: IncomingMessage): Promise<string | null> {
    const m = msg.action?.match(ACTION);
    if (!m) return null;
    const po = this.store.getPurchaseOrder(Number(m[2]));
    if (!po) return "That purchase order no longer exists.";
    const result = await this.decide(msg, po, m[1] === "approve" ? "approve" : "reject", null);
    return result.message;
  }

  /** Approves or rejects a pending purchase order. Only managers may do this. */
  async decide(
    msg: IncomingMessage,
    po: PurchaseOrder,
    decision: "approve" | "reject",
    reason: string | null,
  ): Promise<{ ok: boolean; message: string; po: PurchaseOrder }> {
    if (this.roleOf(msg.senderId) !== "manager") return { ok: false, message: "Only managers can approve or reject purchase orders.", po };
    const me = this.transport.numberOf(msg.senderId);
    if (!this.opts.allowSelfApproval && me && me === this.transport.numberOf(po.requester_id)) {
      return { ok: false, message: `You created ${po.number}, so another manager has to approve it.`, po };
    }
    const to = decision === "approve" ? "approved" : "rejected";
    const moved = this.store.transitionPurchaseOrder(po.id, ["pending"], to, {
      decided_by: msg.senderName || me || msg.senderId,
      decided_at: Date.now(),
      reject_reason: reason,
    });
    if (!moved) {
      const current = this.store.getPurchaseOrder(po.id)!;
      return { ok: false, message: `${po.number} is already ${current.status.replace("_", " ")}${current.decided_by ? ` (by ${current.decided_by})` : ""}.`, po: current };
    }
    this.log.info({ po: po.number, decision, by: msg.senderName }, "purchase order decided");
    let updated = this.store.getPurchaseOrder(po.id)!;

    if (decision === "reject") {
      await this.notifyRequester(updated, `❌ *${po.number} was rejected* by ${updated.decided_by}${reason ? `\nReason: ${reason}` : ""}`);
      return { ok: true, message: `Rejected ${po.number}. ${updated.requester_name || "The requester"} has been told.`, po: updated };
    }

    updated = await this.submit(updated);
    const refs = this.refsText(updated);
    const synced = updated.status === "synced";
    await this.notifyRequester(
      updated,
      synced
        ? `✅ *${po.number} was approved* by ${updated.decided_by}${refs ? `\n${refs}` : ""}`
        : `✅ *${po.number} was approved* by ${updated.decided_by}. It couldn't be sent to the ERP yet; a manager has been told.`,
    );
    return {
      ok: true,
      message: synced
        ? `Approved ${po.number}.${refs ? ` ${refs}` : ""}`
        : `Approved ${po.number}, but sending it to the ERP failed: ${updated.sync_error}\nFix the problem, then ask me to *retry ${po.number}*.`,
      po: updated,
    };
  }

  /** Sends an approved purchase order to every ERP that doesn't have it yet. */
  async submit(po: PurchaseOrder): Promise<PurchaseOrder> {
    const refs = JSON.parse(po.erp_refs || "{}") as Record<string, string>;
    const errors: string[] = [];
    for (const c of this.connectors) {
      if (refs[c.name]) continue;
      try {
        refs[c.name] = (await c.submit(po)) ?? "sent";
        this.log.info({ po: po.number, erp: c.name, ref: refs[c.name] }, "purchase order sent to ERP");
      } catch (err) {
        errors.push(`${c.name}: ${(err as Error).message}`);
        this.log.error({ err, po: po.number, erp: c.name }, "failed to send purchase order to ERP");
      }
    }
    const status = errors.length ? "sync_failed" : "synced";
    this.store.transitionPurchaseOrder(po.id, ["approved", "sync_failed"], status, {
      erp_refs: JSON.stringify(refs),
      sync_error: errors.length ? errors.join("; ") : null,
    });
    return this.store.getPurchaseOrder(po.id)!;
  }

  cancel(msg: IncomingMessage, po: PurchaseOrder): { ok: boolean; message: string } {
    const isOwner = po.requester_id === msg.senderId;
    if (!isOwner && this.roleOf(msg.senderId) !== "manager") return { ok: false, message: "You can only cancel your own purchase orders." };
    if (!this.store.transitionPurchaseOrder(po.id, ["pending"], "cancelled")) {
      return { ok: false, message: `${po.number} can't be cancelled because it is ${po.status.replace("_", " ")}.` };
    }
    return { ok: true, message: `Cancelled ${po.number}.` };
  }

  /** Whether this sender may see this purchase order. */
  canView(senderId: string, po: PurchaseOrder): boolean {
    return po.requester_id === senderId || this.roleOf(senderId) === "manager";
  }

  async sendPdf(chatId: string, po: PurchaseOrder): Promise<void> {
    const pdf = await renderPurchaseOrderPdf(po, this.opts);
    await this.transport.sendDocument(chatId, pdf, `${po.number}.pdf`, `${po.number} · ${po.supplier_name}`);
  }

  private async notifyRequester(po: PurchaseOrder, text: string): Promise<void> {
    try {
      await this.transport.send(po.chat_id, text, { notice: { kind: "update", text: text.replace(/[*_~]/g, "") } });
    } catch (err) {
      this.log.warn({ err, po: po.number }, "could not notify requester");
    }
  }

  summary(po: PurchaseOrder): string {
    const lines = [
      `Supplier: ${po.supplier_name}`,
      `Requested by: ${po.requester_name || po.requester_id}, ${formatTime(po.created_at, this.opts.timezone)}`,
      "",
      ...po.items.map(
        (i) =>
          `- ${i.quantity}${i.unit ? ` ${i.unit}` : ""} × ${i.description}${i.unit_price !== null ? ` @ ${this.money(i.unit_price)}` : ""}`,
      ),
    ];
    const total = this.total(po);
    if (total !== null) lines.push("", `Total: ${this.money(total)}`);
    if (po.notes) lines.push("", `Notes: ${po.notes}`);
    return lines.join("\n");
  }

  private oneLine(po: PurchaseOrder): string {
    const items = po.items.map((i) => `${i.quantity} ${i.description}`).join(", ");
    const total = this.total(po);
    return `${po.supplier_name}: ${items}${total !== null ? `, total ${this.money(total)}` : ""}`.slice(0, 900);
  }

  total(po: PurchaseOrder): number | null {
    if (po.items.some((i) => i.unit_price === null)) return null;
    return po.items.reduce((s, i) => s + i.quantity * (i.unit_price ?? 0), 0);
  }

  private money(n: number): string {
    const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return this.opts.currency ? `${this.opts.currency} ${s}` : s;
  }

  refsText(po: PurchaseOrder): string {
    const refs = JSON.parse(po.erp_refs || "{}") as Record<string, string>;
    return Object.entries(refs)
      .map(([k, v]) => `${k === "odoo" ? "Odoo" : k === "custom_erp" ? "ERP" : k}: ${v}`)
      .join(", ");
  }
}
