import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Noto Naskh Arabic (SIL Open Font License) covers Urdu, Sindhi, Farsi and Arabic, plus Latin.
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts");
// Letters only: punctuation (like the Urdu comma) and digits don't make a word right-to-left.
const ARABIC_LETTER = /[\u0620-\u064A\u066E-\u06D3\u06D5\u06EE\u06EF\u06FA-\u06FC\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/;
const ARABIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/;
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };

function money(n: number, currency: string): string {
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
}

type Doc = PDFKit.PDFDocument;

interface WriteOptions {
  width: number;
  align?: "left" | "right";
  bold?: boolean;
  size?: number;
  color?: string;
}

/**
 * Writes text at (x, y) and returns the y below it. Latin text uses Helvetica. Text containing Urdu, Sindhi,
 * Farsi or Arabic is laid out right to left with the Naskh font: words in right-to-left order, while numbers
 * and Latin words keep their left-to-right order, and brackets are mirrored.
 */
export function write(doc: Doc, text: string, x: number, y: number, o: WriteOptions): number {
  const size = o.size ?? 10;
  doc.fillColor(o.color ?? "#000");
  if (!ARABIC_LETTER.test(text)) {
    doc.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).text(text, x, y, { width: o.width, align: o.align });
    return doc.y;
  }

  doc.font(o.bold ? "naskh-bold" : "naskh").fontSize(size);
  // Brackets become their own (mirrored) tokens; everything else splits on spaces.
  const tokens = text
    .replace(/([()[\]{}<>])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
  const space = doc.widthOfString(" ");
  const lineHeight = doc.currentLineHeight(true);

  // Wrap in reading order.
  const lines: string[][] = [];
  let line: string[] = [];
  let lineWidth = 0;
  for (const t of tokens) {
    const w = doc.widthOfString(t);
    if (line.length && lineWidth + space + w > o.width) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
    lineWidth += (line.length ? space : 0) + w;
    line.push(t);
  }
  if (line.length) lines.push(line);

  // Each word is drawn on its own at a computed position: the font engine shapes the letters inside a word
  // correctly, but isn't reliable at ordering whole lines of mixed right-to-left and left-to-right text.
  const glyphs = (t: string) => {
    if (t in MIRROR) return MIRROR[t];
    // The font engine lays out Arabic-script digits right to left; pre-reverse them so they read correctly.
    if (!ARABIC_LETTER.test(t) && ARABIC_DIGITS.test(t)) return [...t].reverse().join("");
    return t;
  };
  let cy = y;
  for (const l of lines) {
    // Consecutive left-to-right tokens (numbers, Latin words) form one block that keeps its own order.
    const runs: { rtl: boolean; tokens: string[] }[] = [];
    for (const t of l) {
      const rtl = ARABIC_LETTER.test(t) || t in MIRROR;
      const last = runs.at(-1);
      if (last && !last.rtl && !rtl) last.tokens.push(t);
      else runs.push({ rtl, tokens: [t] });
    }
    const runWidth = (r: { tokens: string[] }) =>
      r.tokens.reduce((s, t) => s + doc.widthOfString(glyphs(t)), 0) + space * (r.tokens.length - 1);
    const total = runs.reduce((s, r) => s + runWidth(r), 0) + space * (runs.length - 1);
    // Runs go from right to left in reading order.
    let cursor = o.align === "left" ? x + total : x + o.width;
    for (const r of runs) {
      const w = runWidth(r);
      let tx = cursor - w;
      for (const t of r.tokens) {
        const g = glyphs(t);
        doc.text(g, tx, cy, { lineBreak: false });
        tx += doc.widthOfString(g) + space;
      }
      cursor -= w + space;
    }
    cy += lineHeight;
  }
  doc.y = cy;
  return cy;
}

/** Renders a purchase order as an A4 PDF. */
export function renderPurchaseOrderPdf(po: PurchaseOrder, opts: PdfOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Purchase Order ${po.number}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("naskh", join(FONT_DIR, "NotoNaskhArabic-Regular.ttf"));
    doc.registerFont("naskh-bold", join(FONT_DIR, "NotoNaskhArabic-Bold.ttf"));

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Header
    const titleBottom = write(doc, opts.companyName, left, 50, { width: width - 180, bold: true, size: 18 });
    write(doc, "Purchase Order", left, titleBottom + 2, { width: 200, size: 11, color: "#555" });
    write(doc, po.number, right - 180, 50, { width: 180, align: "right", bold: true, size: 16 });
    write(doc, STATUS_LABEL[po.status], right - 180, 72, { width: 180, align: "right", color: "#555" });

    // Details
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
    let y = Math.max(115, titleBottom + 24);
    for (const [k, v] of rows) {
      const a = write(doc, k, left, y, { width: 110, bold: true });
      const b = write(doc, v, left + 115, y, { width: width - 115 });
      y = Math.max(a, b) + 4;
    }

    // Items table
    const cols = { n: left, desc: left + 25, qty: left + 300, price: left + 370, total: left + 440 };
    const header = (top: number) => {
      doc.rect(left, top - 4, width, 20).fill("#f0f0f0");
      write(doc, "#", cols.n, top, { width: 20, bold: true });
      write(doc, "Item", cols.desc, top, { width: 270, bold: true });
      write(doc, "Qty", cols.qty, top, { width: 65, align: "right", bold: true });
      write(doc, "Unit price", cols.price, top, { width: 65, align: "right", bold: true });
      write(doc, "Total", cols.total, top, { width: right - cols.total, align: "right", bold: true });
      return top + 22;
    };
    y = header(y + 16);

    let grand = 0;
    let allPriced = true;
    po.items.forEach((it, i) => {
      if (y > doc.page.height - 130) {
        doc.addPage();
        y = header(50);
      }
      const desc = it.product_code ? `[${it.product_code}] ${it.description}` : it.description;
      const total = it.unit_price === null ? null : it.unit_price * it.quantity;
      if (total === null) allPriced = false;
      else grand += total;
      const bottoms = [
        write(doc, String(i + 1), cols.n, y, { width: 20 }),
        write(doc, desc, cols.desc, y, { width: 270 }),
        write(doc, `${it.quantity}${it.unit ? ` ${it.unit}` : ""}`, cols.qty, y, { width: 65, align: "right" }),
        write(doc, it.unit_price === null ? "-" : money(it.unit_price, ""), cols.price, y, { width: 65, align: "right" }),
        write(doc, total === null ? "-" : money(total, ""), cols.total, y, { width: right - cols.total, align: "right" }),
      ];
      y = Math.max(...bottoms) + 6;
      doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor("#e5e5e5").stroke();
    });

    y += 6;
    y = write(doc, allPriced ? `Total: ${money(grand, opts.currency)}` : "Total: prices to be confirmed", left, y, {
      width,
      align: "right",
      bold: true,
    });
    if (po.notes) {
      y = write(doc, "Notes", left, y + 20, { width, bold: true });
      write(doc, po.notes, left, y + 2, { width });
    }
    write(doc, "Created via WhatsApp", left, doc.page.height - 70, { width: width, size: 8, color: "#888" });
    doc.end();
  });
}
