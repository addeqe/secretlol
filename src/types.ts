export type SourceProduct = Record<string, unknown> & { code: string; name: string };
export type Category = { id: string; title: string; url: string; valid: boolean; children: Category[] };
export type Page = { results: SourceProduct[]; pagination: {
  currentPage: number; pageSize: number; numberOfPages: number; totalNumberOfResults: number;
} };
export type Store = { storeId: string; name: string; onlineStore: boolean };
export type Entry = {
  code: string; name: string; brand: string | null; categories: string[];
  priceOre: number | null; priceUnit: string; comparePriceOre: number | null;
  comparePriceUnit: string; depositOre: number | null; available: boolean;
  observedAt: string; priceHash: string; offers: unknown[]; raw: SourceProduct;
  sourcePricing: Record<string, unknown>;
};
export type Scan = { store: Store; entries: Entry[]; categories: Array<{
  path: string; expected: number; collected: number; pages: number;
}>; requests: number; startedAt: string; completedAt: string };
export type Statement = { sql: string; params?: Array<string | number | null> };
export type QueryResult = { results: Record<string, unknown>[]; success: boolean;
  meta?: { rows_read?: number; rows_written?: number; size_after?: number; changes?: number } };
export interface Database { query(sql: string, params?: Statement['params']): Promise<QueryResult[]>;
  batch(statements: Statement[]): Promise<QueryResult[]>; }
