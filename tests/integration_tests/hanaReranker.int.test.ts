import hanaClient, { Connection } from "@sap/hana-client";
import { HanaTestUtils } from "./hana.test.utils";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DOCUMENTS } from "./hana.test.constants.js";
import { HanaReranker } from "../../src/index.js";

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
});

afterAll(async () => {
  config.client.disconnect();
});

describe("test rerank", () => {
  const testCases = [
    [DOCUMENTS[0].pageContent, 3, [], true, 0],
    [DOCUMENTS[1].pageContent, 2, [], false, 1],
    [DOCUMENTS[2].pageContent, 4, ["quality"], true, 2],
    [DOCUMENTS[3].pageContent, 1, ["Owner", "quality"], false, 3],
  ];
  test.each(testCases)(
    "test reranking with query: %s, topN: %d, rankFields: %o, returnDocuments: %s",
    async (query, topN, returnDocuments, rankFields, expectedIdx) => {
      
    }
  );

});
