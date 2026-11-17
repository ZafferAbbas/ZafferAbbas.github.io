import PDFDocument from "pdfkit";
import type { PurchaseOrder } from "../db.js";
import { formatTime } from "../time.js";

export interface PdfOptions {
  companyName: string;
  currency: string;
  timezone: string;
}

const STATUS_LABEL: Record<PurchaseOrder["status"], string> = {
  pending: "PENDING APPROVAL",
  approved: "APPROVED",
  synced: "APPROVED",
  sync_failed: "APPROVED (ERP sync failed)",
  rejected: "REJECTED",
  cancelled: "CANCELLED",
};

function money(n: number, currency: string): string {
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
}

/** Renders a purchase order as a one-page (or longer) A4 PDF. */
export function renderPurchaseOrderPdf(po: PurchaseOrder, opts: PdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Purchase Order ${po.number}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    doc.font("Helvetica-Bold").fontSize(18).text(opts.companyName, left, 50);
    doc.font("Helvetica").fontSize(11).fillColor("#555").text("Purchase Order", left, doc.y + 2);
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#000").text(po.number, left, 50, { width, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor("#555").text(STATUS_LABEL[po.status], left, 72, { width, align: "right" });

    doc.moveDown(2).fillColor("#000");
    const refs = JSON.parse(po.erp_refs || "{}") as Record<string, string>;
    const rows: [string, string][] = [
      ["Supplier", po.supplier_name],
      ["Date", formatTime(po.created_at, opts.timezone)],
      ["Requested by", po.requester_name || po.requester_id],
    ];
    if (po.decided_at) {
      rows.push([po.status === "rejected" ? "Rejected by" : "Approved by", `${po.decided_by ?? ""}, ${formatTime(po.decided_at, opts.timezone)}`]);
    }
    if (po.reject_reason) rows.push(["Reason", po.reject_reason]);
    const refLabel: Record<string, string> = { odoo: "Odoo reference", custom_erp: "ERP reference" };
    for (const [k, v] of Object.entries(refs)) rows.push([refLabel[k] ?? `${k} reference`, v]);
    let y = 115;
    for (const [k, v] of rows) {
      doc.font("Helvetica-Bold").fontSize(10).text(k, left, y, { width: 110 });
      doc.font("Helvetica").text(v, left + 115, y, { width: width - 115 });
      y = doc.y + 4;
    }

    // Items table
    const cols = { n: left, desc: left + 25, qty: left + 300, price: left + 370, total: left + 440 };
    y += 16;
    doc.rect(left, y - 4, width, 20).fill("#f0f0f0").fillColor("#000");
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("#", cols.n, y, { width: 20 });
    doc.text("Item", cols.desc, y, { width: 270 });
    doc.text("Qty", cols.qty, y, { width: 65, align: "right" });
    doc.text("Unit price", cols.price, y, { width: 65, align: "right" });
    doc.text("Total", cols.total, y, { width: right - cols.total, align: "right" });
    y += 22;

    let grand = 0;
    let allPriced = true;
    doc.font("Helvetica").fontSize(10);
    po.items.forEach((it, i) => {
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = 50;
      }
      const desc = it.product_code ? `[${it.product_code}] ${it.description}` : it.description;
      const qty = `${it.quantity}${it.unit ? ` ${it.unit}` : ""}`;
      const total = it.unit_price === null ? null : it.unit_price * it.quantity;
      if (total === null) allPriced = false;
      else grand += total;
      const top = y;
      doc.text(String(i + 1), cols.n, top, { width: 20 });
      doc.text(desc, cols.desc, top, { width: 270 });
      const rowBottom = doc.y;
      doc.text(qty, cols.qty, top, { width: 65, align: "right" });
      doc.text(it.unit_price === null ? "-" : money(it.unit_price, ""), cols.price, top, { width: 65, align: "right" });
      doc.text(total === null ? "-" : money(total, ""), cols.total, top, { width: right - cols.total, align: "right" });
      y = Math.max(rowBottom, doc.y) + 6;
      doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor("#e5e5e5").stroke();
    });

    y += 6;
    doc.font("Helvetica-Bold").text(allPriced ? `Total: ${money(grand, opts.currency)}` : "Total: prices to be confirmed", left, y, {
      width,
      align: "right",
    });
    if (po.notes) {
      doc.moveDown(2).font("Helvetica-Bold").text("Notes", left).font("Helvetica").text(po.notes, { width });
    }
    doc.font("Helvetica").fontSize(8).fillColor("#888").text("Created via WhatsApp", left, doc.page.height - 70, { width, align: "center" });
    doc.end();
  });
}
