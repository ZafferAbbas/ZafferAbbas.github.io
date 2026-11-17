import { createHmac } from "node:crypto";
import type { PurchaseOrder } from "../db.js";
import type { ErpConnector } from "./types.js";

export interface WebhookOptions {
  url: string;
  secret: string;
  timeoutMs?: number;
}

/**
 * Generic connector for a custom ERP. Each approved purchase order is POSTed as JSON:
 *
 *   POST <CUSTOM_ERP_URL>
 *   Content-Type: application/json
 *   X-Signature-256: sha256=<hex HMAC-SHA256 of the raw body, keyed with CUSTOM_ERP_SECRET>
 *   Idempotency-Key: <purchase order number>
 *
 * The ERP should answer 2xx, optionally with {"reference": "..."} (its own id for the order).
 * The same order may be sent again if a retry is requested, so the ERP should use Idempotency-Key to avoid duplicates.
 */
export class WebhookConnector implements ErpConnector {
  readonly name = "custom_erp";

  constructor(private opts: WebhookOptions) {
    if (!opts.secret) throw new Error("CUSTOM_ERP_SECRET is required with CUSTOM_ERP_URL, so your ERP can verify requests");
  }

  async submit(po: PurchaseOrder): Promise<string | null> {
    const body = JSON.stringify(toPayload(po));
    const signature = createHmac("sha256", this.opts.secret).update(body).digest("hex");
    const res = await fetch(this.opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-256": `sha256=${signature}`, "Idempotency-Key": po.number },
      body,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Custom ERP answered ${res.status}: ${text.slice(0, 300)}`);
    try {
      const ref = JSON.parse(text)?.reference;
      return ref === undefined || ref === null ? null : String(ref);
    } catch {
      return null;
    }
  }
}

export function toPayload(po: PurchaseOrder) {
  return {
    event: "purchase_order.approved",
    number: po.number,
    status: po.status,
    created_at: new Date(po.created_at).toISOString(),
    approved_at: po.decided_at ? new Date(po.decided_at).toISOString() : null,
    approved_by: po.decided_by,
    requested_by: { id: po.requester_id, name: po.requester_name },
    supplier: { name: po.supplier_name, odoo_id: po.supplier_ref ? Number(po.supplier_ref) : null },
    notes: po.notes,
    items: po.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit || null,
      unit_price: i.unit_price,
      product_code: i.product_code,
      odoo_product_id: i.product_ref ? Number(i.product_ref) : null,
    })),
    erp_refs: JSON.parse(po.erp_refs || "{}"),
  };
}
