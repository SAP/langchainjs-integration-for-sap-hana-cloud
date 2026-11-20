/* eslint-disable no-process-env */
import hanaClient, { Connection } from "@sap/hana-client";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HanaCheckpointSaver } from "../../src/index.js";
import { HanaTestUtils } from "./hana.test.utils.js";

// The put/putWrites/getTuple/list/deleteThread contract is covered exhaustively by
// the official conformance suite (hanaCheckpointSaverConformance.int.test.ts). This
// file keeps only the end-to-end check that conformance does not exercise: driving a
// real LangGraph graph whose state persists across invocations via the saver.

const createConnectionParams = () => ({
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
});

const schemaPrefix = "LC_CHECKPOINTER_TEST";

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

describe("HanaCheckpointSaver (LangGraph integration)", () => {
  test("persists graph state across invocations on one thread", async () => {
    const saver = new HanaCheckpointSaver({ connection: client, schemaName });
    // Additive reducer so persisted state is observable: each run adds 1 on top of
    // whatever the checkpoint restored, and the {count: 0} input adds nothing.
    const StateAnnotation = Annotation.Root({
      count: Annotation<number>({
        reducer: (prev, next) => prev + next,
        default: () => 0,
      }),
    });
    const graph = new StateGraph(StateAnnotation)
      .addNode("increment", () => ({ count: 1 }))
      .addEdge(START, "increment")
      .addEdge("increment", END)
      .compile({ checkpointer: saver });

    const threadConfig = { configurable: { thread_id: `graph-${Date.now()}` } };
    const first = await graph.invoke({ count: 0 }, threadConfig);
    expect(first.count).toBe(1);
    // Second invocation resumes from the persisted checkpoint (count = 1), + 1 = 2.
    const second = await graph.invoke({ count: 0 }, threadConfig);
    expect(second.count).toBe(2);

    await saver.deleteThread(threadConfig.configurable.thread_id);
  });
});
