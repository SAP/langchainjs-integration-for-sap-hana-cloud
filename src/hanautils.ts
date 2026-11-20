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

// --------------------------------------------------------------------------- #
// Vector column type: serialization, SQL conversion and datatype support
//
// Shared by the HanaDB vector store and the LangGraph memory stores so there is a
// single source of truth for how a configured `vectorColumnType` (REAL_VECTOR or
// HALF_VECTOR) is serialized, wrapped in SQL, and validated against the HANA
// instance. Callers pass their own `vectorColumnType` in.
// --------------------------------------------------------------------------- #

export const VECTOR_COLUMN_SQL_TYPES = ["REAL_VECTOR", "HALF_VECTOR"];
export const DEFAULT_VECTOR_COLUMN_TYPE = "REAL_VECTOR";

/**
 * Upper-case and validate a vector column type against the supported set.
 *
 * Pure (no DB access): checks only that the name is one HANA understands. The
 * DB-support check (whether this instance actually offers the type) is
 * {@link validateDatatypeSupport}.
 */
export function validateVectorColumnType(vectorColumnType: string): string {
  const upper = vectorColumnType.toUpperCase();
  if (!VECTOR_COLUMN_SQL_TYPES.includes(upper)) {
    throw new Error(
      `Unsupported vector_column_type: ${vectorColumnType}. ` +
        `Must be one of ${VECTOR_COLUMN_SQL_TYPES.join(", ")}`
    );
  }
  return upper;
}

/**
 * Convert a 64-bit JS number to a 16-bit half-precision float (returned as the
 * raw 16-bit integer). Buffer has no native `writeHalfLE`, so this fills the gap.
 */
function floatToHalf(value: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  floatView[0] = value;
  const f32int = int32View[0];
  const sign = (f32int >> 16) & 0x8000;
  let exponent = ((f32int >> 23) & 0xff) - 127;
  let mantissa = f32int & 0x007fffff;
  if (exponent === 128) {
    exponent = 15;
    mantissa = mantissa !== 0 ? 1 : 0;
  } else if (exponent > 15) {
    exponent = 15;
    mantissa = 0;
  } else if (exponent < -14) {
    exponent = 0;
    mantissa = 0;
  } else {
    exponent += 15;
    mantissa >>= 13;
  }
  return sign | (exponent << 10) | mantissa;
}

/** Convert a 16-bit half-precision float (raw 16-bit integer) back to a number. */
function halfToFloat(half: number): number {
  const sign = (half >> 15) & 0x0001;
  const exponent = (half >> 10) & 0x001f;
  const mantissa = half & 0x03ff;
  if (exponent === 0) {
    if (mantissa === 0) return sign === 1 ? -0 : 0;
    return (sign === 1 ? -1 : 1) * 2 ** -14 * (mantissa / 1024);
  } else if (exponent === 31) {
    if (mantissa === 0) return sign === 1 ? -Infinity : Infinity;
    return NaN;
  }
  return (sign === 1 ? -1 : 1) * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

/**
 * Serialize a float vector to HANA's fvecs binary format for the column type.
 *
 * `REAL_VECTOR` uses 4-byte floats; `HALF_VECTOR` uses 2-byte half-precision
 * floats. The leading 4-byte little-endian uint32 is the element count.
 */
export function serializeVector(
  values: number[],
  vectorColumnType: string
): Buffer {
  if (vectorColumnType === "HALF_VECTOR") {
    const buffer = Buffer.alloc(4 + values.length * 2);
    buffer.writeUInt32LE(values.length, 0);
    let offset = 4;
    for (const value of values) {
      buffer.writeUInt16LE(floatToHalf(value), offset);
      offset += 2;
    }
    return buffer;
  }
  if (vectorColumnType === "REAL_VECTOR") {
    const buffer = Buffer.alloc(4 + values.length * 4);
    buffer.writeUInt32LE(values.length, 0);
    let offset = 4;
    for (const value of values) {
      buffer.writeFloatLE(value, offset);
      offset += 4;
    }
    return buffer;
  }
  throw new Error(`Unsupported vector column type: ${vectorColumnType}`);
}

/** Extract a list of floats from HANA's fvecs binary format for the column type. */
export function deserializeVector(
  buffer: Buffer,
  vectorColumnType: string
): number[] {
  if (buffer.length < 4) {
    throw new Error("Invalid buffer: too short to contain vector length.");
  }
  const numValues = buffer.readUInt32LE(0);
  const values: number[] = [];
  const elementSize = vectorColumnType === "HALF_VECTOR" ? 2 : 4;
  if (
    vectorColumnType !== "HALF_VECTOR" &&
    vectorColumnType !== "REAL_VECTOR"
  ) {
    throw new Error(`Unsupported vector column type: ${vectorColumnType}`);
  }
  const expectedSize = 4 + numValues * elementSize;
  if (buffer.length < expectedSize) {
    throw new Error(
      `Invalid buffer: expected ${expectedSize} bytes for ${numValues} ` +
        `elements, but got ${buffer.length} bytes.`
    );
  }
  for (let i = 0; i < numValues; i += 1) {
    const offset = 4 + i * elementSize;
    values.push(
      vectorColumnType === "HALF_VECTOR"
        ? halfToFloat(buffer.readUInt16LE(offset))
        : buffer.readFloatLE(offset)
    );
  }
  return values;
}

/**
 * Wrap a vector SQL expression in the matching `TO_<type>` conversion, e.g.
 * `toTargetVectorType("?", "HALF_VECTOR")` -> `"TO_HALF_VECTOR(?)"`.
 */
export function toTargetVectorType(
  expr: string,
  vectorColumnType: string
): string {
  if (VECTOR_COLUMN_SQL_TYPES.includes(vectorColumnType)) {
    return `TO_${vectorColumnType}(${expr})`;
  }
  throw new Error(`Unsupported vector type: ${vectorColumnType}`);
}

/** Minimum HANA Cloud instance version that offers a given vector datatype. */
export function getMinSupportedVersion(datatype: string): string {
  if (datatype === "HALF_VECTOR") {
    return "2025.15 (QRC 2/2025)";
  }
  if (datatype === "REAL_VECTOR") {
    return "2024.2 (QRC 1/2024)";
  }
  throw new Error(`Unknown datatype: ${datatype}`);
}

/** Return the HANA Cloud instance version, or `undefined` if it can't be read. */
export async function getInstanceVersion(
  connection: Connection
): Promise<string | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any = await executeQuery(
      connection,
      "SELECT CLOUD_VERSION FROM SYS.M_DATABASE;"
    );
    return rows[0]?.CLOUD_VERSION;
  } catch {
    return undefined;
  }
}

/** Return the datatype names the HANA instance offers (`SYS.DATA_TYPES`). */
export async function getAvailableDatatypes(
  connection: Connection
): Promise<Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any = await executeQuery(
    connection,
    "SELECT TYPE_NAME FROM SYS.DATA_TYPES"
  );
  if (!rows || rows.length === 0) {
    throw new Error("No data types returned by the database.");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Set<string>(rows.map((row: any) => row.TYPE_NAME));
}

/**
 * Build the error message for a vector datatype unavailable on the instance.
 *
 * Pure (no DB access): callers that already know the instance version pass it in.
 */
export function datatypeSupportError(
  datatype: string,
  instanceVersion?: string
): string {
  let message = `${datatype} is not available on this HANA instance.\n`;
  if (instanceVersion) {
    message += `Instance version: ${instanceVersion}\n`;
  }
  message += `Minimum required instance version: ${getMinSupportedVersion(datatype)}`;
  return message;
}

/** Return `true` if `datatype` is available on the instance, else throw. */
export async function validateDatatypeSupport(
  connection: Connection,
  datatype: string
): Promise<boolean> {
  const available = await getAvailableDatatypes(connection);
  if (available.has(datatype)) {
    return true;
  }
  const instanceVersion = await getInstanceVersion(connection);
  throw new Error(datatypeSupportError(datatype, instanceVersion));
}
