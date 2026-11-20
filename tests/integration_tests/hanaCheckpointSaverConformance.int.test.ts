/* eslint-disable no-process-env */
import hanaClient, { Connection } from "@sap/hana-client";
import * as vitest from "vitest";
import { validate } from "@langchain/langgraph-checkpoint-validation";
import { HanaCheckpointSaver } from "../../src/index.js";
import { commit, executeQuery, getTableRef } from "../../src/hanautils.js";
import { HanaTestUtils } from "./hana.test.utils.js";

// The LangGraph checkpoint-validation specs call describe/it/expect/beforeAll/etc.
// as globals (they do not import them). Rather than enabling `globals` for the whole
// `int` vitest mode, expose the vitest APIs on globalThis for just this file — vitest
// isolates each test file, so this does not leak to the other int tests.
Object.assign(globalThis, vitest);

// Runs the official LangGraph checkpointer conformance suite
// (@langchain/langgraph-checkpoint-validation) against HanaCheckpointSaver, against
// a live HANA instance (HANA_DB_* env). All per-test checkpointers share one schema
// and the default table set; `createCheckpointer()` runs the (idempotent) migration
// once and `destroyCheckpointer()` truncates the data tables between tests — far
// faster than creating/dropping tables per test.

const createConnectionParams = () => ({
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
});

const schemaPrefix = "LC_CHECKPOINTER_CONFORMANCE";

// The data tables cleared between tests (the migrations ledger is left intact).
const DATA_TABLES = [
  "LANGGRAPH_CHECKPOINTS",
  "LANGGRAPH_CHECKPOINT_BLOBS",
  "LANGGRAPH_CHECKPOINT_WRITES",
];

let client: Connection;
let schemaName: string;

validate({
  checkpointerName: "HanaCheckpointSaver",

  async beforeAll() {
    client = hanaClient.createConnection(createConnectionParams());
    await HanaTestUtils.connectToHANA(client);
    await HanaTestUtils.dropOldTestSchemas(client, schemaPrefix);
    schemaName = await HanaTestUtils.generateSchemaName(client, schemaPrefix);
    await HanaTestUtils.createAndSetSchema(client, schemaName);
  },
  beforeAllTimeout: 60_000,

  async afterAll() {
    await HanaTestUtils.dropSchemaIfExists(client, schemaName);
    client.disconnect();
  },

  async createCheckpointer() {
    const saver = new HanaCheckpointSaver({ connection: client, schemaName });
    // Idempotent: creates the tables on first call, a cheap ledger check after.
    await saver.setup();
    return saver;
  },

  async destroyCheckpointer() {
    // Clear state between tests. The constructor disables autocommit, so commit
    // explicitly after the deletes.
    for (const table of DATA_TABLES) {
      await executeQuery(
        client,
        `DELETE FROM ${getTableRef(table, schemaName)}`
      );
    }
    await commit(client);
  },
});
