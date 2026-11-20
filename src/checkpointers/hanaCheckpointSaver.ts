import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  getCheckpointId,
  maxChannelVersion,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";
import { Connection, HanaParameterType } from "@sap/hana-client";
import {
  Mutex,
  commit,
  executeBatchStatement,
  executeQuery,
  executeStatement,
  getTableRef,
  jsonValue,
  prepareQuery,
  rollback,
  sanitizeName,
  tableExists,
  validateIdentifier,
} from "../hanautils.js";

export const DEFAULT_MIGRATIONS_TABLE = "LANGGRAPH_CHECKPOINT_MIGRATIONS";
export const DEFAULT_CHECKPOINTS_TABLE = "LANGGRAPH_CHECKPOINTS";
export const DEFAULT_BLOBS_TABLE = "LANGGRAPH_CHECKPOINT_BLOBS";
export const DEFAULT_WRITES_TABLE = "LANGGRAPH_CHECKPOINT_WRITES";

// Bounded identifier lengths keep the composite primary keys within HANA's index
// key-length limit. CHANNEL and VERSION are part of the blobs table primary key, so
// they are kept shorter than the (non-key) writes CHANNEL column.
const ID_LEN = 256;
const NS_LEN = 256;
const CHANNEL_LEN = 1024;
const BLOB_CHANNEL_LEN = 512;
const VERSION_LEN = 256;
const TYPE_LEN = 128;
const TASK_PATH_LEN = 1024;

/**
 * Configuration options for a {@link HanaCheckpointSaver}.
 */
export interface HanaCheckpointSaverArgs {
  /** An open `@sap/hana-client` database connection. */
  connection: Connection;
  /** Optional serializer. Defaults to langgraph's `JsonPlusSerializer`. */
  serde?: SerializerProtocol;
  /** Optional schema; defaults to the connection's current schema. */
  schemaName?: string;
  /** Name of the migrations (version ledger) table. */
  migrationsTable?: string;
  /** Name of the checkpoints table. */
  checkpointsTable?: string;
  /** Name of the per-channel blobs table. */
  blobsTable?: string;
  /** Name of the pending-writes table. */
  writesTable?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * A LangGraph checkpointer backed by SAP HANA Cloud.
 *
 * `HanaCheckpointSaver` persists LangGraph checkpoints, deduplicated per-channel
 * blobs, metadata and pending writes in SAP HANA Cloud, following the design of
 * langgraph's Postgres saver. Node I/O is asynchronous throughout, so the single
 * class covers what the Python package splits into sync and async savers.
 *
 * Four tables are used: a migrations (version ledger) table, a checkpoints table
 * holding the checkpoint skeleton + metadata, a blobs table holding each channel
 * value keyed by `(thread_id, checkpoint_ns, channel, version)` (so identical
 * `(channel, version)` values are written once and reused — de-duplication), and a
 * writes table holding pending (intermediate) writes.
 *
 * @example
 * ```ts
 * import hanaClient from "@sap/hana-client";
 * import { HanaCheckpointSaver } from "@sap/hana-langchain";
 *
 * const connection = hanaClient.createConnection();
 * connection.connect({ host, port, uid, pwd });
 * const checkpointer = new HanaCheckpointSaver({ connection });
 * await checkpointer.setup();
 * const graph = builder.compile({ checkpointer });
 * await graph.invoke(inputs, { configurable: { thread_id: "1" } });
 * ```
 */
export class HanaCheckpointSaver extends BaseCheckpointSaver {
  private connection: Connection;

  private schemaName: string;

  private migrationsTable: string;

  private checkpointsTable: string;

  private blobsTable: string;

  private writesTable: string;

  private lock = new Mutex();

  private setupPromise?: Promise<void>;

  constructor(args: HanaCheckpointSaverArgs) {
    super(args.serde);
    this.connection = args.connection;
    this.schemaName = args.schemaName ? sanitizeName(args.schemaName) : "";
    this.migrationsTable = sanitizeName(
      args.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE
    );
    this.checkpointsTable = sanitizeName(
      args.checkpointsTable ?? DEFAULT_CHECKPOINTS_TABLE
    );
    this.blobsTable = sanitizeName(args.blobsTable ?? DEFAULT_BLOBS_TABLE);
    this.writesTable = sanitizeName(args.writesTable ?? DEFAULT_WRITES_TABLE);
    if (
      !this.migrationsTable ||
      !this.checkpointsTable ||
      !this.blobsTable ||
      !this.writesTable
    ) {
      throw new Error("Table names must not be empty after sanitization.");
    }
    // Disable autocommit so write operations commit atomically as a unit.
    this.connection.setAutoCommit(false);
  }

  // ------------------------------------------------------------------ #
  // SQL identifiers / schema
  // ------------------------------------------------------------------ #
  private get migrationsRef(): string {
    return getTableRef(this.migrationsTable, this.schemaName);
  }

  private get checkpointsRef(): string {
    return getTableRef(this.checkpointsTable, this.schemaName);
  }

  private get blobsRef(): string {
    return getTableRef(this.blobsTable, this.schemaName);
  }

  private get writesRef(): string {
    return getTableRef(this.writesTable, this.schemaName);
  }

  /** Ordered DDL statements. Index 0 creates the migrations ledger itself. */
  private migrations(): string[] {
    const migrationsDdl = `CREATE TABLE ${this.migrationsRef} ("V" INTEGER PRIMARY KEY)`;
    const checkpointsDdl =
      `CREATE TABLE ${this.checkpointsRef} (` +
      `"THREAD_ID" NVARCHAR(${ID_LEN}) NOT NULL, ` +
      `"CHECKPOINT_NS" NVARCHAR(${NS_LEN}) DEFAULT '' NOT NULL, ` +
      `"CHECKPOINT_ID" NVARCHAR(${ID_LEN}) NOT NULL, ` +
      `"PARENT_CHECKPOINT_ID" NVARCHAR(${ID_LEN}), ` +
      `"TYPE" NVARCHAR(${TYPE_LEN}), ` +
      '"CHECKPOINT" BLOB, ' +
      '"METADATA" NCLOB, ' +
      'PRIMARY KEY ("THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID"))';
    const blobsDdl =
      `CREATE TABLE ${this.blobsRef} (` +
      `"THREAD_ID" NVARCHAR(${ID_LEN}) NOT NULL, ` +
      `"CHECKPOINT_NS" NVARCHAR(${NS_LEN}) DEFAULT '' NOT NULL, ` +
      `"CHANNEL" NVARCHAR(${BLOB_CHANNEL_LEN}) NOT NULL, ` +
      `"VERSION" NVARCHAR(${VERSION_LEN}) NOT NULL, ` +
      `"TYPE" NVARCHAR(${TYPE_LEN}) NOT NULL, ` +
      '"BLOB" BLOB, ' +
      'PRIMARY KEY ("THREAD_ID", "CHECKPOINT_NS", "CHANNEL", "VERSION"))';
    const writesDdl =
      `CREATE TABLE ${this.writesRef} (` +
      `"THREAD_ID" NVARCHAR(${ID_LEN}) NOT NULL, ` +
      `"CHECKPOINT_NS" NVARCHAR(${NS_LEN}) DEFAULT '' NOT NULL, ` +
      `"CHECKPOINT_ID" NVARCHAR(${ID_LEN}) NOT NULL, ` +
      `"TASK_ID" NVARCHAR(${ID_LEN}) NOT NULL, ` +
      `"TASK_PATH" NVARCHAR(${TASK_PATH_LEN}) DEFAULT '' NOT NULL, ` +
      '"IDX" INTEGER NOT NULL, ' +
      `"CHANNEL" NVARCHAR(${CHANNEL_LEN}) NOT NULL, ` +
      `"TYPE" NVARCHAR(${TYPE_LEN}), ` +
      '"VALUE" BLOB, ' +
      'PRIMARY KEY ("THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID", ' +
      '"TASK_ID", "IDX"))';
    return [migrationsDdl, checkpointsDdl, blobsDdl, writesDdl];
  }

  private get insertVersionSql(): string {
    return `INSERT INTO ${this.migrationsRef} ("V") VALUES (?)`;
  }

  private get selectCheckpointSql(): string {
    return (
      'SELECT "THREAD_ID", "CHECKPOINT_ID", "PARENT_CHECKPOINT_ID", "TYPE", ' +
      `"CHECKPOINT", "METADATA" FROM ${this.checkpointsRef} `
    );
  }

  private listCheckpointsSql(whereClause: string, limit?: number): string {
    let sql =
      'SELECT "THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID", ' +
      '"PARENT_CHECKPOINT_ID", "TYPE", "CHECKPOINT", "METADATA" FROM ' +
      `${this.checkpointsRef} ${whereClause} ORDER BY "CHECKPOINT_ID" DESC`;
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("Parameter 'limit' must be a positive integer.");
      }
      sql += ` LIMIT ${Math.trunc(limit)}`;
    }
    return sql;
  }

  /** SQL + params to fetch the blob rows matching a `channelVersions` map. */
  private blobQuery(
    threadId: string,
    checkpointNs: string,
    channelVersions: Record<string, string | number>
  ): [string, HanaParameterType[]] {
    const entries = Object.entries(channelVersions);
    const orClauses = entries
      .map(() => '("CHANNEL" = ? AND "VERSION" = ?)')
      .join(" OR ");
    const sql =
      `SELECT "CHANNEL", "TYPE", "BLOB" FROM ${this.blobsRef} ` +
      `WHERE "THREAD_ID" = ? AND "CHECKPOINT_NS" = ? AND (${orClauses})`;
    const params: HanaParameterType[] = [threadId, checkpointNs];
    for (const [channel, version] of entries) {
      params.push(channel, String(version));
    }
    return [sql, params];
  }

  /** SQL to fetch the writes attached to a single checkpoint. */
  private pendingWritesSql(): string {
    return (
      'SELECT "TASK_ID", "CHANNEL", "TYPE", "VALUE", "TASK_PATH", "IDX" FROM ' +
      `${this.writesRef} ` +
      'WHERE "THREAD_ID" = ? AND "CHECKPOINT_NS" = ? AND "CHECKPOINT_ID" = ?'
    );
  }

  /** SQL to fetch a checkpoint's writes to a single channel (for pending-sends). */
  private channelWritesSql(): string {
    return (
      'SELECT "TYPE", "VALUE", "TASK_ID", "TASK_PATH", "IDX" FROM ' +
      `${this.writesRef} ` +
      'WHERE "THREAD_ID" = ? AND "CHECKPOINT_NS" = ? AND "CHECKPOINT_ID" = ? ' +
      'AND "CHANNEL" = ?'
    );
  }

  /**
   * MERGE that inserts a blob row only if its primary key is absent. Identical
   * `(channel, version)` values are therefore written once and reused across
   * checkpoints (first-write-wins de-duplication).
   */
  private upsertBlobsSql(): string {
    const cols =
      '"THREAD_ID", "CHECKPOINT_NS", "CHANNEL", "VERSION", "TYPE", "BLOB"';
    return (
      `MERGE INTO ${this.blobsRef} t USING (` +
      'SELECT ? "THREAD_ID", ? "CHECKPOINT_NS", ? "CHANNEL", ? "VERSION", ' +
      '? "TYPE", ? "BLOB" FROM DUMMY) s ' +
      'ON (t."THREAD_ID" = s."THREAD_ID" ' +
      'AND t."CHECKPOINT_NS" = s."CHECKPOINT_NS" ' +
      'AND t."CHANNEL" = s."CHANNEL" AND t."VERSION" = s."VERSION") ' +
      `WHEN NOT MATCHED THEN INSERT (${cols}) VALUES (` +
      's."THREAD_ID", s."CHECKPOINT_NS", s."CHANNEL", s."VERSION", ' +
      's."TYPE", s."BLOB")'
    );
  }

  private get upsertCheckpointSql(): string {
    return (
      `UPSERT ${this.checkpointsRef} ` +
      '("THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID", ' +
      '"PARENT_CHECKPOINT_ID", "TYPE", "CHECKPOINT", "METADATA") ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY"
    );
  }

  /** SQL for `putWrites`: UPSERT (replace) or MERGE (insert-if-absent). */
  private putWritesSql(upsert: boolean): string {
    const cols =
      '"THREAD_ID", "CHECKPOINT_NS", "CHECKPOINT_ID", "TASK_ID", "TASK_PATH", ' +
      '"IDX", "CHANNEL", "TYPE", "VALUE"';
    if (upsert) {
      // Replace: special control-channel writes may legitimately overwrite.
      return (
        `UPSERT ${this.writesRef} (${cols}) ` +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY"
      );
    }
    // Ignore (insert-if-absent): preserve the first write for each pk.
    return (
      `MERGE INTO ${this.writesRef} t USING (` +
      'SELECT ? "THREAD_ID", ? "CHECKPOINT_NS", ? "CHECKPOINT_ID", ' +
      '? "TASK_ID", ? "TASK_PATH", ? "IDX", ? "CHANNEL", ? "TYPE", ' +
      '? "VALUE" FROM DUMMY) s ' +
      'ON (t."THREAD_ID" = s."THREAD_ID" ' +
      'AND t."CHECKPOINT_NS" = s."CHECKPOINT_NS" ' +
      'AND t."CHECKPOINT_ID" = s."CHECKPOINT_ID" ' +
      'AND t."TASK_ID" = s."TASK_ID" AND t."IDX" = s."IDX") ' +
      `WHEN NOT MATCHED THEN INSERT (${cols}) VALUES (` +
      's."THREAD_ID", s."CHECKPOINT_NS", s."CHECKPOINT_ID", s."TASK_ID", ' +
      's."TASK_PATH", s."IDX", s."CHANNEL", s."TYPE", s."VALUE")'
    );
  }

  /** DELETE statements removing a thread's rows from every table. */
  private deleteThreadSql(): string[] {
    return [
      `DELETE FROM ${this.checkpointsRef} WHERE "THREAD_ID" = ?`,
      `DELETE FROM ${this.blobsRef} WHERE "THREAD_ID" = ?`,
      `DELETE FROM ${this.writesRef} WHERE "THREAD_ID" = ?`,
    ];
  }

  /**
   * Build `JSON_VALUE` WHERE predicates for a metadata filter.
   *
   * Only scalar filter values (and `null`) are supported, since HANA's `JSON_VALUE`
   * returns a scalar string.
   */
  private static metadataPredicate(
    metadataFilter: Record<string, unknown>
  ): [string[], HanaParameterType[]] {
    const predicates: string[] = [];
    const paramValues: HanaParameterType[] = [];
    for (const [queryKey, queryValue] of Object.entries(metadataFilter)) {
      validateIdentifier(queryKey);
      const jv = jsonValue('"METADATA"', queryKey);
      if (queryValue === null || queryValue === undefined) {
        predicates.push(`${jv} IS NULL`);
        continue;
      }
      let param: HanaParameterType;
      if (typeof queryValue === "boolean") {
        param = queryValue ? "true" : "false";
      } else if (
        typeof queryValue === "string" ||
        typeof queryValue === "number"
      ) {
        param = String(queryValue);
      } else {
        throw new Error(
          "HanaCheckpointSaver metadata filters only support scalar values " +
            `(string, number, boolean, null); got ${typeof queryValue} for ` +
            `key '${queryKey}'.`
        );
      }
      predicates.push(`${jv} = ?`);
      paramValues.push(param);
    }
    return [predicates, paramValues];
  }

  /** Return the WHERE clause (incl. the `WHERE` keyword) and its params. */
  private buildWhereClause(
    config?: RunnableConfig,
    filter?: Record<string, unknown>,
    before?: RunnableConfig
  ): [string, HanaParameterType[]] {
    const whereClauses: string[] = [];
    const paramValues: HanaParameterType[] = [];
    // The three config predicates are independent (mirrors the Postgres saver):
    // e.g. a list by checkpoint_ns with no thread_id must still filter by namespace.
    if (config?.configurable?.thread_id) {
      whereClauses.push('"THREAD_ID" = ?');
      paramValues.push(String(config.configurable.thread_id));
    }
    const checkpointNs = config?.configurable?.checkpoint_ns;
    if (checkpointNs !== undefined && checkpointNs !== null) {
      whereClauses.push('"CHECKPOINT_NS" = ?');
      paramValues.push(checkpointNs);
    }
    const checkpointId = config ? getCheckpointId(config) : undefined;
    if (checkpointId) {
      whereClauses.push('"CHECKPOINT_ID" = ?');
      paramValues.push(checkpointId);
    }
    if (filter && Object.keys(filter).length > 0) {
      const [predicates, values] =
        HanaCheckpointSaver.metadataPredicate(filter);
      whereClauses.push(...predicates);
      paramValues.push(...values);
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClauses.push('"CHECKPOINT_ID" < ?');
      paramValues.push(before.configurable.checkpoint_id);
    }
    return [
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "",
      paramValues,
    ];
  }

  // ------------------------------------------------------------------ #
  // Config / assembly helpers
  // ------------------------------------------------------------------ #
  private static threadNs(config: RunnableConfig): [string, string] {
    return [
      String(config.configurable?.thread_id),
      config.configurable?.checkpoint_ns ?? "",
    ];
  }

  private static configurable(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): RunnableConfig {
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
      },
    };
  }

  /** SQL + params for `getTuple`: fetch by id, or the thread's latest. */
  private getCheckpointQuery(
    config: RunnableConfig,
    threadId: string,
    checkpointNs: string
  ): [string, HanaParameterType[]] {
    const checkpointId = getCheckpointId(config);
    if (checkpointId) {
      const sql =
        this.selectCheckpointSql +
        'WHERE "THREAD_ID" = ? AND "CHECKPOINT_NS" = ? AND "CHECKPOINT_ID" = ?';
      return [sql, [threadId, checkpointNs, checkpointId]];
    }
    const sql =
      this.selectCheckpointSql +
      'WHERE "THREAD_ID" = ? AND "CHECKPOINT_NS" = ? ' +
      'ORDER BY "CHECKPOINT_ID" DESC LIMIT 1';
    return [sql, [threadId, checkpointNs]];
  }

  // ------------------------------------------------------------------ #
  // Serialization helpers
  // ------------------------------------------------------------------ #
  private static toBuffer(value: Uint8Array | null | undefined): Buffer | null {
    if (value === null || value === undefined) {
      return null;
    }
    return Buffer.from(value);
  }

  private loadMetadata(metadata: unknown): CheckpointMetadata {
    if (typeof metadata === "string" && metadata.length > 0) {
      return JSON.parse(metadata) as CheckpointMetadata;
    }
    return {} as CheckpointMetadata;
  }

  private async dumpMetadata(metadata: CheckpointMetadata): Promise<string> {
    const [, serialized] = await this.serde.dumpsTyped(metadata);
    // NCLOB must be valid JSON for JSON_VALUE filters; strip null chars HANA rejects.
    return new TextDecoder().decode(serialized).replace(/\0/g, "");
  }

  /** Shallow copy of a checkpoint with `channel_values` removed (offloaded to blobs). */
  private dumpCheckpoint(checkpoint: Checkpoint): Record<string, unknown> {
    const serialized: Record<string, unknown> = { ...checkpoint };
    delete serialized.channel_values;
    return serialized;
  }

  /**
   * Build blob rows for every channel in `versions`. Channels present in `values`
   * are serialized; channels only present in `versions` get an `"empty"` placeholder.
   */
  private async dumpBlobs(
    threadId: string,
    checkpointNs: string,
    values: Record<string, unknown>,
    versions: ChannelVersions
  ): Promise<HanaParameterType[][]> {
    const entries = Object.entries(versions);
    if (entries.length === 0) {
      return [];
    }
    return Promise.all(
      entries.map(async ([channel, version]) => {
        let type: string;
        let blob: Buffer | null;
        if (channel in values) {
          const [t, v] = await this.serde.dumpsTyped(values[channel]);
          type = t;
          blob = HanaCheckpointSaver.toBuffer(v);
        } else {
          type = "empty";
          blob = null;
        }
        return [
          threadId,
          checkpointNs,
          channel,
          String(version),
          type,
          blob,
        ] as HanaParameterType[];
      })
    );
  }

  /** Deserialize blob rows `(CHANNEL, TYPE, BLOB)`, skipping placeholders. */
  private async loadBlobs(rows: Row[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    await Promise.all(
      rows.map(async (row) => {
        const type = row.TYPE;
        if (type === null || type === undefined || type === "empty") {
          return;
        }
        result[row.CHANNEL as string] = await this.serde.loadsTyped(
          type,
          HanaCheckpointSaver.toBuffer(row.BLOB) ?? new Uint8Array()
        );
      })
    );
    return result;
  }

  /**
   * Deserialize `pendingWritesSql` rows ordered by `writesSortKey`.
   * Each row is `(TASK_ID, CHANNEL, TYPE, VALUE, TASK_PATH, IDX)`.
   */
  private async loadWrites(rows: Row[]): Promise<CheckpointPendingWrite[]> {
    const keyed = rows.map((row) => ({
      key: writesSortKey(
        (row.TASK_PATH as string) ?? "",
        row.TASK_ID as string,
        Number(row.IDX)
      ),
      row,
    }));
    keyed.sort((a, b) => compareWritesSortKeys(a.key, b.key));
    return Promise.all(
      keyed.map(
        async ({ row }) =>
          [
            row.TASK_ID as string,
            row.CHANNEL as string,
            await this.serde.loadsTyped(
              row.TYPE,
              HanaCheckpointSaver.toBuffer(row.VALUE) ?? new Uint8Array()
            ),
          ] as CheckpointPendingWrite
      )
    );
  }

  /**
   * One past the integer part of `current`, plus a random fraction. Blobs are
   * stored per channel and version, so two branches from one checkpoint that
   * minted the same version would share a blob; the random fraction avoids it.
   */
  getNextVersion(current: number | undefined): number {
    return Math.floor(super.getNextVersion(current)) + Math.random();
  }

  // ------------------------------------------------------------------ #
  // Connection / transaction helpers
  // ------------------------------------------------------------------ #
  private async ensureSetup(): Promise<void> {
    if (!this.setupPromise) {
      this.setupPromise = this.setup();
    }
    await this.setupPromise;
  }

  /** Run `fn` under the saver lock, committing on success and rolling back on error. */
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
  // Setup
  // ------------------------------------------------------------------ #
  /**
   * Apply any not-yet-applied schema migrations (idempotent).
   *
   * A migrations (version ledger) table records the highest migration index that
   * has been applied; only migrations after it are run. Called automatically on the
   * first operation, but may also be awaited explicitly.
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
    });
  }

  // ------------------------------------------------------------------ #
  // Reads
  // ------------------------------------------------------------------ #
  private async decodeCheckpoint(
    serdeType: string,
    checkpoint: Uint8Array
  ): Promise<Checkpoint> {
    return (await this.serde.loadsTyped(
      serdeType,
      HanaCheckpointSaver.toBuffer(checkpoint) ?? new Uint8Array()
    )) as Checkpoint;
  }

  private async loadCheckpoint(
    threadId: string,
    checkpointNs: string,
    serdeType: string,
    checkpoint: Uint8Array,
    parentCheckpointId?: string | null
  ): Promise<Checkpoint> {
    const checkpointValue = await this.decodeCheckpoint(serdeType, checkpoint);
    const channelVersions = (checkpointValue.channel_versions ?? {}) as Record<
      string,
      string | number
    >;
    if (Object.keys(channelVersions).length > 0) {
      const [sql, params] = this.blobQuery(
        threadId,
        checkpointNs,
        channelVersions
      );
      const stmt = await prepareQuery(this.connection, sql);
      const blobRows: Row[] = await executeStatement(stmt, params);
      checkpointValue.channel_values = {
        ...(checkpointValue.channel_values ?? {}),
        ...(await this.loadBlobs(Array.isArray(blobRows) ? blobRows : [])),
      };
    } else {
      checkpointValue.channel_values = checkpointValue.channel_values ?? {};
    }
    // Pre-v4 checkpoints stored `Send`s as pending writes on the parent; migrate
    // them into `channel_values[TASKS]` so old threads read back correctly.
    if ((checkpointValue.v ?? 0) < 4 && parentCheckpointId) {
      await this.migratePendingSends(
        checkpointValue,
        threadId,
        checkpointNs,
        parentCheckpointId
      );
    }
    return checkpointValue;
  }

  /** Migrate a pre-v4 parent's TASKS pending writes into `channel_values`. */
  private async migratePendingSends(
    checkpointValue: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string
  ): Promise<void> {
    const stmt = await prepareQuery(this.connection, this.channelWritesSql());
    const rows: Row[] = await executeStatement(stmt, [
      threadId,
      checkpointNs,
      parentCheckpointId,
      TASKS,
    ]);
    const sorted = (Array.isArray(rows) ? rows : [])
      .map((r) => ({
        key: writesSortKey(
          (r.TASK_PATH as string) ?? "",
          r.TASK_ID as string,
          Number(r.IDX)
        ),
        r,
      }))
      .sort((a, b) => compareWritesSortKeys(a.key, b.key));
    const sends = await Promise.all(
      sorted.map(({ r }) =>
        this.serde.loadsTyped(
          r.TYPE,
          HanaCheckpointSaver.toBuffer(r.VALUE) ?? new Uint8Array()
        )
      )
    );
    checkpointValue.channel_values = checkpointValue.channel_values ?? {};
    checkpointValue.channel_values[TASKS] = sends;
    const versions = (checkpointValue.channel_versions ?? {}) as Record<
      string,
      string | number
    >;
    checkpointValue.channel_versions = versions;
    versions[TASKS] =
      Object.keys(versions).length > 0
        ? maxChannelVersion(...Object.values(versions))
        : this.getNextVersion(undefined);
  }

  private async buildCheckpointTuple(
    threadId: string,
    checkpointNs: string,
    row: Row,
    checkpointValue: Checkpoint
  ): Promise<CheckpointTuple> {
    const checkpointId = String(row.CHECKPOINT_ID);
    const parentCheckpointId = row.PARENT_CHECKPOINT_ID;
    const writesStmt = await prepareQuery(
      this.connection,
      this.pendingWritesSql()
    );
    const writeRows: Row[] = await executeStatement(writesStmt, [
      threadId,
      checkpointNs,
      checkpointId,
    ]);
    return {
      config: HanaCheckpointSaver.configurable(
        threadId,
        checkpointNs,
        checkpointId
      ),
      checkpoint: checkpointValue,
      metadata: this.loadMetadata(row.METADATA),
      parentConfig: parentCheckpointId
        ? HanaCheckpointSaver.configurable(
            threadId,
            checkpointNs,
            String(parentCheckpointId)
          )
        : undefined,
      pendingWrites: await this.loadWrites(
        Array.isArray(writeRows) ? writeRows : []
      ),
    };
  }

  /** Fetch a checkpoint by id, or the latest for the thread, with its writes. */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.ensureSetup();
    const [threadId, checkpointNs] = HanaCheckpointSaver.threadNs(config);
    const [selectSql, selectParams] = this.getCheckpointQuery(
      config,
      threadId,
      checkpointNs
    );
    return this.withLock(async () => {
      const stmt = await prepareQuery(this.connection, selectSql);
      const rows: Row[] = await executeStatement(stmt, selectParams);
      if (!Array.isArray(rows) || rows.length === 0) {
        return undefined;
      }
      const row = rows[0];
      const checkpointValue = await this.loadCheckpoint(
        String(row.THREAD_ID),
        checkpointNs,
        row.TYPE,
        row.CHECKPOINT,
        row.PARENT_CHECKPOINT_ID
      );
      return this.buildCheckpointTuple(
        String(row.THREAD_ID),
        checkpointNs,
        row,
        checkpointValue
      );
    });
  }

  /**
   * Yield checkpoints scoped by `config` (thread/ns/id), newest-first.
   *
   * `filter` and `before` narrow further.
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    await this.ensureSetup();
    const { filter, before, limit } = options ?? {};
    const [whereClause, params] = this.buildWhereClause(config, filter, before);
    const listSql = this.listCheckpointsSql(whereClause, limit);
    const results = await this.withLock(async () => {
      const stmt = await prepareQuery(this.connection, listSql);
      const rows: Row[] = await executeStatement(stmt, params);
      const tuples: CheckpointTuple[] = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        const checkpointValue = await this.loadCheckpoint(
          String(row.THREAD_ID),
          String(row.CHECKPOINT_NS),
          row.TYPE,
          row.CHECKPOINT,
          row.PARENT_CHECKPOINT_ID
        );
        tuples.push(
          await this.buildCheckpointTuple(
            String(row.THREAD_ID),
            String(row.CHECKPOINT_NS),
            row,
            checkpointValue
          )
        );
      }
      return tuples;
    });
    for (const tuple of results) {
      yield tuple;
    }
  }

  // ------------------------------------------------------------------ #
  // Writes
  // ------------------------------------------------------------------ #
  /**
   * Persist a checkpoint and return its fully-qualified config.
   *
   * Channel values are offloaded to the blobs table (deduplicated per
   * `(channel, version)`); the checkpoint row stores only the skeleton + metadata.
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    await this.ensureSetup();
    if (config.configurable === undefined) {
      throw new Error('Missing "configurable" field in "config" param');
    }
    if (config.configurable.thread_id === undefined) {
      throw new Error(
        "Failed to put checkpoint. The passed RunnableConfig is missing a " +
          'required "thread_id" field in its "configurable" property.'
      );
    }
    const [threadId, checkpointNs] = HanaCheckpointSaver.threadNs(config);
    const serializedCheckpoint = this.dumpCheckpoint(checkpoint);
    const [blobRows, serializedMetadata, [serdeType, checkpointBytes]] =
      await Promise.all([
        this.dumpBlobs(
          threadId,
          checkpointNs,
          checkpoint.channel_values,
          newVersions
        ),
        this.dumpMetadata(metadata),
        this.serde.dumpsTyped(serializedCheckpoint),
      ]);
    const checkpointParams: HanaParameterType[] = [
      threadId,
      checkpointNs,
      checkpoint.id,
      config.configurable.checkpoint_id ?? null,
      serdeType,
      HanaCheckpointSaver.toBuffer(checkpointBytes),
      serializedMetadata,
    ];
    await this.withLock(async () => {
      if (blobRows.length > 0) {
        const blobStmt = await prepareQuery(
          this.connection,
          this.upsertBlobsSql()
        );
        await executeBatchStatement(blobStmt, blobRows);
      }
      const cpStmt = await prepareQuery(
        this.connection,
        this.upsertCheckpointSql
      );
      await executeStatement(cpStmt, checkpointParams);
    });
    return HanaCheckpointSaver.configurable(
      threadId,
      checkpointNs,
      checkpoint.id
    );
  }

  /**
   * Store intermediate (pending) writes for a checkpoint.
   *
   * Writes to special channels (`WRITES_IDX_MAP`) replace existing rows; regular
   * channel writes are inserted only if absent (first-write-wins), so a retried task
   * does not clobber already-recorded output.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = ""
  ): Promise<void> {
    await this.ensureSetup();
    if (config.configurable?.thread_id === undefined) {
      throw new Error(
        "Failed to put writes. The passed RunnableConfig is missing a required " +
          '"thread_id" field in its "configurable" property.'
      );
    }
    if (config.configurable?.checkpoint_id === undefined) {
      throw new Error(
        "Failed to put writes. The passed RunnableConfig is missing a required " +
          '"checkpoint_id" field in its "configurable" property.'
      );
    }
    const threadId = String(config.configurable.thread_id);
    const checkpointNs = String(config.configurable.checkpoint_ns ?? "");
    const checkpointId = String(config.configurable.checkpoint_id);
    const rows: HanaParameterType[][] = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, serialized] = await this.serde.dumpsTyped(value);
        return [
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          taskPath,
          WRITES_IDX_MAP[channel] ?? idx,
          channel,
          type,
          HanaCheckpointSaver.toBuffer(serialized),
        ] as HanaParameterType[];
      })
    );
    const upsert = writes.every((w) => w[0] in WRITES_IDX_MAP);
    await this.withLock(async () => {
      const stmt = await prepareQuery(
        this.connection,
        this.putWritesSql(upsert)
      );
      await executeBatchStatement(stmt, rows);
    });
  }

  /** Delete every checkpoint, blob and write for a thread. */
  async deleteThread(threadId: string): Promise<void> {
    await this.ensureSetup();
    await this.withLock(async () => {
      for (const sql of this.deleteThreadSql()) {
        const stmt = await prepareQuery(this.connection, sql);
        await executeStatement(stmt, [String(threadId)]);
      }
    });
  }
}
