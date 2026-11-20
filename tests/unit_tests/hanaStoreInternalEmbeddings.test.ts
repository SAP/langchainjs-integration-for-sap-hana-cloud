import type { Connection } from "@sap/hana-client";
import { describe, expect, it } from "vitest";
import { HanaStore, type HanaStoreArgs } from "../../src/memorystores/index.js";
import { HanaInternalEmbeddings } from "../../src/embeddings/index.js";

// Internal-embedding SQL/param construction is exercised directly, mirroring the
// Python `test_hana_store.py` internal-embedding cases. No database is touched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (obj: unknown): any => obj;

const mockConnection = { setAutoCommit: () => {} } as unknown as Connection;
const MODEL_ID = "SAP_NEB.20240715";

function internalStore(
  overrides: Partial<HanaStoreArgs> & {
    remoteSourceSchema?: string;
    remoteSource?: string;
  } = {}
): HanaStore {
  const { remoteSourceSchema, remoteSource, ...rest } = overrides;
  const embeddings = new HanaInternalEmbeddings({
    internalEmbeddingModelId: MODEL_ID,
    remoteSourceSchema,
    remoteSource,
  });
  return new HanaStore({
    connection: mockConnection,
    index: { dims: 4, embeddings },
    ...rest,
  });
}

describe("internal-embedding detection", () => {
  it("records the model id from a HanaInternalEmbeddings index", () => {
    const store = internalStore();
    expect(priv(store).useInternalEmbeddings).toBe(true);
    expect(priv(store).internalEmbeddingModelId).toBe(MODEL_ID);
  });
});

describe("insertVectorSql (internal)", () => {
  it("embeds in-database rather than binding a blob", () => {
    const sql = priv(internalStore()).insertVectorSql;
    expect(sql.startsWith("INSERT INTO")).toBe(true);
    expect(sql).toContain('("PREFIX", "KEY", "FIELD_NAME", "EMBEDDING")');
    expect(sql).toContain(
      "VALUES (?, ?, ?, VECTOR_EMBEDDING(?, 'DOCUMENT', ?))"
    );
    expect(sql).not.toContain("TO_HALF_VECTOR");
  });

  it("wraps the embedding in TO_HALF_VECTOR for a HALF_VECTOR column", () => {
    const sql = priv(
      internalStore({ vectorColumnType: "HALF_VECTOR" })
    ).insertVectorSql;
    expect(sql).toContain("TO_HALF_VECTOR(VECTOR_EMBEDDING(?, 'DOCUMENT', ?))");
  });
});

describe("vectorEmbeddingParams (trailing params)", () => {
  it("trails (text, modelId) for the three-arg form", () => {
    expect(
      priv(internalStore()).vectorEmbeddingParams("first", "DOCUMENT")
    ).toEqual(["first", MODEL_ID]);
  });

  it("includes remote schema/source for the five-arg form", () => {
    const store = internalStore({
      remoteSourceSchema: "REMOTE",
      remoteSource: "SRC",
    });
    expect(priv(store).vectorEmbeddingParams("t", "DOCUMENT")).toEqual([
      "t",
      MODEL_ID,
      "REMOTE",
      "SRC",
    ]);
  });
});

describe("vectorSearchSql (internal)", () => {
  it("embeds the query in-database; returns only namespace params", () => {
    const [sql, params] = priv(internalStore()).vectorSearchSql(["users"]);
    expect(sql).toContain("VECTOR_EMBEDDING(?, 'QUERY', ?)");
    expect(sql).not.toContain("TO_REAL_VECTOR(?)");
    expect(params).toEqual(["users", "users.%"]);
  });

  it("wraps the query embedding in TO_HALF_VECTOR for a HALF_VECTOR column", () => {
    const [sql] = priv(
      internalStore({ vectorColumnType: "HALF_VECTOR" })
    ).vectorSearchSql(["users"]);
    expect(sql).toContain("TO_HALF_VECTOR(VECTOR_EMBEDDING(?, 'QUERY', ?))");
  });
});

describe("queryEmbeddingParams (internal)", () => {
  it("returns VECTOR_EMBEDDING query params instead of a serialized vector", async () => {
    const params = await priv(internalStore()).queryEmbeddingParams("hello");
    expect(params).toEqual(["hello", MODEL_ID]);
  });
});
