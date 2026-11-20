import { Connection, HanaParameterType } from "@sap/hana-client";
import {
  BaseStore,
  type GetOperation,
  type IndexConfig,
  type Item,
  type ListNamespacesOperation,
  type MatchCondition,
  type Operation,
  type OperationResults,
  type PutOperation,
  type SearchItem,
  type SearchOperation,
  getTextAtPath,
} from "@langchain/langgraph-checkpoint";
import {
  DEFAULT_VECTOR_COLUMN_TYPE,
  Mutex,
  commit,
  executeBatchStatement,
  executeQuery,
  executeStatement,
  getTableRef,
  prepareQuery,
  rollback,
  sanitizeName,
  serializeVector,
  tableExists,
  validateDatatypeSupport,
  validateVectorColumnType,
} from "../hanautils.js";

export const DEFAULT_MIGRATIONS_TABLE = "LANGGRAPH_STORE_MIGRATIONS";
export const DEFAULT_STORE_TABLE = "LANGGRAPH_STORE";
export const DEFAULT_VECTORS_TABLE = "LANGGRAPH_STORE_VECTORS";

// Bounded identifier lengths keep the composite primary keys within HANA's index
// key-length limit. PREFIX (the dotted namespace) and KEY form the store primary
// key; FIELD_NAME additionally keys the vectors table.
const PREFIX_LEN = 1536;
const KEY_LEN = 512;
const FIELD_LEN = 512;

// Columns selected for an item row, in the order `rowToItem` expects.
const ITEM_COLS = '"VALUE", "CREATED_AT", "UPDATED_AT"';

/**
 * TTL (time-to-live) configuration for a {@link HanaStore}, mirroring the Postgres
 * store: a default item lifetime, whether reads refresh it, and how often a
 * background sweeper deletes expired rows.
 */
export interface TTLConfig {
  /** Default TTL in minutes for new items. */
  defaultTtl?: number;
  /**
   * Whether to refresh an item's TTL on read operations.
   * @default true
   */
  refreshOnRead?: boolean;
  /**
   * Interval in minutes between background TTL sweeps.
   * @default 60
   */
  sweepIntervalMinutes?: number;
}

/**
 * Configuration options for a {@link HanaStore}.
 */
export interface HanaStoreArgs {
  /** An open `@sap/hana-client` database connection. */
  connection: Connection;
  /**
   * Optional semantic-search configuration (`dims`/`embeddings`/`fields`). When
   * omitted the store has no vectors table and `query` searches fall back to
   * metadata-only search.
   */
  index?: IndexConfig;
  /** Optional TTL configuration (expiry + refresh-on-read + background sweep). */
  ttl?: TTLConfig;
  /** Optional schema; defaults to the connection's current schema. */
  schemaName?: string;
  /**
   * Whether `setup()` runs automatically on the first operation.
   * @default true
   */
  ensureTables?: boolean;
  /** Name of the migrations (version ledger) table. */
  migrationsTable?: string;
  /** Name of the key-value store table. */
  storeTable?: string;
  /** Name of the per-field embeddings table. */
  vectorsTable?: string;
  /**
   * Stored embedding column type: `"REAL_VECTOR"` (default, 4-byte) or
   * `"HALF_VECTOR"` (2-byte half precision). `HALF_VECTOR` requires a HANA Cloud
   * instance that offers the type (checked at `setup()`).
   */
  vectorColumnType?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type PutOpWithOptions = PutOperation & { options?: { ttl?: number } };
type SearchOpWithRefresh = SearchOperation & { refreshTtl?: boolean };

const FILTER_OPERATORS = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"];

/**
 * A LangGraph long-term memory store backed by SAP HANA Cloud.
 *
 * `HanaStore` persists hierarchical key-value items with optional TTL expiry and
 * optional semantic (vector) search, following the design of langgraph's Postgres
 * store. Node I/O is async throughout, so the single class covers what the Python
 * package splits into sync and native-async stores.
 *
 * Two tables are always used — a migrations (version ledger) table and the store
 * table (one row per `(namespace, key)` item with JSON value + timestamps + TTL
 * bookkeeping) — plus a vectors table created on demand when `index` is configured
 * (one `REAL_VECTOR` embedding per indexed field, scored with `COSINE_SIMILARITY`).
 *
 * @example
 * ```ts
 * import hanaClient from "@sap/hana-client";
 * import { HanaStore } from "@sap/hana-langchain";
 *
 * const connection = hanaClient.createConnection();
 * connection.connect({ host, port, uid, pwd });
 * const store = new HanaStore({ connection });
 * await store.setup();
 * await store.put(["users", "123"], "prefs", { theme: "dark" });
 * (await store.get(["users", "123"], "prefs"))?.value; // { theme: "dark" }
 * ```
 */
export class HanaStore extends BaseStore {
  private connection: Connection;

  protected indexConfig?: IndexConfig;

  protected ttlConfig?: TTLConfig;

  protected embeddingDims = 0;

  protected indexFields: string[] = [];

  private schemaName: string;

  private ensureTables: boolean;

  protected migrationsTable: string;

  protected storeTable: string;

  protected vectorsTable: string;

  protected vectorColumnType: string;

  private lock = new Mutex();

  private setupPromise?: Promise<void>;

  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(args: HanaStoreArgs) {
    super();
    this.connection = args.connection;
    this.indexConfig = args.index;
    this.ttlConfig = args.ttl;
    this.ensureTables = args.ensureTables ?? true;
    if (args.index !== undefined) {
      this.embeddingDims = Math.trunc(args.index.dims);
      this.indexFields = [...(args.index.fields ?? ["$"])];
    }
    this.schemaName = args.schemaName ? sanitizeName(args.schemaName) : "";
    this.migrationsTable = sanitizeName(
      args.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE
    );
    this.storeTable = sanitizeName(args.storeTable ?? DEFAULT_STORE_TABLE);
    this.vectorsTable = sanitizeName(
      args.vectorsTable ?? DEFAULT_VECTORS_TABLE
    );
    this.vectorColumnType = validateVectorColumnType(
      args.vectorColumnType ?? DEFAULT_VECTOR_COLUMN_TYPE
    );
    if (!this.migrationsTable || !this.storeTable || !this.vectorsTable) {
      throw new Error("Table names must not be empty after sanitization.");
    }
    this.connection.setAutoCommit(false);
  }

  // ------------------------------------------------------------------ #
  // SQL identifiers / schema
  // ------------------------------------------------------------------ #
  private get migrationsRef(): string {
    return getTableRef(this.migrationsTable, this.schemaName);
  }

  private get storeRef(): string {
    return getTableRef(this.storeTable, this.schemaName);
  }

  protected get vectorsRef(): string {
    return getTableRef(this.vectorsTable, this.schemaName);
  }

  /** Ordered DDL statements. Index 0 creates the migrations ledger itself. */
  private migrations(): string[] {
    const migrationsDdl = `CREATE TABLE ${this.migrationsRef} ("V" INTEGER PRIMARY KEY)`;
    const storeDdl =
      `CREATE TABLE ${this.storeRef} (` +
      `"PREFIX" NVARCHAR(${PREFIX_LEN}) NOT NULL, ` +
      `"KEY" NVARCHAR(${KEY_LEN}) NOT NULL, ` +
      '"VALUE" NCLOB NOT NULL, ' +
      '"CREATED_AT" TIMESTAMP DEFAULT CURRENT_UTCTIMESTAMP NOT NULL, ' +
      '"UPDATED_AT" TIMESTAMP DEFAULT CURRENT_UTCTIMESTAMP NOT NULL, ' +
      '"EXPIRES_AT" TIMESTAMP, ' +
      '"TTL_MINUTES" DOUBLE, ' +
      'PRIMARY KEY ("PREFIX", "KEY"))';
    return [migrationsDdl, storeDdl];
  }

  /** DDL for the embeddings table (dimensioned by `index.dims`). */
  protected vectorsDdl(): string {
    return (
      `CREATE TABLE ${this.vectorsRef} (` +
      `"PREFIX" NVARCHAR(${PREFIX_LEN}) NOT NULL, ` +
      `"KEY" NVARCHAR(${KEY_LEN}) NOT NULL, ` +
      `"FIELD_NAME" NVARCHAR(${FIELD_LEN}) NOT NULL, ` +
      `"EMBEDDING" ${this.vectorColumnType}(${this.embeddingDims}), ` +
      '"CREATED_AT" TIMESTAMP DEFAULT CURRENT_UTCTIMESTAMP NOT NULL, ' +
      '"UPDATED_AT" TIMESTAMP DEFAULT CURRENT_UTCTIMESTAMP NOT NULL, ' +
      'PRIMARY KEY ("PREFIX", "KEY", "FIELD_NAME"))'
    );
  }

  private get insertVersionSql(): string {
    return `INSERT INTO ${this.migrationsRef} ("V") VALUES (?)`;
  }

  // ------------------------------------------------------------------ #
  // Query builders
  // ------------------------------------------------------------------ #
  private get omitExpired(): boolean {
    return this.ttlConfig !== undefined;
  }

  /** SQL fragment (no params) excluding expired rows, or an empty string. */
  private get notExpiredClause(): string {
    if (!this.omitExpired) {
      return "";
    }
    return ' AND ("EXPIRES_AT" IS NULL OR "EXPIRES_AT" > CURRENT_UTCTIMESTAMP)';
  }

  private getSql(numKeys: number): string {
    const placeholders = new Array(numKeys).fill("?").join(",");
    return (
      `SELECT "KEY", ${ITEM_COLS} FROM ${this.storeRef} ` +
      `WHERE "PREFIX" = ? AND "KEY" IN (${placeholders})` +
      this.notExpiredClause
    );
  }

  private refreshTtlSql(numKeys: number): string {
    const placeholders = new Array(numKeys).fill("?").join(",");
    return (
      `UPDATE ${this.storeRef} ` +
      'SET "EXPIRES_AT" = ADD_SECONDS(CURRENT_UTCTIMESTAMP, "TTL_MINUTES" * 60) ' +
      `WHERE "PREFIX" = ? AND "KEY" IN (${placeholders}) ` +
      'AND "TTL_MINUTES" IS NOT NULL'
    );
  }

  /**
   * MERGE that inserts a new item or updates an existing one in place.
   *
   * `CREATED_AT` is preserved on update; `EXPIRES_AT` is derived from the TTL using
   * the database clock so it stays consistent with read-time refreshes.
   */
  private get mergeStoreSql(): string {
    return (
      `MERGE INTO ${this.storeRef} t USING (` +
      'SELECT ? "PREFIX", ? "KEY", ? "VALUE", ' +
      "CASE WHEN ? IS NULL THEN NULL " +
      "ELSE ADD_SECONDS(CURRENT_UTCTIMESTAMP, CAST(? AS DOUBLE) * 60) END " +
      '"EXPIRES_AT", ' +
      '? "TTL_MINUTES" FROM DUMMY) s ' +
      'ON (t."PREFIX" = s."PREFIX" AND t."KEY" = s."KEY") ' +
      'WHEN MATCHED THEN UPDATE SET t."VALUE" = s."VALUE", ' +
      't."UPDATED_AT" = CURRENT_UTCTIMESTAMP, ' +
      't."EXPIRES_AT" = s."EXPIRES_AT", t."TTL_MINUTES" = s."TTL_MINUTES" ' +
      'WHEN NOT MATCHED THEN INSERT ("PREFIX", "KEY", "VALUE", ' +
      '"CREATED_AT", "UPDATED_AT", "EXPIRES_AT", "TTL_MINUTES") VALUES (' +
      's."PREFIX", s."KEY", s."VALUE", CURRENT_UTCTIMESTAMP, ' +
      'CURRENT_UTCTIMESTAMP, s."EXPIRES_AT", s."TTL_MINUTES")'
    );
  }

  private get deleteStoreSql(): string {
    return `DELETE FROM ${this.storeRef} WHERE "PREFIX" = ? AND "KEY" = ?`;
  }

  private get deleteVectorsSql(): string {
    return `DELETE FROM ${this.vectorsRef} WHERE "PREFIX" = ? AND "KEY" = ?`;
  }

  protected get insertVectorSql(): string {
    return (
      `INSERT INTO ${this.vectorsRef} ` +
      '("PREFIX", "KEY", "FIELD_NAME", "EMBEDDING") VALUES (?, ?, ?, ?)'
    );
  }

  /**
   * `("PREFIX" = ? OR "PREFIX" LIKE ? ESCAPE '\\')` + params for a prefix.
   *
   * Matches the namespace itself and any descendant namespace, with LIKE
   * metacharacters in the prefix escaped so they are treated literally.
   *
   * An empty prefix is a prefix of every namespace, so it matches all items: the
   * clause is a no-op (`1=1`) rather than `"PREFIX" = '' OR ... LIKE '.%'`, which
   * would match nothing (no real item has an empty or dot-leading prefix).
   */
  private searchNamespaceClause(
    prefix: string[],
    alias = ""
  ): [string, HanaParameterType[]] {
    if (prefix.length === 0) {
      return ["1=1", []];
    }
    const col = alias ? `${alias}."PREFIX"` : '"PREFIX"';
    const prefixText = HanaStore.namespaceToText(prefix);
    const like = `${HanaStore.escapeLike(prefixText)}.%`;
    return [`(${col} = ? OR ${col} LIKE ? ESCAPE '\\')`, [prefixText, like]];
  }

  /** Metadata (non-vector) search SQL. Fetches an item's namespace too. */
  private searchSql(
    prefix: string[],
    orderedLimited: boolean,
    limit: number,
    offset: number
  ): [string, HanaParameterType[]] {
    const [clause, params] = this.searchNamespaceClause(prefix);
    let sql =
      `SELECT "PREFIX", "KEY", ${ITEM_COLS} FROM ${this.storeRef} ` +
      `WHERE ${clause}${this.notExpiredClause} ` +
      'ORDER BY "UPDATED_AT" DESC';
    if (orderedLimited) {
      sql += ` LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`;
    }
    return [sql, params];
  }

  /**
   * Vector search SQL: best cosine similarity per item, newest-first ties.
   *
   * The returned `params` are only the namespace-prefix params; the handler supplies
   * the leading query-embedding param, bound as one string literal wrapped in the
   * `TO_<vectorColumnType>` conversion matching the stored column. `VALUE` is an
   * NCLOB and cannot be grouped, so similarity is aggregated per `(PREFIX, KEY)` in a
   * sub-select and then joined back to the store.
   */
  protected vectorSearchSql(prefix: string[]): [string, HanaParameterType[]] {
    const [clause, params] = this.searchNamespaceClause(prefix, "s");
    const toQueryVec = this.queryVectorExpr();
    const sql =
      "WITH scored AS (" +
      'SELECT "PREFIX", "KEY", ' +
      `MAX(COSINE_SIMILARITY("EMBEDDING", ${toQueryVec})) AS "SCORE" ` +
      `FROM ${this.vectorsRef} GROUP BY "PREFIX", "KEY") ` +
      'SELECT s."PREFIX", s."KEY", s."VALUE", s."CREATED_AT", ' +
      's."UPDATED_AT", sc."SCORE" ' +
      `FROM ${this.storeRef} s ` +
      'JOIN scored sc ON s."PREFIX" = sc."PREFIX" AND s."KEY" = sc."KEY" ' +
      `WHERE ${clause}${this.notExpiredClause} ` +
      'ORDER BY sc."SCORE" DESC, s."UPDATED_AT" DESC';
    return [sql, params];
  }

  /** SQL expression (with placeholders) producing the query embedding vector. */
  protected queryVectorExpr(): string {
    return `TO_${this.vectorColumnType}(?)`;
  }

  private get listNamespacesSql(): string {
    let sql = `SELECT DISTINCT "PREFIX" FROM ${this.storeRef}`;
    if (this.omitExpired) {
      // Strip the leading " AND " from the shared clause to start a WHERE.
      sql += ` WHERE ${this.notExpiredClause.slice(" AND ".length)}`;
    }
    return sql;
  }

  private get sweepStoreSql(): string {
    return (
      `DELETE FROM ${this.storeRef} ` +
      'WHERE "EXPIRES_AT" IS NOT NULL AND "EXPIRES_AT" < CURRENT_UTCTIMESTAMP'
    );
  }

  /** Delete embeddings whose item no longer exists (post-sweep cleanup). */
  private get sweepVectorsSql(): string {
    return (
      `DELETE FROM ${this.vectorsRef} v WHERE NOT EXISTS (` +
      `SELECT 1 FROM ${this.storeRef} s ` +
      'WHERE s."PREFIX" = v."PREFIX" AND s."KEY" = v."KEY")'
    );
  }

  // ------------------------------------------------------------------ #
  // Pure helpers
  // ------------------------------------------------------------------ #
  private static namespaceToText(namespace: string[]): string {
    return namespace.join(".");
  }

  private static decodeNs(text: string): string[] {
    return text.split(".");
  }

  private static escapeLike(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
  }

  private static rowToItem(namespace: string[], row: Row): Item {
    return {
      value: JSON.parse(row.VALUE),
      key: row.KEY,
      namespace,
      createdAt: new Date(row.CREATED_AT),
      updatedAt: new Date(row.UPDATED_AT),
    };
  }

  private static rowToSearchItem(row: Row): SearchItem {
    const score = row.SCORE;
    return {
      namespace: HanaStore.decodeNs(row.PREFIX),
      key: row.KEY,
      value: JSON.parse(row.VALUE),
      createdAt: new Date(row.CREATED_AT),
      updatedAt: new Date(row.UPDATED_AT),
      score: score !== undefined && score !== null ? Number(score) : undefined,
    };
  }

  /** Render a vector as the `'[v1,v2,...]'` literal for `TO_REAL_VECTOR`. */
  private static vectorToStr(values: number[]): string {
    return `[${values.map((v) => String(v)).join(",")}]`;
  }

  /** Collapse puts on the same `(namespace, key)` keeping the last one. */
  private static dedupePutOps(
    putOps: [number, PutOperation][]
  ): Map<string, PutOperation> {
    const out = new Map<string, PutOperation>();
    for (const [, op] of putOps) {
      out.set(`${HanaStore.namespaceToText(op.namespace)}\u0000${op.key}`, op);
    }
    return out;
  }

  /** Return `(fieldName, text)` pairs to embed for an indexed put. */
  private extractIndexTexts(op: PutOperation): [string, string][] {
    if (
      op.value === null ||
      this.indexConfig === undefined ||
      op.index === false
    ) {
      return [];
    }
    const paths = op.index && op.index.length > 0 ? op.index : this.indexFields;
    const pairs: [string, string][] = [];
    for (const path of paths) {
      const texts = getTextAtPath(op.value, path);
      if (texts.length === 1) {
        pairs.push([path, texts[0]]);
      } else {
        texts.forEach((text, i) => pairs.push([`${path}[${i}]`, text]));
      }
    }
    return pairs;
  }

  private static finalizeSearch(
    op: SearchOperation,
    candidates: SearchItem[]
  ): SearchItem[] {
    const matched = candidates.filter((item) =>
      HanaStore.matchesFilter(item.value, op.filter)
    );
    const offset = op.offset ?? 0;
    const limit = op.limit ?? 10;
    return matched.slice(offset, offset + limit);
  }

  // -- metadata filtering (mirrors InMemoryStore) --------------------- #
  private static matchesFilter(
    value: Record<string, unknown>,
    filter?: Record<string, unknown>
  ): boolean {
    if (!filter || Object.keys(filter).length === 0) {
      return true;
    }
    return Object.entries(filter).every(([key, fval]) =>
      HanaStore.compareValues(value?.[key], fval)
    );
  }

  private static compareValues(
    itemValue: unknown,
    filterValue: unknown
  ): boolean {
    if (
      filterValue !== null &&
      typeof filterValue === "object" &&
      !Array.isArray(filterValue)
    ) {
      const entries = Object.entries(filterValue as Record<string, unknown>);
      if (entries.some(([k]) => k.startsWith("$"))) {
        return entries.every(([opKey, opValue]) =>
          HanaStore.applyOperator(itemValue, opKey, opValue)
        );
      }
      if (itemValue === null || typeof itemValue !== "object") {
        return false;
      }
      return entries.every(([k, v]) =>
        HanaStore.compareValues((itemValue as Record<string, unknown>)[k], v)
      );
    }
    if (Array.isArray(filterValue)) {
      return (
        Array.isArray(itemValue) &&
        itemValue.length === filterValue.length &&
        filterValue.every((fv, i) => HanaStore.compareValues(itemValue[i], fv))
      );
    }
    return itemValue === filterValue;
  }

  private static applyOperator(
    value: unknown,
    operator: string,
    opValue: unknown
  ): boolean {
    switch (operator) {
      case "$eq":
        return value === opValue;
      case "$ne":
        return value !== opValue;
      case "$gt":
        return Number(value) > Number(opValue);
      case "$gte":
        return Number(value) >= Number(opValue);
      case "$lt":
        return Number(value) < Number(opValue);
      case "$lte":
        return Number(value) <= Number(opValue);
      default:
        throw new Error(
          `Unsupported operator: ${operator}. Supported: ${FILTER_OPERATORS.join(", ")}`
        );
    }
  }

  // -- namespace listing ---------------------------------------------- #
  private static doesMatch(condition: MatchCondition, key: string[]): boolean {
    const path = condition.path;
    if (key.length < path.length) {
      return false;
    }
    let pairs: [string, string][];
    if (condition.matchType === "prefix") {
      pairs = path.map((p, i) => [key[i], p]);
    } else if (condition.matchType === "suffix") {
      pairs = path.map((p, i) => [key[key.length - path.length + i], p]);
    } else {
      throw new Error(`Unsupported match type: ${condition.matchType}`);
    }
    return pairs.every(([k, p]) => p === "*" || k === p);
  }

  private static filterNamespaces(
    prefixes: string[],
    op: ListNamespacesOperation
  ): string[][] {
    const conditions = op.matchConditions ?? [];
    const seen = new Set<string>();
    const namespaces: string[][] = [];
    for (const prefix of prefixes) {
      let ns = HanaStore.decodeNs(prefix);
      if (!conditions.every((c) => HanaStore.doesMatch(c, ns))) {
        continue;
      }
      if (op.maxDepth !== undefined) {
        ns = ns.slice(0, op.maxDepth);
      }
      const nsKey = ns.join("\u0000");
      if (!seen.has(nsKey)) {
        seen.add(nsKey);
        namespaces.push(ns);
      }
    }
    namespaces.sort((a, b) => a.join(".").localeCompare(b.join(".")));
    const offset = op.offset ?? 0;
    const limit = op.limit ?? 100;
    return namespaces.slice(offset, offset + limit);
  }

  // ------------------------------------------------------------------ #
  // Connection / transaction helpers
  // ------------------------------------------------------------------ #
  private async ensureSetup(): Promise<void> {
    if (!this.ensureTables) {
      return;
    }
    if (!this.setupPromise) {
      this.setupPromise = this.setup();
    }
    await this.setupPromise;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.lock.acquire();
    try {
      const result = await fn();
      await commit(this.connection);
      return result;
    } catch (error) {
      await rollback(this.connection);
      throw error;
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------------ #
  // Setup / lifecycle
  // ------------------------------------------------------------------ #
  /**
   * Apply any not-yet-applied schema migrations (idempotent). The vectors table is
   * created on demand when an `index` configuration is present. Validates vector
   * datatype availability in later PRs.
   */
  async setup(): Promise<void> {
    const migrations = this.migrations();
    await this.withLock(async () => {
      if (
        !(await tableExists(
          this.connection,
          this.migrationsTable,
          this.schemaName
        ))
      ) {
        await executeQuery(this.connection, migrations[0]);
        const stmt = await prepareQuery(this.connection, this.insertVersionSql);
        await executeStatement(stmt, [0]);
      }
      const rows: Row[] = await executeQuery(
        this.connection,
        `SELECT MAX("V") AS "V" FROM ${this.migrationsRef}`
      );
      const version =
        rows && rows.length > 0 && rows[0].V !== null ? Number(rows[0].V) : -1;
      for (let v = version + 1; v < migrations.length; v += 1) {
        await executeQuery(this.connection, migrations[v]);
        const stmt = await prepareQuery(this.connection, this.insertVersionSql);
        await executeStatement(stmt, [v]);
      }
      if (
        this.indexConfig !== undefined &&
        !(await tableExists(
          this.connection,
          this.vectorsTable,
          this.schemaName
        ))
      ) {
        await this.validateVectorSetup();
        await executeQuery(this.connection, this.vectorsDdl());
      }
    });
    if (this.ttlConfig?.sweepIntervalMinutes) {
      this.startTtlSweeper();
    }
  }

  /**
   * Validate that the configured vector column type is available on the instance.
   * Extended in a later PR with the internal-embedding model probe.
   */
  protected async validateVectorSetup(): Promise<void> {
    await validateDatatypeSupport(this.connection, this.vectorColumnType);
  }

  /** Start the store (runs `setup()` when `ensureTables` is enabled). */
  async start(): Promise<void> {
    await this.ensureSetup();
  }

  /** Stop the store: stop the background TTL sweeper. */
  async stop(): Promise<void> {
    this.stopTtlSweeper();
  }

  // ------------------------------------------------------------------ #
  // Batch entrypoint
  // ------------------------------------------------------------------ #
  async batch<Op extends Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    await this.ensureSetup();
    const results: unknown[] = new Array(operations.length).fill(undefined);
    const puts: [number, PutOperation][] = [];
    const gets: [number, GetOperation][] = [];
    const searches: [number, SearchOperation][] = [];
    const lists: [number, ListNamespacesOperation][] = [];
    operations.forEach((op, idx) => {
      if ("namespacePrefix" in op) {
        searches.push([idx, op]);
      } else if ("key" in op && !("value" in op)) {
        gets.push([idx, op]);
      } else if ("value" in op) {
        puts.push([idx, op]);
      } else {
        lists.push([idx, op as ListNamespacesOperation]);
      }
    });
    await this.withLock(async () => {
      // Puts first so a get/search later in the same batch sees them.
      if (puts.length > 0) {
        await this.batchPut(puts);
      }
      if (gets.length > 0) {
        await this.batchGet(gets, results);
      }
      if (searches.length > 0) {
        await this.batchSearch(searches, results);
      }
      if (lists.length > 0) {
        await this.batchList(lists, results);
      }
    });
    return results as OperationResults<Op>;
  }

  // ------------------------------------------------------------------ #
  // Per-type handlers
  // ------------------------------------------------------------------ #
  private async batchGet(
    getOps: [number, GetOperation][],
    results: unknown[]
  ): Promise<void> {
    const byNs = new Map<string, [number, GetOperation][]>();
    for (const [idx, op] of getOps) {
      const nsText = HanaStore.namespaceToText(op.namespace);
      if (!byNs.has(nsText)) {
        byNs.set(nsText, []);
      }
      byNs.get(nsText)!.push([idx, op]);
    }
    const refreshOnRead = this.ttlConfig?.refreshOnRead ?? true;
    for (const [nsText, items] of byNs) {
      const namespace = HanaStore.decodeNs(nsText);
      const keys = items.map(([, op]) => op.key);
      const stmt = await prepareQuery(
        this.connection,
        this.getSql(keys.length)
      );
      const rows: Row[] = await executeStatement(stmt, [nsText, ...keys]);
      const found = new Map<string, Item>();
      for (const row of Array.isArray(rows) ? rows : []) {
        found.set(row.KEY, HanaStore.rowToItem(namespace, row));
      }
      for (const [idx, op] of items) {
        results[idx] = found.get(op.key) ?? null;
      }
      if (this.omitExpired && refreshOnRead) {
        const refreshKeys = items
          .map(([, op]) => op.key)
          .filter((k) => found.has(k));
        if (refreshKeys.length > 0) {
          await this.refreshTtl(nsText, refreshKeys);
        }
      }
    }
  }

  private async batchPut(putOps: [number, PutOperation][]): Promise<void> {
    const deduped = HanaStore.dedupePutOps(putOps);
    const indexRows: [string, string, string][] = [];
    const indexTexts: string[] = [];
    for (const [compositeKey, op] of deduped) {
      const sepIndex = compositeKey.indexOf("\u0000");
      const prefix = compositeKey.slice(0, sepIndex);
      const key = compositeKey.slice(sepIndex + 1);
      if (op.value === null) {
        const delStmt = await prepareQuery(
          this.connection,
          this.deleteStoreSql
        );
        await executeStatement(delStmt, [prefix, key]);
        if (this.indexConfig !== undefined) {
          const delVecStmt = await prepareQuery(
            this.connection,
            this.deleteVectorsSql
          );
          await executeStatement(delVecStmt, [prefix, key]);
        }
        continue;
      }
      const ttl = this.resolveTtl(op);
      const mergeStmt = await prepareQuery(this.connection, this.mergeStoreSql);
      await executeStatement(mergeStmt, [
        prefix,
        key,
        JSON.stringify(op.value),
        ttl,
        ttl,
        ttl,
      ]);
      if (this.indexConfig !== undefined) {
        // Replace any previous embeddings for this item.
        const delVecStmt = await prepareQuery(
          this.connection,
          this.deleteVectorsSql
        );
        await executeStatement(delVecStmt, [prefix, key]);
        for (const [field, text] of this.extractIndexTexts(op)) {
          indexRows.push([prefix, key, field]);
          indexTexts.push(text);
        }
      }
    }
    if (indexTexts.length > 0) {
      await this.insertEmbeddings(indexRows, indexTexts);
    }
  }

  /** Embed the indexed texts and insert one vector row per field. */
  protected async insertEmbeddings(
    indexRows: [string, string, string][],
    indexTexts: string[]
  ): Promise<void> {
    if (this.indexConfig === undefined) {
      return;
    }
    const vectors =
      await this.indexConfig.embeddings.embedDocuments(indexTexts);
    const params: HanaParameterType[][] = indexRows.map((row, i) => [
      ...row,
      serializeVector(vectors[i], this.vectorColumnType),
    ]);
    const stmt = await prepareQuery(this.connection, this.insertVectorSql);
    await executeBatchStatement(stmt, params);
  }

  private async batchSearch(
    searchOps: [number, SearchOperation][],
    results: unknown[]
  ): Promise<void> {
    for (const [idx, op] of searchOps) {
      const useVector = Boolean(op.query) && this.indexConfig !== undefined;
      let candidates: SearchItem[];
      if (useVector) {
        const [sql, params] = this.vectorSearchSql(op.namespacePrefix);
        const embedParams = await this.queryEmbeddingParams(op.query as string);
        const stmt = await prepareQuery(this.connection, sql);
        const rows: Row[] = await executeStatement(stmt, [
          ...embedParams,
          ...params,
        ]);
        candidates = (Array.isArray(rows) ? rows : []).map((row) =>
          HanaStore.rowToSearchItem(row)
        );
      } else {
        const simple = op.filter === undefined;
        const [sql, params] = this.searchSql(
          op.namespacePrefix,
          simple,
          op.limit ?? 10,
          op.offset ?? 0
        );
        const stmt = await prepareQuery(this.connection, sql);
        const rows: Row[] = await executeStatement(stmt, params);
        candidates = (Array.isArray(rows) ? rows : []).map((row) =>
          HanaStore.rowToSearchItem(row)
        );
        if (simple) {
          results[idx] = candidates;
          await this.refreshSearchTtl(op, candidates);
          continue;
        }
      }
      const page = HanaStore.finalizeSearch(op, candidates);
      results[idx] = page;
      await this.refreshSearchTtl(op, page);
    }
  }

  /** Params (excluding namespace params) for the query-embedding expression. */
  protected async queryEmbeddingParams(
    query: string
  ): Promise<HanaParameterType[]> {
    const queryVec = await this.indexConfig!.embeddings.embedQuery(query);
    return [HanaStore.vectorToStr(queryVec)];
  }

  private async refreshSearchTtl(
    op: SearchOpWithRefresh,
    items: SearchItem[]
  ): Promise<void> {
    const refresh = op.refreshTtl ?? this.ttlConfig?.refreshOnRead ?? true;
    if (!(this.omitExpired && refresh && items.length > 0)) {
      return;
    }
    const byNs = new Map<string, string[]>();
    for (const item of items) {
      const nsText = HanaStore.namespaceToText(item.namespace);
      if (!byNs.has(nsText)) {
        byNs.set(nsText, []);
      }
      byNs.get(nsText)!.push(item.key);
    }
    for (const [nsText, keys] of byNs) {
      await this.refreshTtl(nsText, keys);
    }
  }

  private async refreshTtl(nsText: string, keys: string[]): Promise<void> {
    const stmt = await prepareQuery(
      this.connection,
      this.refreshTtlSql(keys.length)
    );
    await executeStatement(stmt, [nsText, ...keys]);
  }

  private async batchList(
    listOps: [number, ListNamespacesOperation][],
    results: unknown[]
  ): Promise<void> {
    const rows: Row[] = await executeQuery(
      this.connection,
      this.listNamespacesSql
    );
    const prefixes = (Array.isArray(rows) ? rows : []).map((row) => row.PREFIX);
    for (const [idx, op] of listOps) {
      results[idx] = HanaStore.filterNamespaces(prefixes, op);
    }
  }

  private resolveTtl(op: PutOperation): number | null {
    const explicit = (op as PutOpWithOptions).options?.ttl;
    return explicit ?? this.ttlConfig?.defaultTtl ?? null;
  }

  // ------------------------------------------------------------------ #
  // Public overrides adding TTL options (Postgres-style)
  // ------------------------------------------------------------------ #
  async put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: false | string[],
    options?: { ttl?: number }
  ): Promise<void> {
    const op: PutOpWithOptions = { namespace, key, value, index, options };
    await this.batch([op]);
  }

  async search(
    namespacePrefix: string[],
    options?: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      query?: string;
      refreshTtl?: boolean;
    }
  ): Promise<SearchItem[]> {
    const { filter, limit = 10, offset = 0, query, refreshTtl } = options ?? {};
    const op: SearchOpWithRefresh = {
      namespacePrefix,
      filter,
      limit,
      offset,
      query,
      refreshTtl,
    };
    return (await this.batch([op]))[0];
  }

  // ------------------------------------------------------------------ #
  // TTL sweeping
  // ------------------------------------------------------------------ #
  /** Delete expired items (and their orphaned embeddings); returns row count. */
  async sweepExpiredItems(): Promise<number> {
    await this.ensureSetup();
    return this.withLock(async () => {
      const result = await executeQuery(this.connection, this.sweepStoreSql);
      const deleted = typeof result === "number" ? result : 0;
      if (this.indexConfig !== undefined) {
        await executeQuery(this.connection, this.sweepVectorsSql);
      }
      return deleted;
    });
  }

  /** Start a background interval that periodically sweeps expired items. */
  startTtlSweeper(): void {
    if (this.sweepTimer || !this.ttlConfig?.sweepIntervalMinutes) {
      return;
    }
    const ms = this.ttlConfig.sweepIntervalMinutes * 60 * 1000;
    this.sweepTimer = setInterval(() => {
      this.sweepExpiredItems().catch(() => {
        // Best-effort background sweep; errors are swallowed.
      });
    }, ms);
    // Do not keep the Node process alive just for the sweeper.
    this.sweepTimer.unref?.();
  }

  /** Stop the background TTL sweeper. */
  stopTtlSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
