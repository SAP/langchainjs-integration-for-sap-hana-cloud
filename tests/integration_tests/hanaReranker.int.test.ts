import hanaClient, { Connection } from "@sap/hana-client";
import { HanaTestUtils } from "./hana.test.utils";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DOCUMENTS } from "./hana.test.constants.js";
import { HanaReranker } from "../../src/index.js";
import { Document } from "@langchain/core/documents";

/* eslint-disable no-process-env */
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};

class Config {
  client: Connection;

  constructor(client: Connection) {
    this.client = client;
  }
}

let config: Config;
let reranker: HanaReranker;

beforeAll(async () => {
  expect(process.env.HANA_DB_ADDRESS).toBeDefined();
  expect(process.env.HANA_DB_PORT).toBeDefined();
  expect(process.env.HANA_DB_USER).toBeDefined();
  expect(process.env.HANA_DB_PASSWORD).toBeDefined();
  expect(process.env.HANA_DB_RERANK_MODEL_ID).toBeDefined();
  const client = hanaClient.createConnection(connectionParams);

  await HanaTestUtils.connectToHANA(client);
  config = new Config(client);
  reranker = new HanaReranker(
    config.client,
    process.env.HANA_DB_RERANK_MODEL_ID!
  );
  await reranker.initialize();
});

afterAll(async () => {
  config.client.disconnect();
});

describe("test rerank", () => {
  const testCases: [string, number, string[], boolean, number][] = [
    [DOCUMENTS[0].pageContent, 3, [], true, 0],
    [DOCUMENTS[1].pageContent, 2, [], false, 1],
    [DOCUMENTS[2].pageContent, 4, ["quality"], true, 2],
    [DOCUMENTS[3].pageContent, 1, ["Owner", "quality"], false, 3],
  ];
  test.each(testCases)(
    "test reranking with query: %s, topN: %d, rankFields: %o, returnDocuments: %s",
    async (
      query: string,
      topN: number,
      rankFields: string[],
      returnDocuments: boolean,
      expectedIdx: number
    ) => {
      const results = await reranker.rerank(
        DOCUMENTS,
        query,
        topN,
        returnDocuments,
        rankFields
      );
      expect(results.length).toBe(topN);
      expect(results[0][0]).toBe(expectedIdx);

      const scores = results.map((r) => r[1]);
      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
      }

      if (returnDocuments) {
        for (const result of results) {
          expect(result.length).toBe(3);
          const doc = result[2];
          expect(doc).toBeDefined();
        }
      }
    }
  );
});

describe("test rerank invalid topN", () => {
  const invalidTopNs = [0, -1, DOCUMENTS.length + 1];
  test.each(invalidTopNs)(
    "test reranking with invalid topN: %d",
    async (topN) => {
      await expect(
        reranker.rerank(DOCUMENTS, "test query", topN)
      ).rejects.toThrow(
        "topN must be greater than 0 and less than or equal to the number of documents"
      );
    }
  );
});

test("test rerank with invalid metadata key", async () => {
  await expect(
    reranker.rerank(DOCUMENTS, "test query", 3, true, ["invalid-key"])
  ).rejects.toThrow("Invalid metadata key invalid-key");
});

test("test compress documents", async () => {
  const docsCopy: Document[] = DOCUMENTS.map((doc) => new Document({ ...doc }));
  docsCopy.push(
    new Document({
      pageContent: "abc",
      metadata: { start: 400, quality: "ugly", Owner: "Bob" },
    })
  );
  const compressed = await reranker.compressDocuments(
    docsCopy,
    DOCUMENTS[0].pageContent
  );
  expect(compressed).toBeDefined();
  expect(compressed.length).toBe(5);
  for (const doc of compressed) {
    expect(doc).toBeDefined();
    expect("relevance_score" in doc.metadata).toBe(true);
  }

  const scores = compressed.map((doc) => doc.metadata["relevance_score"]);
  for (let i = 0; i < scores.length - 1; i++) {
    expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
  }
});
