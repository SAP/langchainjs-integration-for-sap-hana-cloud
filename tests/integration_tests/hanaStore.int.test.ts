/* eslint-disable no-process-env */
import hanaClient, { Connection } from "@sap/hana-client";
import { Embeddings } from "@langchain/core/embeddings";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HanaStore } from "../../src/index.js";
import { HanaTestUtils } from "./hana.test.utils.js";

const createConnectionParams = () => ({
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
});

const schemaPrefix = "LC_STORE_TEST";

// Deterministic embeddings: identical texts map to identical unit vectors, so an
// exact-match query scores 1.0 and ranks first.
class ConsistentFakeEmbeddings extends Embeddings {
  private knownTexts: string[] = [];

  private readonly dim: number;

  constructor(dim = 16) {
    super({});
    this.dim = dim;
  }

  private vector(text: string): number[] {
    let index = this.knownTexts.indexOf(text);
    if (index === -1) {
      this.knownTexts.push(text);
      index = this.knownTexts.length - 1;
    }
    const raw = new Array(this.dim)
      .fill(1)
      .map((_v, i) => (i === index % this.dim ? 5 : 1));
    const norm = Math.sqrt(raw.reduce((acc, v) => acc + v * v, 0));
    return raw.map((v) => v / norm);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vector(text);
  }
}

let client: Connection;
let schemaName: string;

beforeAll(async () => {
  client = hanaClient.createConnection(createConnectionParams());
  await HanaTestUtils.connectToHANA(client);
  await HanaTestUtils.dropOldTestSchemas(client, schemaPrefix);
  schemaName = await HanaTestUtils.generateSchemaName(client, schemaPrefix);
  await HanaTestUtils.createAndSetSchema(client, schemaName);
});

afterAll(async () => {
  await HanaTestUtils.dropSchemaIfExists(client, schemaName);
  client.disconnect();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("HanaStore", () => {
  test("put/get/delete round trip", async () => {
    const store = new HanaStore({ connection: client, schemaName });
    const ns = ["users", "u1"];
    await store.put(ns, "prefs", { theme: "dark" });
    const item = await store.get(ns, "prefs");
    expect(item?.value).toEqual({ theme: "dark" });
    expect(item?.namespace).toEqual(ns);
    await store.delete(ns, "prefs");
    expect(await store.get(ns, "prefs")).toBeNull();
  });

  test("preserves createdAt and advances updatedAt on update", async () => {
    const store = new HanaStore({ connection: client, schemaName });
    const ns = ["ts"];
    await store.put(ns, "k", { v: 1 });
    const first = await store.get(ns, "k");
    await sleep(1100);
    await store.put(ns, "k", { v: 2 });
    const second = await store.get(ns, "k");
    expect(second?.value).toEqual({ v: 2 });
    expect(second?.createdAt.getTime()).toBe(first?.createdAt.getTime());
    expect(second!.updatedAt.getTime()).toBeGreaterThan(
      first!.updatedAt.getTime()
    );
    await store.delete(ns, "k");
  });

  test("search with metadata filter and operators", async () => {
    const store = new HanaStore({ connection: client, schemaName });
    const ns = ["docs"];
    await store.put(ns, "a", { kind: "report", score: 5 });
    await store.put(ns, "b", { kind: "note", score: 2 });
    await store.put(ns, "c", { kind: "report", score: 1 });

    const reports = await store.search(ns, { filter: { kind: "report" } });
    expect(reports.map((i) => i.key).sort()).toEqual(["a", "c"]);

    const highScore = await store.search(ns, {
      filter: { score: { $gte: 2 } },
    });
    expect(highScore.map((i) => i.key).sort()).toEqual(["a", "b"]);

    for (const k of ["a", "b", "c"]) await store.delete(ns, k);
  });

  test("search pagination", async () => {
    const store = new HanaStore({ connection: client, schemaName });
    const ns = ["page"];
    for (let i = 0; i < 3; i += 1) await store.put(ns, `k${i}`, { i });
    const firstPage = await store.search(ns, { limit: 2, offset: 0 });
    const secondPage = await store.search(ns, { limit: 2, offset: 2 });
    expect(firstPage).toHaveLength(2);
    expect(secondPage).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) await store.delete(ns, `k${i}`);
  });

  test("search with an empty prefix returns items across all namespaces", async () => {
    const store = new HanaStore({ connection: client, schemaName });
    await store.put(["users", "1"], "a", { v: 1 });
    await store.put(["docs"], "b", { v: 2 });
    await store.put(["x", "y", "z"], "c", { v: 3 });

    const found = await store.search([]);
    expect(new Set(found.map((i) => i.key))).toEqual(new Set(["a", "b", "c"]));

    await store.delete(["users", "1"], "a");
    await store.delete(["docs"], "b");
    await store.delete(["x", "y", "z"], "c");
  });

  test("listNamespaces with prefix and maxDepth", async () => {
    const store = new HanaStore({ connection: client, schemaName });
    await store.put(["proj", "a", "x"], "k", { v: 1 });
    await store.put(["proj", "b"], "k", { v: 1 });
    await store.put(["other"], "k", { v: 1 });

    const underProj = await store.listNamespaces({ prefix: ["proj"] });
    expect(underProj).toEqual(
      expect.arrayContaining([
        ["proj", "a", "x"],
        ["proj", "b"],
      ])
    );
    expect(underProj).not.toContainEqual(["other"]);

    const shallow = await store.listNamespaces({
      prefix: ["proj"],
      maxDepth: 2,
    });
    expect(shallow).toContainEqual(["proj", "a"]);

    await store.delete(["proj", "a", "x"], "k");
    await store.delete(["proj", "b"], "k");
    await store.delete(["other"], "k");
  });

  test("TTL hides and sweeps expired items", async () => {
    const store = new HanaStore({
      connection: client,
      schemaName,
      ttl: { refreshOnRead: false },
    });
    const ns = ["ttl"];
    await store.put(ns, "short", { v: 1 }, false, { ttl: 0.02 }); // ~1.2s
    await sleep(1500);
    expect(await store.get(ns, "short")).toBeNull(); // hidden once expired
    const swept = await store.sweepExpiredItems();
    expect(swept).toBeGreaterThanOrEqual(1);
  });

  test("semantic search ranks the matching item first", async () => {
    const store = new HanaStore({
      connection: client,
      schemaName,
      index: {
        dims: 16,
        embeddings: new ConsistentFakeEmbeddings(16),
        fields: ["text"],
      },
    });
    const ns = ["sem"];
    await store.put(ns, "cat", { text: "cats are great pets" });
    await store.put(ns, "car", { text: "cars drive on roads" });

    const results = await store.search(ns, {
      query: "cats are great pets",
      limit: 2,
    });
    expect(results[0].key).toBe("cat");
    expect(results[0].score ?? 0).toBeGreaterThan(results[1].score ?? 0);

    await store.delete(ns, "cat");
    await store.delete(ns, "car");
  });

  test("semantic search works with a HALF_VECTOR column", async () => {
    const store = new HanaStore({
      connection: client,
      schemaName,
      index: {
        dims: 16,
        embeddings: new ConsistentFakeEmbeddings(16),
        fields: ["text"],
      },
      vectorColumnType: "HALF_VECTOR",
      vectorsTable: "LANGGRAPH_STORE_VECTORS_HALF",
    });
    try {
      await store.setup();
    } catch (e) {
      // Skip when the instance does not offer HALF_VECTOR.
      if (String(e).includes("HALF_VECTOR is not available")) return;
      throw e;
    }
    const ns = ["semhalf"];
    await store.put(ns, "cat", { text: "cats are great pets" });
    await store.put(ns, "car", { text: "cars drive on roads" });
    const results = await store.search(ns, {
      query: "cats are great pets",
      limit: 2,
    });
    expect(results[0].key).toBe("cat");
    await store.delete(ns, "cat");
    await store.delete(ns, "car");
  });
});
