import hanaClient from "@sap/hana-client";
// or another node.js driver: import hanaClient from "hdb";
import { createAgent } from "langchain";
import { tool } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { OrchestrationClient } from "@sap-ai-sdk/langchain";
import { z } from "zod";
import { HanaInternalEmbeddings, HanaStore } from "@sap/hana-langchain";

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

// Creating a store. Like the checkpointer, it self-initializes (idempotent
// migrations) and uses manual-commit mode so each batch commits atomically.
// `schemaName` and table names are overridable; `index` and `ttl` are shown below.
const store = new HanaStore({ connection: client });
await store.setup();

// --- Core key-value operations ------------------------------------------- //
// Items live under a namespace (a string[] hierarchy) and a key; values are
// JSON-serializable objects.
const userNs = ["users", "alice"];
await store.put(userNs, "profile", { name: "Alice", theme: "dark" });

const item = await store.get(userNs, "profile");
console.log(item?.value);
/*
  { name: 'Alice', theme: 'dark' }
*/
console.log(item?.namespace, item?.key);
/*
  [ 'users', 'alice' ] profile
*/
console.log(item?.createdAt?.toISOString(), item?.updatedAt?.toISOString());
/* timestamps are set by the database and differ per run, e.g.:
  2026-11-20T15:58:46.281Z 2026-11-20T15:58:46.281Z
*/

await store.delete(userNs, "profile");
console.log(await store.get(userNs, "profile"));
/*
  null
*/

// --- Search: metadata filtering and pagination --------------------------- //
// `search` returns items under a namespace prefix. Without a `query` it filters and
// paginates by stored metadata; operators such as $eq/$ne/$gt/$gte/$lt/$lte apply.
// Results are ordered by most-recently-updated first.
const docsNs = ["docs"];
await store.put(docsNs, "a", { color: "red", score: 1 });
await store.put(docsNs, "b", { color: "red", score: 5 });
await store.put(docsNs, "c", { color: "blue", score: 9 });

const reds = await store.search(docsNs, { filter: { color: "red" } });
console.log(new Set(reds.map((i) => i.key)));
/*
  Set(2) { 'b', 'a' }
*/

const high = await store.search(docsNs, { filter: { score: { $gte: 5 } } });
console.log(new Set(high.map((i) => i.key)));
/*
  Set(2) { 'c', 'b' }
*/

const page = await store.search(docsNs, { limit: 1, offset: 1 });
console.log(page.length);
/*
  1
*/

// An empty prefix searches across every namespace.
const everything = await store.search([]);
console.log(everything.length);
/*
  3
*/

// --- Listing namespaces -------------------------------------------------- //
await store.put(["a", "b", "c"], "k", { v: 1 });
await store.put(["a", "b", "d"], "k", { v: 1 });
await store.put(["a", "x"], "k", { v: 1 });

console.log(await store.listNamespaces({ prefix: ["a", "b"] }));
/*
  [ [ 'a', 'b', 'c' ], [ 'a', 'b', 'd' ] ]
*/
console.log(await store.listNamespaces({ prefix: ["a"], maxDepth: 2 }));
/*
  [ [ 'a', 'b' ], [ 'a', 'x' ] ]
*/
console.log(await store.listNamespaces({ suffix: ["c"] }));
/*
  [ [ 'a', 'b', 'c' ] ]
*/

// --- Time-to-live (TTL) -------------------------------------------------- //
// A `ttl` config expires items automatically. `defaultTtl` is in MINUTES;
// `refreshOnRead` extends an item's life on read. Expired items are hidden from
// reads immediately and physically removed by `sweepExpiredItems()` (or a background
// sweeper when `sweepIntervalMinutes` is set).
const ttlStore = new HanaStore({
  connection: client,
  ttl: { defaultTtl: 60, refreshOnRead: true }, // expire 60 min after access
});
await ttlStore.setup();

await ttlStore.put(["session"], "token", { value: "abc" });
// Override the default per item (here ~1.2 seconds):
await ttlStore.put(["session"], "short", { value: "xyz" }, false, {
  ttl: 0.02,
});

const removed = await ttlStore.sweepExpiredItems();
console.log("swept:", removed);
/*
  swept: 0
*/

// --- Semantic (vector) search with external embeddings ------------------- //
// Build the store with an `index`: `dims` (must match the model), `embeddings` (any
// LangChain Embeddings instance), and `fields` (JSON paths of the value to embed).
// A vectors table is created once with a fixed dimensionality and column type, so a
// differently-configured index uses its own table names to avoid colliding in one
// schema. In your own app you normally pick one configuration and keep the defaults.
//
//   import { OpenAIEmbeddings } from "@langchain/openai";
//   const extStore = new HanaStore({
//     connection: client,
//     index: { dims: 1536, embeddings: new OpenAIEmbeddings(), fields: ["text"] },
//     migrationsTable: "STORE_EXT_MIGRATIONS",
//     storeTable: "STORE_EXT",
//     vectorsTable: "STORE_EXT_VECTORS",
//   });
//   await extStore.setup();
//   await extStore.put(["memories"], "cats", { text: "cats are small furry pets" });
//   const hits = await extStore.search(["memories"], { query: "kitten" });
//   // Skip embedding one item (still stored, just not vector-searchable):
//   await extStore.put(["memories"], "note", { text: "internal note" }, false);

// --- Semantic search with HANA INTERNAL embeddings ----------------------- //
// HANA computes embeddings inside the database via VECTOR_EMBEDDING — no data leaves
// HANA and put/search issue no client-side embedding calls. `dims` must match the
// model's output dimensionality (here 768).
const internal = new HanaInternalEmbeddings({
  internalEmbeddingModelId:
    process.env.HANA_DB_EMBEDDING_MODEL_ID || "SAP_NEB.20240715",
});
const vectorStore = new HanaStore({
  connection: client,
  index: { dims: 768, embeddings: internal, fields: ["text"] },
  migrationsTable: "STORE_INT_MIGRATIONS",
  storeTable: "STORE_INT",
  vectorsTable: "STORE_INT_VECTORS",
});
await vectorStore.setup();

await vectorStore.put(["memories"], "cats", {
  text: "cats are small furry feline pets",
});
await vectorStore.put(["memories"], "cars", {
  text: "cars are fast motor vehicles",
});
const ranked = await vectorStore.search(["memories"], {
  query: "kitten",
  limit: 2,
});
ranked.forEach((i) => console.log(i.key, i.score));
/* cosine similarity from the in-database model; 'cats' ranks first:
  cats 0.697585114175845
  cars 0.39592110160269395
*/

// If the embedding model is served through a remote source (optionally in a specific
// schema), configure it on the embeddings object:
//
//   const internal = new HanaInternalEmbeddings({
//     internalEmbeddingModelId: "<remote-model-id>",
//     remoteSource: "<REMOTE_SOURCE_NAME>",
//     remoteSourceSchema: "<SCHEMA>", // optional
//   });

// --- Storing half-precision vectors -------------------------------------- //
// By default embeddings are stored as REAL_VECTOR (4 bytes/element). On instances
// that support it, `vectorColumnType: "HALF_VECTOR"` halves the storage (2 bytes);
// the embedding backend (external or internal) is unchanged.
//
//   const halfStore = new HanaStore({
//     connection: client,
//     index: { dims: 768, embeddings: internal, fields: ["text"] },
//     vectorColumnType: "HALF_VECTOR", // default is "REAL_VECTOR"
//     migrationsTable: "STORE_HALF_MIGRATIONS",
//     storeTable: "STORE_HALF",
//     vectorsTable: "STORE_HALF_VECTORS",
//   });

// --- Using the store with an agent --------------------------------------- //
// Pass the store to `createAgent` via `store`. Tools reach it through the runnable
// config (`config.store`) and can read/write memory that persists ACROSS threads
// (unlike the checkpointer's per-thread state). Here the chat model is served
// through the SAP generative AI hub orchestration service; any LangChain chat model
// works.
const model = new OrchestrationClient({
  promptTemplating: { model: { name: "gpt-4o" } },
});
// Or: import { ChatOpenAI } from "@langchain/openai";
//     const model = new ChatOpenAI({ model: "gpt-4o" });

const saveMemory = tool(
  async ({ content }: { content: string }, config: LangGraphRunnableConfig) => {
    await config.store!.put(["memories"], crypto.randomUUID(), {
      text: content,
    });
    return "Saved.";
  },
  {
    name: "save_memory",
    description: "Save a fact about the user to long-term memory.",
    schema: z.object({ content: z.string() }),
  }
);
const recallMemory = tool(
  async ({ query }: { query: string }, config: LangGraphRunnableConfig) => {
    const items = await config.store!.search(["memories"], { query, limit: 3 });
    return items.map((i) => i.value.text).join("\n") || "No memories yet.";
  },
  {
    name: "recall_memory",
    description: "Recall facts about the user from long-term memory.",
    schema: z.object({ query: z.string() }),
  }
);

const agent = createAgent({
  model,
  tools: [saveMemory, recallMemory],
  store: vectorStore,
});
// Teach it on one thread...
await agent.invoke(
  {
    messages: [
      { role: "user", content: "Remember that I prefer window seats." },
    ],
  },
  { configurable: { thread_id: "thread-1" } }
);
// ...and recall it from a DIFFERENT thread: the memory lives in HANA, not the thread.
const recall = await agent.invoke(
  { messages: [{ role: "user", content: "What seat do I prefer?" }] },
  { configurable: { thread_id: "thread-2" } }
);
console.log(recall.messages.at(-1)?.content);
/* the model recalls the cross-thread memory (wording may vary):
  You prefer window seats!
*/

client.disconnect();
