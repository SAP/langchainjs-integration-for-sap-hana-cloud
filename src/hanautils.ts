import {
  Connection,
  HanaParameterList,
  HanaParameterType,
  Statement,
} from "@sap/hana-client";

export type DistanceStrategy = "EUCLIDEAN" | "COSINE";

/**
 * Returns a quoted, optionally schema-qualified SQL table reference.
 * Produces `"schema"."table"` when schemaName is non-empty, otherwise `"table"`.
 */
export function getTableRef(tableName: string, schemaName = ""): string {
  if (schemaName) {
    return `"${schemaName}"."${tableName}"`;
  }
  return `"${tableName}"`;
}

export function validateK(k: number) {
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error("Parameter 'k' must be an integer greater than 0");
  }
}

export function validateKAndFetchK(k: number, fetchK: number) {
  validateK(k);
  if (!Number.isInteger(fetchK) || fetchK < k) {
    throw new Error(
      "Parameter 'fetch_k' must be an integer greater than or equal to 'k'"
    );
  }
  return fetchK;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executeQuery(client: Connection, query: string): Promise<any> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.exec(query, (err: Error, result: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

export async function executeSparqlQuery(
  client: Connection,
  query: string,
  requestHeaders: string
): Promise<string> {
  const sparqlQuery = `CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)`;
  const stmt = await prepareQuery(client, sparqlQuery);

  return new Promise((resolve, reject) => {
    const params: HanaParameterList = {
      REQUEST: query,
      PARAMETER: requestHeaders,
    };
    stmt?.exec(params, (err: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve(stmt.getParameterValue(2));
      }
    });
  });
}

export function prepareQuery(
  client: Connection,
  query: string
): Promise<Statement | undefined> {
  return new Promise((resolve, reject) => {
    client.prepare(query, (err: Error, statement) => {
      if (err) {
        console.error("Prepare query error", err);
        reject(err);
      } else {
        resolve(statement);
      }
    });
  });
}

export function executeStatement(
  statement: Statement | undefined,
  params: HanaParameterList
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statement?.exec(params, (err: Error, res: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
}

export function executeBatchStatement(
  statement: Statement | undefined,
  params: HanaParameterType[][]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statement?.execBatch(params, (err: Error, res: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
}

export const commonPrefixes: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

// --------------------------------------------------------------------------- #
// Shared identifier / schema helpers
//
// Used by the vector store, the LangGraph checkpointers and the memory stores so
// there is a single source of truth for sanitizing table/schema names, building
// JSON_VALUE accessors, validating identifiers and checking table existence.
// --------------------------------------------------------------------------- #

const VALID_IDENTIFIER_RE = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

/**
 * Throw if `name` is not a safe SQL/JSON identifier.
 *
 * Allows letters, digits and underscores only, and forbids a leading digit — the
 * rule for an unquoted SQL/JSON member name. Used for metadata keys/columns that
 * are interpolated into `JSON_VALUE` paths and SQL, so this prevents injection.
 */
export function validateIdentifier(name: string): void {
  if (!VALID_IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Invalid identifier '${name}': only letters, digits, and underscores are allowed, and it must not start with a digit.`
    );
  }
}

/** Strip anything that is not alphanumeric or an underscore. */
export function sanitizeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_]/g, "");
}

/**
 * Build a HANA `JSON_VALUE` scalar accessor for a metadata key.
 *
 * `column` is the (already quoted/qualified) JSON column expression and `key` the
 * JSON path key. Callers are responsible for validating/sanitizing `key`.
 */
export function jsonValue(column: string, key: string): string {
  return `JSON_VALUE(${column}, '$.${key}')`;
}

/**
 * Return `true` if `tableName` exists in `schemaName`.
 *
 * Falls back to the connection's current schema when `schemaName` is empty.
 */
export async function tableExists(
  connection: Connection,
  tableName: string,
  schemaName = ""
): Promise<boolean> {
  const sql = schemaName
    ? 'SELECT COUNT(*) AS "CNT" FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?'
    : 'SELECT COUNT(*) AS "CNT" FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?';
  const params: HanaParameterType[] = schemaName
    ? [schemaName, tableName]
    : [tableName];
  const stmt = await prepareQuery(connection, sql);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any = await executeStatement(stmt, params);
  return Array.isArray(rows) && rows.length > 0 && Number(rows[0].CNT) >= 1;
}

/** Commit the current transaction on a connection (promisified). */
export function commit(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.commit((err: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/** Roll back the current transaction on a connection (promisified). */
export function rollback(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.rollback((err: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * A minimal async mutex that serializes access to a single HANA connection.
 *
 * A `@sap/hana-client` connection is not safe for concurrent statements and its
 * transaction boundary (autocommit off + commit/rollback) is connection-global, so
 * the checkpointers and stores run each logical operation under this lock — the JS
 * analogue of the `threading.Lock`/`asyncio.Lock` used in the Python savers.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Acquire the lock; await the returned release function when done. */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = this.tail.then(() => next);
    await previous;
    return release;
  }
}
