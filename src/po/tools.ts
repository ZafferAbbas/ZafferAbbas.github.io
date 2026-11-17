import { z } from "zod";
import type { PoStatus, PurchaseOrder } from "../db.js";
import type { Store } from "../db.js";
import { tool, type ToolSpec } from "../tools.js";
import type { IncomingMessage } from "../transports/types.js";
import type { PurchaseOrderService, Role } from "./service.js";

function view(po: PurchaseOrder, service: PurchaseOrderService) {
  return {
    number: po.number,
    status: po.status,
    supplier: po.supplier_name,
    requested_by: po.requester_name,
    decided_by: po.decided_by,
    reject_reason: po.reject_reason,
    erp: service.refsText(po) || null,
    sync_error: po.sync_error,
    total: service.total(po),
    items: po.items.map((i) => ({ description: i.description, quantity: i.quantity, unit: i.unit, unit_price: i.unit_price })),
  };
}

/** Purchase-order tools for this sender, depending on their role. Empty for people who can't use purchase orders. */
export function purchaseOrderTools(msg: IncomingMessage, store: Store, service: PurchaseOrderService): ToolSpec[] {
  const role: Role = service.roleOf(msg.senderId);
  if (role === "none") return [];
  const catalog = service.catalog;

  const find = (ref: string) => {
    const po = store.findPurchaseOrder(ref);
    if (!po || !service.canView(msg.senderId, po)) return null;
    return po;
  };
  const notFound = (ref: string) => JSON.stringify({ error: `No purchase order ${ref} that you can see.` });

  const tools: ToolSpec[] = [];

  if (catalog) {
    tools.push(
      tool({
        name: "find_suppliers",
        description: "Search the ERP (Odoo) for a supplier by name. Use the returned ref in create_purchase_order.",
        schema: z.object({ query: z.string().min(1).describe("Part of the supplier's name.") }),
        run: async ({ query }) => {
          const found = await catalog.findSuppliers(query);
          return JSON.stringify(found.length ? found : { results: [], note: "No supplier matched. Try a shorter or different part of the name." });
        },
      }),
      tool({
        name: "find_products",
        description:
          "Search the ERP (Odoo) for a purchasable product by name or internal code. Call it for each item. Use the returned ref in create_purchase_order.",
        schema: z.object({ query: z.string().min(1).describe("Product name or code, e.g. 'A4 paper' or 'PAP-A4'.") }),
        run: async ({ query }) => {
          const found = await catalog.findProducts(query);
          return JSON.stringify(found.length ? found : { results: [], note: "No product matched. Try a shorter or different word." });
        },
      }),
    );
  }

  tools.push(
    tool({
      name: "create_purchase_order",
      description:
        "Create a purchase order and send it to the managers for approval. Only after the person has confirmed the supplier and items.",
      schema: z.object({
        supplier_name: z.string().min(1),
        supplier_ref: catalog
          ? z.string().min(1).describe("The supplier's ref from find_suppliers.")
          : z.string().optional().describe("Leave empty."),
        items: z
          .array(
            z.object({
              description: z.string().min(1).describe("Item name as it should appear on the order."),
              quantity: z.coerce.number().positive(),
              unit: z.string().optional().describe("e.g. 'pcs', 'kg', 'box'."),
              unit_price: z.coerce.number().nonnegative().optional().describe("Only if the person gave a price. Omit to use the ERP's price."),
              product_ref: catalog ? z.string().min(1).describe("The product's ref from find_products.") : z.string().optional(),
              product_code: z.string().optional(),
            }),
          )
          .min(1),
        notes: z.string().optional().describe("Delivery date, site, or other instructions the person gave."),
      }),
      run: async ({ supplier_name, supplier_ref, items, notes }) => {
        const { po, managersNotified } = await service.create(msg, {
          supplierName: supplier_name,
          supplierRef: supplier_ref || null,
          notes: notes ?? "",
          items: items.map((i) => ({
            description: i.description,
            quantity: i.quantity,
            unit: i.unit ?? "",
            unit_price: i.unit_price ?? null,
            product_ref: i.product_ref || null,
            product_code: i.product_code || null,
          })),
        });
        return JSON.stringify({
          created: true,
          number: po.number,
          status: "pending approval",
          managers_notified: managersNotified,
          ...(managersNotified === 0
            ? {
                warning:
                  "No manager could be messaged (WhatsApp only allows messaging people who wrote in the last 24 hours, unless approval templates are set up). Tell the person to ask a manager to message this number; managers can then approve it here.",
              }
            : {}),
        });
      },
    }),
    tool({
      name: "list_purchase_orders",
      description:
        role === "manager"
          ? "List purchase orders. Managers see everyone's. Filter by status, e.g. ['pending'] for ones waiting for approval."
          : "List this person's purchase orders, newest first.",
      schema: z.object({
        status: z.array(z.enum(["pending", "approved", "rejected", "cancelled", "synced", "sync_failed"])).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      run: async ({ status, limit }) => {
        const list = store.listPurchaseOrders({
          requesterId: role === "manager" ? undefined : msg.senderId,
          status: status as PoStatus[] | undefined,
          limit: limit ?? 10,
        });
        return JSON.stringify(
          list.length
            ? list.map((po) => ({ number: po.number, status: po.status, supplier: po.supplier_name, requested_by: po.requester_name, items: po.items.length, total: service.total(po) }))
            : { results: [], note: "No purchase orders found." },
        );
      },
    }),
    tool({
      name: "get_purchase_order",
      description: "Get the full details of a purchase order by its number.",
      schema: z.object({ number: z.string().describe("e.g. PO-00012") }),
      run: async ({ number }) => {
        const po = find(number);
        return po ? JSON.stringify(view(po, service)) : notFound(number);
      },
    }),
    tool({
      name: "send_purchase_order_pdf",
      description: "Send the purchase order to this chat as a PDF document (a copy or 'picture' of it).",
      schema: z.object({ number: z.string() }),
      run: async ({ number }) => {
        const po = find(number);
        if (!po) return notFound(number);
        await service.sendPdf(msg.chatId, po);
        return JSON.stringify({ sent: true, note: "The PDF is already in the chat; just say a word or two." });
      },
    }),
    tool({
      name: "cancel_purchase_order",
      description: "Cancel a purchase order that is still waiting for approval.",
      schema: z.object({ number: z.string() }),
      run: async ({ number }) => {
        const po = find(number);
        return po ? JSON.stringify(service.cancel(msg, po)) : notFound(number);
      },
    }),
  );

  if (role === "manager") {
    tools.push(
      tool({
        name: "approve_purchase_order",
        description: "Approve a pending purchase order (managers only). It is then sent to the ERP.",
        schema: z.object({ number: z.string() }),
        run: async ({ number }) => {
          const po = find(number);
          if (!po) return notFound(number);
          const r = await service.decide(msg, po, "approve", null);
          return JSON.stringify({ ok: r.ok, message: r.message });
        },
      }),
      tool({
        name: "reject_purchase_order",
        description: "Reject a pending purchase order (managers only), with the reason if one was given.",
        schema: z.object({ number: z.string(), reason: z.string().optional() }),
        run: async ({ number, reason }) => {
          const po = find(number);
          if (!po) return notFound(number);
          const r = await service.decide(msg, po, "reject", reason || null);
          return JSON.stringify({ ok: r.ok, message: r.message });
        },
      }),
      tool({
        name: "retry_purchase_order_sync",
        description: "Send an approved purchase order to the ERP again, after sending it failed (managers only).",
        schema: z.object({ number: z.string() }),
        run: async ({ number }) => {
          const po = find(number);
          if (!po) return notFound(number);
          if (po.status !== "sync_failed") return JSON.stringify({ error: `${po.number} is ${po.status}, not waiting for a retry.` });
          const updated = await service.submit(po);
          return JSON.stringify(
            updated.status === "synced" ? { ok: true, erp: service.refsText(updated) } : { ok: false, error: updated.sync_error },
          );
        },
      }),
    );
  }
  return tools;
}
