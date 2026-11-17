import type { PurchaseOrder } from "../db.js";

export interface CatalogProduct {
  ref: string;
  name: string;
  code: string | null;
  /** The ERP's own cost price, if it has one. */
  cost: number | null;
  unit: string | null;
}

export interface CatalogSupplier {
  ref: string;
  name: string;
}

/** A system approved purchase orders are sent to. */
export interface ErpConnector {
  readonly name: string;
  /** Pushes an approved purchase order. Returns this system's reference for it (e.g. Odoo's "P00042"). */
  submit(po: PurchaseOrder): Promise<string | null>;
}

/** An ERP that can also look up products and suppliers, so the bot can match what staff ask for. */
export interface ErpCatalog {
  findProducts(query: string, limit?: number): Promise<CatalogProduct[]>;
  findSuppliers(query: string, limit?: number): Promise<CatalogSupplier[]>;
}
