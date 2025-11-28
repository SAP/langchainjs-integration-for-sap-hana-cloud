/* eslint-disable no-process-env */
// eslint-disable-next-line import/no-extraneous-dependencies
import hanaClient, { Connection } from "@sap/hana-client";
import { HanaTestUtils } from "./hana.test.utils.js";
import { HanaInternalEmbeddings, HanaDB, HanaDBArgs } from "../../src/index.js";
import {
  executeQuery,
  executeStatement,
  prepareQuery,
} from "../../src/hanautils.js";
import {
  DOCUMENTS,
  METADATAS,
  TABLE_NAME,
  TEXTS,
} from "./hana.test.constants.js";

// Connection parameters factory
const createConnectionParams = (vectorOutputType?: "Array" | "Buffer") => {
  const params: {
    host: string | undefined;
    port: string | undefined;
    user: string | undefined;
    password: string | undefined;
    vectorOutputType?: "Array" | "Buffer";
  } = {
    host: process.env.HANA_DB_ADDRESS,
    port: process.env.HANA_DB_PORT,
    user: process.env.HANA_DB_USER,
    password: process.env.HANA_DB_PASSWORD,
  };
  if (vectorOutputType !== undefined) {
    params.vectorOutputType = vectorOutputType;
  }
  return params;
};

class Config {
  client: Connection;

  schemaName: string;

  embeddings: HanaInternalEmbeddings;

  constructor(
    client: Connection,
    schemaName: string,
    embeddings: HanaInternalEmbeddings
  ) {
    this.client = client;
    this.schemaName = schemaName;
    this.embeddings = embeddings;
  }
}

let config: Config;

async function isInternalEmbeddingAvailable(
  client: Connection,
  embeddings: HanaInternalEmbeddings
): Promise<boolean> {
  try {
    const query = `
        SELECT TO_NVARCHAR(VECTOR_EMBEDDING('test', 'QUERY', ?))
        FROM sys.DUMMY;
        `;
    const stm = await prepareQuery(client, query);
    await executeStatement(stm, [embeddings.getModelId()]);
    return true;
  } catch (error) {
    return false;
  }
}

describe.each(["Array", "Buffer", undefined] as const)(
  "tests with vectorOutputType=%s",
  (vectorOutputType) => {
    beforeAll(async () => {
      expect(process.env.HANA_DB_ADDRESS).toBeDefined();
      expect(process.env.HANA_DB_PORT).toBeDefined();
      expect(process.env.HANA_DB_USER).toBeDefined();
      expect(process.env.HANA_DB_PASSWORD).toBeDefined();
      expect(process.env.HANA_DB_EMBEDDING_MODEL_ID).toBeDefined();
      const connectionParams = createConnectionParams(vectorOutputType);
      const client = hanaClient.createConnection(connectionParams);

      const schemaPrefix = "LANGCHAIN_INT_EMB_TEST";
      await HanaTestUtils.connectToHANA(client);
      config = new Config(
        client,
        await HanaTestUtils.generateSchemaName(client, schemaPrefix),
        new HanaInternalEmbeddings({
          internalEmbeddingModelId: process.env
            .HANA_DB_EMBEDDING_MODEL_ID as string,
        })
      );
      if (
        !(await isInternalEmbeddingAvailable(config.client, config.embeddings))
      ) {
        throw new Error(
          `Internal embedding function is not available or the model id ${config.embeddings.getModelId()} is wrong`
        );
      }
      await HanaTestUtils.dropOldTestSchemas(client, schemaPrefix);
      await HanaTestUtils.createAndSetSchema(config.client, config.schemaName);
    });

    afterAll(async () => {
      await HanaTestUtils.dropSchemaIfExists(config.client, config.schemaName);
      config.client.disconnect();
    });

    async function vectorDBSetup(vectorColumnType: string) {
      const args: HanaDBArgs = {
        connection: config.client,
        tableName: TABLE_NAME,
        vectorColumnType,
      };
      const vectorDB = new HanaDB(config.embeddings, args);
      await vectorDB.initialize();
      expect(vectorDB).toBeDefined();
      return vectorDB;
    }

    async function vectorDBTeardown() {
      await HanaTestUtils.dropTable(config.client, TABLE_NAME);
    }

    describe.each(["REAL_VECTOR", "HALF_VECTOR"])(
      "tests with all vector column types",
      (vectorColumnType) => {
        test("hanavector add documents", async () => {
          const vectorDB = await vectorDBSetup(vectorColumnType);
          await vectorDB.addDocuments(DOCUMENTS);
          const countResult = await executeQuery(
            config.client,
            `SELECT COUNT(*) AS COUNT FROM ${TABLE_NAME}`
          );
          expect(countResult[0]?.COUNT ?? -1).toBe(DOCUMENTS.length);

          await vectorDBTeardown();
        });

        describe("similarity search tests", () => {
          test("test similarity search simple", async () => {
            const vectorDB = await vectorDBSetup(vectorColumnType);
            await vectorDB.addDocuments(DOCUMENTS);

            const results = await vectorDB.similaritySearch(TEXTS[0], 1);

            expect(results[0].pageContent).toBe(TEXTS[0]);

            expect(results[0].pageContent).not.toBe(TEXTS[1]);

            await vectorDBTeardown();
          });

          test("similarity search with metadata filter (numeric)", async () => {
            const vectorDB = await vectorDBSetup(vectorColumnType);
            await vectorDB.addDocuments(DOCUMENTS);

            let results = await vectorDB.similaritySearch(TEXTS[0], 3, {
              start: 100,
            });

            expect(results).toHaveLength(1);
            expect(results[0].pageContent).toBe(TEXTS[1]);
            expect(results[0].metadata.start).toBe(METADATAS[1].start);
            expect(results[0].metadata.end).toBe(METADATAS[1].end);

            results = await vectorDB.similaritySearch(TEXTS[0], 3, {
              start: 100,
              end: 150,
            });
            expect(results).toHaveLength(0);

            results = await vectorDB.similaritySearch(TEXTS[0], 3, {
              start: 100,
              end: 200,
            });

            expect(results).toHaveLength(1);
            expect(results[0].pageContent).toBe(TEXTS[1]);
            expect(results[0].metadata.start).toBe(METADATAS[1].start);
            expect(results[0].metadata.end).toBe(METADATAS[1].end);

            await vectorDBTeardown();
          });

          describe("similarity search invalid", () => {
            const invalidKs = [0, -4];

            test.each(invalidKs)("throws ValueError for k = %i", async (k) => {
              const vectorDB = await vectorDBSetup(vectorColumnType);
              await expect(
                vectorDB.similaritySearch(TEXTS[0], k)
              ).rejects.toThrow(/must be an integer greater than 0/);
              await vectorDBTeardown();
            });
          });
        });

        describe("max marginal relevance search tests", () => {
          test("max marginal relevance search simple", async () => {
            const vectorDB = await vectorDBSetup(vectorColumnType);
            await vectorDB.addDocuments(DOCUMENTS);

            const results = await vectorDB.maxMarginalRelevanceSearch(
              TEXTS[0],
              {
                k: 2,
                fetchK: 20,
              }
            );

            expect(results).toHaveLength(2);
            expect(results[0].pageContent).toBe(TEXTS[0]);
            expect(results[1].pageContent).not.toBe(TEXTS[0]);
            await vectorDBTeardown();
          });

          describe("max marginal relevance search invalid", () => {
            const invalidCases: Array<[number, number, string]> = [
              [0, 20, "must be an integer greater than 0"],
              [-4, 20, "must be an integer greater than 0"],
              [2, 0, "greater than or equal to 'k'"],
            ];

            test.each(invalidCases)(
              "throws for invalid (k=%i, fetchK=%i)",
              async (k, fetchK, expectedMessage) => {
                const vectorDB = await vectorDBSetup(vectorColumnType);
                await expect(
                  vectorDB.maxMarginalRelevanceSearch(TEXTS[0], { k, fetchK })
                ).rejects.toThrow(expectedMessage);

                await vectorDBTeardown();
              }
            );
          });
        });
      }
    );
  }
);
