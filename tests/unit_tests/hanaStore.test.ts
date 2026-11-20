import type { Connection } from "@sap/hana-client";
import type { Embeddings } from "@langchain/core/embeddings";
import { describe, expect, it } from "vitest";
import { HanaStore, type HanaStoreArgs } from "../../src/memorystores/index.js";

// SQL builders and serialization are exercised directly, mirroring the non-vector
// cases of the Python `test_hana_store.py` unit tests. No database is touched.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (obj: unknown): any => obj;

const mockConnection = { setAutoCommit: () => {} } as unknown as Connection;

// Minimal embeddings stub: the SQL/DDL builders only read dims/fields.
const stubEmbeddings = {
  embedDocuments: async () => [],
  embedQuery: async () => [],
} as unknown as Embeddings;

function makeStore(overrides: Partial<HanaStoreArgs> = {}): HanaStore {
  return new HanaStore({ connection: mockConnection, ...overrides });
}

describe("getSql", () => {
  it("has no expiry clause without TTL", () => {
    const sql = priv(makeStore()).getSql(2);
    expect(sql).not.toContain("EXPIRES_AT");
    expect(sql).toContain('"KEY" IN (?,?)');
  });

  it("adds an expiry clause when TTL is configured", () => {
    const sql = priv(makeStore({ ttl: {} })).getSql(1);
    expect(sql).toContain(
      '"EXPIRES_AT" IS NULL OR "EXPIRES_AT" > CURRENT_UTCTIMESTAMP'
    );
  });
});

describe("mergeStoreSql", () => {
  it("preserves CREATED_AT on update and casts the TTL to DOUBLE", () => {
    const sql = priv(makeStore()).mergeStoreSql;
    // WHEN MATCHED updates VALUE/UPDATED_AT/EXPIRES_AT/TTL_MINUTES but never CREATED_AT.
    const matched = sql.slice(
      sql.indexOf("WHEN MATCHED"),
      sql.indexOf("WHEN NOT MATCHED")
    );
    expect(matched).not.toContain("CREATED_AT");
    expect(sql).toContain("CAST(? AS DOUBLE)");
  });
});

describe("resolveTtl", () => {
  it("prefers the per-put ttl, then the default, else null", () => {
    const withDefault = makeStore({ ttl: { defaultTtl: 30 } });
    expect(priv(withDefault).resolveTtl({ options: { ttl: 5 } })).toBe(5);
    expect(priv(withDefault).resolveTtl({})).toBe(30);
    expect(priv(makeStore()).resolveTtl({})).toBeNull();
  });
});

describe("vectorsDdl", () => {
  it("dimensions the REAL_VECTOR column by index.dims", () => {
    const store = makeStore({ index: { dims: 8, embeddings: stubEmbeddings } });
    expect(priv(store).vectorsDdl()).toContain('"EMBEDDING" REAL_VECTOR(8)');
  });

  it("uses HALF_VECTOR when configured", () => {
    const store = makeStore({
      index: { dims: 8, embeddings: stubEmbeddings },
      vectorColumnType: "HALF_VECTOR",
    });
    expect(priv(store).vectorsDdl()).toContain('"EMBEDDING" HALF_VECTOR(8)');
  });
});

describe("HALF_VECTOR search SQL", () => {
  it("wraps the query embedding in TO_HALF_VECTOR", () => {
    const store = makeStore({
      index: { dims: 4, embeddings: stubEmbeddings },
      vectorColumnType: "HALF_VECTOR",
    });
    const [sql] = priv(store).vectorSearchSql(["ns"]);
    expect(sql).toContain("TO_HALF_VECTOR(?)");
    expect(sql).not.toContain("TO_REAL_VECTOR");
  });
});

describe("searchSql", () => {
  it("limits in SQL when ordered (no metadata filter)", () => {
    const [sql] = priv(makeStore()).searchSql(["a"], true, 5, 2);
    expect(sql).toContain("LIMIT 5 OFFSET 2");
    expect(sql).toContain('ORDER BY "UPDATED_AT" DESC');
  });

  it("omits the SQL limit when paginating in memory", () => {
    const [sql] = priv(makeStore()).searchSql(["a"], false, 5, 2);
    expect(sql).not.toContain("LIMIT");
  });
});

describe("vectorSearchSql", () => {
  it("aggregates cosine similarity and references the schema-qualified tables", () => {
    const store = makeStore({
      schemaName: "MY_SCHEMA",
      index: { dims: 4, embeddings: stubEmbeddings },
    });
    const [sql] = priv(store).vectorSearchSql(["ns"]);
    expect(sql).toContain('COSINE_SIMILARITY("EMBEDDING", TO_REAL_VECTOR(?))');
    expect(sql).toContain('"MY_SCHEMA"."LANGGRAPH_STORE_VECTORS"');
    expect(sql).toContain('"MY_SCHEMA"."LANGGRAPH_STORE"');
    expect(sql).toContain('ORDER BY sc."SCORE" DESC, s."UPDATED_AT" DESC');
  });
});

describe("listNamespacesSql", () => {
  it("adds a WHERE clause excluding expired rows when TTL is set", () => {
    expect(priv(makeStore()).listNamespacesSql).not.toContain("WHERE");
    const withTtl = priv(makeStore({ ttl: {} })).listNamespacesSql;
    expect(withTtl).toContain('WHERE ("EXPIRES_AT" IS NULL');
  });
});

describe("searchNamespaceClause", () => {
  it("matches the namespace and its descendants, qualifying by alias", () => {
    const [clause, params] = priv(makeStore()).searchNamespaceClause(
      ["a", "b"],
      "s"
    );
    expect(clause).toBe('(s."PREFIX" = ? OR s."PREFIX" LIKE ? ESCAPE \'\\\')');
    expect(params).toEqual(["a.b", "a.b.%"]);
  });

  it("matches every namespace for an empty prefix via a 1=1 no-op", () => {
    const [clause, params] = priv(makeStore()).searchNamespaceClause([]);
    expect(clause).toBe("1=1");
    expect(params).toEqual([]);
    expect(clause).not.toContain("PREFIX");
  });
});

describe("empty-prefix search SQL", () => {
  it("searchSql has no PREFIX filter and no params for an empty prefix", () => {
    const [sql, params] = priv(makeStore()).searchSql([], true, 5, 0);
    expect(params).toEqual([]);
    expect(sql).not.toContain('"PREFIX" LIKE');
  });

  it("vectorSearchSql has no params for an empty prefix", () => {
    const store = makeStore({ index: { dims: 4, embeddings: stubEmbeddings } });
    const [, params] = priv(store).vectorSearchSql([]);
    expect(params).toEqual([]);
  });
});

describe("extractIndexTexts", () => {
  it("returns (field, text) pairs for configured fields", () => {
    const store = makeStore({
      index: { dims: 4, embeddings: stubEmbeddings, fields: ["title"] },
    });
    const pairs = priv(store).extractIndexTexts({
      namespace: ["n"],
      key: "k",
      value: { title: "hello" },
    });
    expect(pairs).toEqual([["title", "hello"]]);
  });

  it("returns nothing when indexing is disabled for the item", () => {
    const store = makeStore({
      index: { dims: 4, embeddings: stubEmbeddings, fields: ["title"] },
    });
    const pairs = priv(store).extractIndexTexts({
      namespace: ["n"],
      key: "k",
      value: { title: "hello" },
      index: false,
    });
    expect(pairs).toEqual([]);
  });
});
