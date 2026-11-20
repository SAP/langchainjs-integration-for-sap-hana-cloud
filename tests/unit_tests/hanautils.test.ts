import type { Connection } from "@sap/hana-client";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VECTOR_COLUMN_TYPE,
  VECTOR_COLUMN_SQL_TYPES,
  convertVectorEmbeddingToColumnType,
  datatypeSupportError,
  deserializeVector,
  getMinSupportedVersion,
  serializeVector,
  toTargetVectorType,
  validateDatatypeSupport,
  validateVectorColumnType,
  vectorEmbeddingSqlAndParams,
} from "../../src/hanautils.js";

// A minimal `@sap/hana-client` connection whose `exec` returns scripted rows based
// on a SQL substring, backing the DB-dependent datatype-support helper.
function fakeConnection(
  script: Record<string, Record<string, unknown>[]>
): Connection {
  return {
    exec: (
      sql: string,
      cb: (err: Error | null, rows: Record<string, unknown>[]) => void
    ) => {
      for (const [key, rows] of Object.entries(script)) {
        if (sql.includes(key)) {
          cb(null, rows);
          return;
        }
      }
      cb(null, []);
    },
  } as unknown as Connection;
}

describe("vector column type validation", () => {
  it("defaults to REAL_VECTOR and supports both types", () => {
    expect(DEFAULT_VECTOR_COLUMN_TYPE).toBe("REAL_VECTOR");
    expect(new Set(VECTOR_COLUMN_SQL_TYPES)).toEqual(
      new Set(["REAL_VECTOR", "HALF_VECTOR"])
    );
  });

  it("upper-cases and accepts known types", () => {
    expect(validateVectorColumnType("real_vector")).toBe("REAL_VECTOR");
    expect(validateVectorColumnType("Half_Vector")).toBe("HALF_VECTOR");
  });

  it("rejects an unknown type", () => {
    expect(() => validateVectorColumnType("BFLOAT16")).toThrow(
      /Unsupported vector_column_type/
    );
  });
});

describe("serialize / deserialize round trip", () => {
  const values = [0.5, -1.25, 3.0];

  it("REAL_VECTOR uses 4 bytes per element", () => {
    const blob = serializeVector(values, "REAL_VECTOR");
    expect(blob.length).toBe(4 + 3 * 4);
    expect(blob.readUInt32LE(0)).toBe(3);
    const out = deserializeVector(blob, "REAL_VECTOR");
    out.forEach((v, i) => expect(v).toBeCloseTo(values[i]));
  });

  it("HALF_VECTOR uses 2 bytes per element", () => {
    const blob = serializeVector(values, "HALF_VECTOR");
    expect(blob.length).toBe(4 + 3 * 2);
    expect(blob.readUInt32LE(0)).toBe(3);
    const out = deserializeVector(blob, "HALF_VECTOR");
    out.forEach((v, i) => expect(v).toBeCloseTo(values[i]));
  });

  it("rejects an unknown serialization type", () => {
    expect(() => serializeVector([1.0], "BOGUS")).toThrow(
      /Unsupported vector column type/
    );
  });
});

describe("toTargetVectorType", () => {
  it("wraps an expression in the matching TO_<type> conversion", () => {
    expect(toTargetVectorType("?", "REAL_VECTOR")).toBe("TO_REAL_VECTOR(?)");
    expect(toTargetVectorType("?", "HALF_VECTOR")).toBe("TO_HALF_VECTOR(?)");
  });

  it("rejects an unknown type", () => {
    expect(() => toTargetVectorType("?", "BOGUS")).toThrow(
      /Unsupported vector type/
    );
  });
});

describe("datatype support", () => {
  it("reports the minimum supported instance version", () => {
    expect(getMinSupportedVersion("HALF_VECTOR")).toContain("2025.15");
    expect(getMinSupportedVersion("REAL_VECTOR")).toContain("2024.2");
    expect(() => getMinSupportedVersion("BOGUS")).toThrow(/Unknown datatype/);
  });

  it("includes the instance version in the error when known", () => {
    const msg = datatypeSupportError("HALF_VECTOR", "2024.4");
    expect(msg).toContain("HALF_VECTOR");
    expect(msg).toContain("Instance version: 2024.4");
    expect(msg).toContain("2025.15");
  });

  it("omits the instance version line when unknown", () => {
    const msg = datatypeSupportError("HALF_VECTOR");
    expect(msg).not.toContain("Instance version:");
    expect(msg).toContain("2025.15");
  });

  it("passes when the datatype is available", async () => {
    const conn = fakeConnection({
      "SYS.DATA_TYPES": [
        { TYPE_NAME: "REAL_VECTOR" },
        { TYPE_NAME: "HALF_VECTOR" },
      ],
    });
    await expect(validateDatatypeSupport(conn, "HALF_VECTOR")).resolves.toBe(
      true
    );
  });

  it("raises with the instance version when the datatype is missing", async () => {
    const conn = fakeConnection({
      "SYS.DATA_TYPES": [{ TYPE_NAME: "REAL_VECTOR" }],
      "SYS.M_DATABASE": [{ CLOUD_VERSION: "2024.4" }],
    });
    await expect(validateDatatypeSupport(conn, "HALF_VECTOR")).rejects.toThrow(
      /HALF_VECTOR[\s\S]*2024\.4[\s\S]*2025\.15/
    );
  });
});

describe("vectorEmbeddingSqlAndParams", () => {
  it("builds the three-argument form", () => {
    const [sql, params] = vectorEmbeddingSqlAndParams(
      "hello",
      "QUERY",
      "SAP_NEB.20240715"
    );
    expect(sql).toBe("VECTOR_EMBEDDING(?, 'QUERY', ?)");
    expect(params).toEqual(["hello", "SAP_NEB.20240715"]);
  });

  it("builds the five-argument remote-source form", () => {
    const [sql, params] = vectorEmbeddingSqlAndParams(
      "doc",
      "DOCUMENT",
      "SAP_NEB.20240715",
      "REMOTE",
      "SRC"
    );
    expect(sql).toBe("VECTOR_EMBEDDING(?, 'DOCUMENT', ?, ?, ?)");
    expect(params).toEqual(["doc", "SAP_NEB.20240715", "REMOTE", "SRC"]);
  });

  it("rejects a bad kind", () => {
    expect(() =>
      // @ts-expect-error intentionally passing an invalid kind
      vectorEmbeddingSqlAndParams("x", "SENTENCE", "m")
    ).toThrow(/QUERY.*DOCUMENT/);
  });
});

describe("convertVectorEmbeddingToColumnType", () => {
  it("passes REAL_VECTOR expressions through unchanged", () => {
    expect(
      convertVectorEmbeddingToColumnType(
        "VECTOR_EMBEDDING(?, 'QUERY', ?)",
        "REAL_VECTOR"
      )
    ).toBe("VECTOR_EMBEDDING(?, 'QUERY', ?)");
  });

  it("wraps for a non-REAL_VECTOR column", () => {
    expect(
      convertVectorEmbeddingToColumnType(
        "VECTOR_EMBEDDING(?, 'QUERY', ?)",
        "HALF_VECTOR"
      )
    ).toBe("TO_HALF_VECTOR(VECTOR_EMBEDDING(?, 'QUERY', ?))");
  });

  it("rejects an expression that is not a VECTOR_EMBEDDING", () => {
    expect(() =>
      convertVectorEmbeddingToColumnType("?", "HALF_VECTOR")
    ).toThrow(/Expected 'VECTOR_EMBEDDING'/);
  });
});
