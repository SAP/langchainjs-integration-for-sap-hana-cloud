import hanaClient from "@sap/hana-client";
// or another node.js driver: import hanaClient from "hdb";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { tool } from "@langchain/core/tools";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { z } from "zod";
import { HanaCheckpointSaver } from "@sap/hana-langchain";

/* eslint-disable no-process-env */
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};

const client = hanaClient.createConnection(connectionParams);
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => {
    if (err) {
      reject(err);
    } else {
      console.log("Connected to SAP HANA successfully.");
      resolve();
    }
  });
});

// Creating a checkpointer. Passing the open connection applies the (idempotent)
// schema migrations and switches the connection to manual-commit mode so each
// multi-statement checkpoint write commits atomically. `setup()` also runs lazily on
// first use, and constructing the saver again against the same schema is cheap.
const checkpointer = new HanaCheckpointSaver({ connection: client });
await checkpointer.setup();

// Optionally override the schema and table names to isolate environments or run
// several applications side by side:
// const checkpointer = new HanaCheckpointSaver({
//   connection: client,
//   schemaName: "MY_APP", // defaults to the connection's current schema
//   migrationsTable: "LG_CKPT_MIGRATIONS",
//   checkpointsTable: "LG_CHECKPOINTS",
//   blobsTable: "LG_CHECKPOINT_BLOBS",
//   writesTable: "LG_CHECKPOINT_WRITES",
// });

// A minimal graph whose state is a growing list of messages. Compiling it with the
// checkpointer makes every invocation that carries a `thread_id` durable.
const ChatState = Annotation.Root({
  messages: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

const graph = new StateGraph(ChatState)
  .addNode("assistant", (state) => {
    const last = state.messages.at(-1) ?? "";
    return { messages: [`assistant: you said "${last}"`] };
  })
  .addEdge(START, "assistant")
  .addEdge("assistant", END)
  .compile({ checkpointer });

// The `thread_id` is the durable key under which all checkpoints for this
// conversation are stored.
const thread = { configurable: { thread_id: "demo-thread" } };

const first = await graph.invoke({ messages: ["hello"] }, thread);
console.log(first.messages);
/*
  [ 'hello', 'assistant: you said "hello"' ]
*/

// A follow-up on the SAME thread resumes from the saved state — even from a
// brand-new process or after a restart — so the earlier turn is still there.
const second = await graph.invoke({ messages: ["how are you?"] }, thread);
console.log(second.messages);
/*
  [
    'hello',
    'assistant: you said "hello"',
    'how are you?',
    'assistant: you said "how are you?"'
  ]
*/

// `getState` returns the latest checkpoint for a thread; `getStateHistory` walks
// every checkpoint (newest first) — what powers time-travel and debugging.
const state = await graph.getState(thread);
console.log("messages so far:", state.values.messages.length);
/*
  messages so far: 4
*/

for await (const snapshot of graph.getStateHistory(thread)) {
  console.log(
    snapshot.config.configurable?.checkpoint_id,
    "->",
    (snapshot.values.messages ?? []).length,
    "messages"
  );
}
/* checkpoint ids are generated and differ per run; newest first:
  1f1e4fed-13ce-60d0-8004-477d5ca3404b -> 4 messages
  1f1e4fed-13cb-69c0-8003-bd88214c5a7b -> 3 messages
  1f1e4fed-13c6-6ba0-8002-25f078178c53 -> 2 messages
  1f1e4fed-12ed-6710-8001-e3ee9b08c698 -> 2 messages
  1f1e4fed-12e3-6ad0-8000-f010702a6b02 -> 1 messages
  1f1e4fed-12c1-67f0-ffff-b87f9a28f064 -> 0 messages
*/

// The low-level checkpointer API is also available. `list` streams checkpoint
// tuples for a thread, with optional `limit`, metadata `filter` and `before` cursor.
for await (const ckpt of checkpointer.list(thread, { limit: 5 })) {
  console.log(ckpt.config.configurable?.checkpoint_id, ckpt.metadata?.source);
}
/*
  1f1e4fed-13ce-60d0-8004-477d5ca3404b loop
  1f1e4fed-13cb-69c0-8003-bd88214c5a7b loop
  1f1e4fed-13c6-6ba0-8002-25f078178c53 input
  1f1e4fed-12ed-6710-8001-e3ee9b08c698 loop
  1f1e4fed-12e3-6ad0-8000-f010702a6b02 loop
*/

// Using it with an agent: pass the saver to `createAgent` via `checkpointer`. The
// agent's conversation then persists per thread_id (short-term memory): a follow-up
// on the same thread sees the earlier messages. Here the chat model is served
// through the SAP generative AI hub orchestration service; any LangChain chat model
// works.
const model = new OrchestrationClient({
  promptTemplating: { model: { name: "gpt-4o" } },
});
// Or: import { ChatOpenAI } from "@langchain/openai";
//     const model = new ChatOpenAI({ model: "gpt-4o" });

const getWeather = tool(
  async ({ city }: { city: string }) => `It's always sunny in ${city}.`,
  {
    name: "get_weather",
    description: "Return the weather for a city.",
    schema: z.object({ city: z.string() }),
  }
);

const agent = createAgent({ model, tools: [getWeather], checkpointer });
const agentThread = { configurable: { thread_id: "agent-thread" } };
await agent.invoke(
  { messages: [{ role: "user", content: "Hi, I'm Alice. Weather in Paris?" }] },
  agentThread
);
const followup = await agent.invoke(
  { messages: [{ role: "user", content: "What's my name?" }] },
  agentThread
);
console.log(followup.messages.at(-1)?.content);
/* the model answers from the persisted history (wording may vary):
  Your name is Alice.
*/

client.disconnect();
