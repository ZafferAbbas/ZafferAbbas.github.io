import type { PurchaseOrder } from "../db.js";
import type { CatalogProduct, CatalogSupplier, ErpCatalog, ErpConnector } from "./types.js";

export interface OdooOptions {
  url: string;
  database: string;
  /** "json2": Odoo 19+ external JSON-2 API. "jsonrpc": the legacy /jsonrpc endpoint (Odoo 18 and earlier). */
  api: "json2" | "jsonrpc";
  /** API user's login; needed for jsonrpc only. */
  login: string;
  apiKey: string;
  /** Confirm the purchase order (button_confirm) after creating it. */
  confirm: boolean;
  timeoutMs?: number;
}

type Domain = (string | [string, string, unknown])[];

/**
 * Odoo connector: looks up products and vendors, and creates purchase orders (purchase.order) from approved ones.
 * The API user needs Purchase access, and an API key from Preferences > Account Security.
 */
export class OdooConnector implements ErpConnector, ErpCatalog {
  readonly name = "odoo";
  private uid?: number;

  constructor(private opts: OdooOptions) {
    if (!opts.url || !opts.apiKey) throw new Error("Odoo needs ODOO_URL and ODOO_API_KEY");
    if (opts.api === "jsonrpc" && (!opts.database || !opts.login)) {
      throw new Error("Odoo jsonrpc mode needs ODOO_DB and ODOO_LOGIN");
    }
  }

  async findProducts(query: string, limit = 8): Promise<CatalogProduct[]> {
    const domain: Domain = [["purchase_ok", "=", true], "|", ["name", "ilike", query], ["default_code", "ilike", query]];
    const rows = await this.searchRead("product.product", domain, ["display_name", "default_code", "standard_price", "uom_id"], limit);
    return rows.map((r) => ({
      ref: String(r.id),
      name: String(r.display_name),
      code: r.default_code ? String(r.default_code) : null,
      cost: typeof r.standard_price === "number" ? r.standard_price : null,
      unit: Array.isArray(r.uom_id) ? String(r.uom_id[1]) : null,
    }));
  }

  async findSuppliers(query: string, limit = 8): Promise<CatalogSupplier[]> {
    const rows = await this.searchRead("res.partner", [["name", "ilike", query]], ["display_name", "supplier_rank"], 25);
    // Prefer partners that are already used as vendors.
    rows.sort((a, b) => Number(b.supplier_rank ?? 0) - Number(a.supplier_rank ?? 0));
    return rows.slice(0, limit).map((r) => ({ ref: String(r.id), name: String(r.display_name) }));
  }

  async submit(po: PurchaseOrder): Promise<string | null> {
    if (!po.supplier_ref) throw new Error(`${po.number} has no Odoo vendor; match the supplier first`);
    const missing = po.items.filter((i) => !i.product_ref).map((i) => i.description);
    if (missing.length) throw new Error(`${po.number} has items not matched to Odoo products: ${missing.join(", ")}`);

    const lines = po.items.map((i) => {
      const line: Record<string, unknown> = { product_id: Number(i.product_ref), product_qty: i.quantity, name: i.description };
      if (i.unit_price !== null) line.price_unit = i.unit_price;
      // [0, 0, values] is Odoo's "create this related record" command.
      return [0, 0, line];
    });
    const origin = `WhatsApp ${po.number}`;
    // Idempotent: if an earlier attempt already created this order (and then failed later), reuse it.
    const [existing] = await this.searchRead("purchase.order", [["origin", "=", origin]], ["name", "state"], 1);
    let id: number;
    let state: string;
    if (existing) {
      id = Number(existing.id);
      state = String(existing.state);
    } else {
      id = await this.create("purchase.order", {
        partner_id: Number(po.supplier_ref),
        origin,
        notes: [po.notes, `Requested by ${po.requester_name} via WhatsApp`].filter(Boolean).join("\n"),
        order_line: lines,
      });
      state = "draft";
    }
    if (this.opts.confirm && (state === "draft" || state === "sent")) {
      await this.callOnRecords("purchase.order", "button_confirm", [id]);
    }
    const [rec] = await this.read("purchase.order", [id], ["name"]);
    return rec?.name ? String(rec.name) : String(id);
  }

  // ---- low-level API calls ----

  private async searchRead(model: string, domain: Domain, fields: string[], limit: number): Promise<Record<string, unknown>[]> {
    if (this.opts.api === "json2") {
      return (await this.json2(model, "search_read", { domain, fields, limit })) as Record<string, unknown>[];
    }
    return (await this.executeKw(model, "search_read", [domain], { fields, limit })) as Record<string, unknown>[];
  }

  private async read(model: string, ids: number[], fields: string[]): Promise<Record<string, unknown>[]> {
    if (this.opts.api === "json2") return (await this.json2(model, "read", { ids, fields })) as Record<string, unknown>[];
    return (await this.executeKw(model, "read", [ids], { fields })) as Record<string, unknown>[];
  }

  private async create(model: string, values: Record<string, unknown>): Promise<number> {
    const result =
      this.opts.api === "json2"
        ? await this.json2(model, "create", { vals_list: [values] })
        : await this.executeKw(model, "create", [[values]], {});
    const id = Array.isArray(result) ? result[0] : result;
    if (typeof id !== "number") throw new Error(`Odoo create on ${model} returned ${JSON.stringify(result)}`);
    return id;
  }

  private async callOnRecords(model: string, method: string, ids: number[]): Promise<unknown> {
    if (this.opts.api === "json2") return this.json2(model, method, { ids });
    return this.executeKw(model, method, [ids], {});
  }

  /** Odoo 19+: POST /json/2/<model>/<method> with named arguments. */
  private async json2(model: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `bearer ${this.opts.apiKey}`,
    };
    if (this.opts.database) headers["X-Odoo-Database"] = this.opts.database;
    const res = await fetch(`${this.opts.url}/json/2/${model}/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Odoo ${model}.${method} failed (${res.status}): ${odooErrorMessage(text)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Odoo 18 and earlier: JSON-RPC to /jsonrpc, service "object", method "execute_kw". */
  private async executeKw(model: string, method: string, args: unknown[], kwargs: Record<string, unknown>): Promise<unknown> {
    const uid = await this.login();
    return this.rpc("object", "execute_kw", [this.opts.database, uid, this.opts.apiKey, model, method, args, kwargs]);
  }

  private async login(): Promise<number> {
    if (this.uid) return this.uid;
    const uid = await this.rpc("common", "login", [this.opts.database, this.opts.login, this.opts.apiKey]);
    if (typeof uid !== "number" || !uid) throw new Error("Odoo login failed: check ODOO_DB, ODOO_LOGIN and ODOO_API_KEY");
    this.uid = uid;
    return uid;
  }

  private async rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
    const res = await fetch(`${this.opts.url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`Odoo ${service}.${method} failed (${res.status})`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string; data?: { message?: string } } };
    if (body.error) throw new Error(`Odoo ${service}.${method} failed: ${body.error.data?.message ?? body.error.message}`);
    return body.result;
  }
}

function odooErrorMessage(text: string): string {
  try {
    const body = JSON.parse(text);
    return body.message ?? body.error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
