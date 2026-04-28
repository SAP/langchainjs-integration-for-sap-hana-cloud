import { OpenAIEmbeddings } from "@langchain/openai";
import hanaClient from "@sap/hana-client";
import { Document } from "@langchain/core/documents";
import {
  HanaDB,
  HanaDBArgs,
  HanaReranker,
  RerankConfigOptions,
} from "@sap/hana-langchain";

/* eslint-disable no-process-env */
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};
const client = hanaClient.createConnection(connectionParams);

// Connect to SAP HANA
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

// Prepare sample documents with metadata
const docs = [
  new Document({
    pageContent: "Python is a programming language",
    metadata: { category: "programming", difficulty: "beginner" },
  }),
  new Document({
    pageContent: "Machine learning uses algorithms to learn patterns",
    metadata: { category: "AI", difficulty: "intermediate" },
  }),
  new Document({
    pageContent: "Neural networks are inspired by the human brain",
    metadata: { category: "AI", difficulty: "advanced" },
  }),
];

// Initialize embeddings
const embeddings = new OpenAIEmbeddings();

const args: HanaDBArgs = {
  connection: client,
  tableName: "testReranking",
};

// Create a LangChain VectorStore interface for the HANA database and specify the table (collection) to use in args.
const vectorStore = new HanaDB(embeddings, args);
// need to initialize once an instance is created.
await vectorStore.initialize();
// Delete already existing documents from the table
await vectorStore.delete({ filter: {} });
await vectorStore.addDocuments(docs);

// Basic reranking
const rerankConfig: RerankConfigOptions = {
  modelId: process.env.HANA_DB_RERANKING_MODEL_ID || "SAP_CER.20250701",
  topN: 2,
};

const docsReranked = await vectorStore.similaritySearch(
  "AI Technology",
  3,
  undefined,
  undefined,
  rerankConfig
);
console.log("Reranked Results:");
docsReranked.forEach((doc) => {
  console.log("-".repeat(80));
  console.log(`Content: ${doc.pageContent}`);
  console.log("Metadata:", doc.metadata);
});
/*
Reranked Results:
--------------------------------------------------------------------------------
Content: Machine learning uses algorithms to learn patterns
Metadata: { category: 'AI', difficulty: 'intermediate' }
--------------------------------------------------------------------------------
Content: Python is a programming language
Metadata: { category: 'programming', difficulty: 'beginner' }
*/

// Reranking with metadata fields
const rerankConfigWithFields: RerankConfigOptions = {
  query: "beginner AI Concepts",
  modelId: process.env.HANA_DB_RERANKING_MODEL_ID || "SAP_CER.20250701",
  topN: 2,
  rankFields: ["category", "difficulty"],
};

const docsRerankedwithFields = await vectorStore.similaritySearch(
  "learning algorithm",
  3,
  undefined,
  undefined,
  rerankConfigWithFields
);
console.log("Reranked results with metadata fields:");
docsRerankedwithFields.forEach((doc) => {
  console.log("-".repeat(80));
  console.log(`Content: ${doc.pageContent}`);
  console.log("Metadata:", doc.metadata);
});
/*
Reranked results with metadata fields:
--------------------------------------------------------------------------------
Content: Neural networks are inspired by the human brain
Metadata: { category: 'AI', difficulty: 'advanced' }
--------------------------------------------------------------------------------
Content: Machine learning uses algorithms to learn patterns
Metadata: { category: 'AI', difficulty: 'intermediate' }
*/

// Reranking with scores
const rerankConfigWithScores: RerankConfigOptions = {
  modelId: process.env.HANA_DB_RERANKING_MODEL_ID || "SAP_CER.20250701",
  topN: 3,
};

const docsRerankedwithScores = await vectorStore.similaritySearchWithScore(
  "neural network architecture",
  3,
  undefined,
  undefined,
  rerankConfigWithScores
);
console.log("Reranked results with scores:");
docsRerankedwithScores.forEach(([doc, score]) => {
  console.log("-".repeat(80));
  console.log("Score:", score.toFixed(4));
  console.log(`Content: ${doc.pageContent}`);
});
/*
Reranked results with scores:
--------------------------------------------------------------------------------
Score: 0.0435
Content: Neural networks are inspired by the human brain
--------------------------------------------------------------------------------
Score: 0.0146
Content: Python is a programming language
--------------------------------------------------------------------------------
Score: 0.0145
Content: Machine learning uses algorithms to learn patterns
*/

// Standalone reranking with HanaReranker
const docsToCompress = [
  new Document({
    pageContent: "Python programming basics",
  }),
  new Document({
    pageContent: "Advanced machine learning techniques",
  }),
  new Document({
    pageContent: "Introduction to neural networks",
  }),
  new Document({
    pageContent: "Deep learning applications",
  }),
  new Document({
    pageContent: "Reinforcement learning strategies",
  }),
  new Document({
    pageContent: "Natural language processing techniques",
  }),
];
const reranker = new HanaReranker(
  client,
  process.env.HANA_DB_RERANKING_MODEL_ID || "SAP_CER.20250701"
);
await reranker.initialize();

const compressedDocs = await reranker.compressDocuments(
  docsToCompress,
  "AI and deep learning"
);

console.log("Reranked documents:");
compressedDocs.forEach((doc) => {
  console.log("-".repeat(80));
  console.log(`Content: ${doc.pageContent}`);
  console.log(`Relevance score: ${doc.metadata?.relevance_score?.toFixed(4)}`);
});
/*
Compressed documents:
--------------------------------------------------------------------------------
Content: Deep learning applications
Relevance score: 0.2188
--------------------------------------------------------------------------------
Content: Advanced machine learning techniques
Relevance score: 0.0748
--------------------------------------------------------------------------------
Content: Introduction to neural networks
Relevance score: 0.0079
--------------------------------------------------------------------------------
Content: Natural language processing techniques
Relevance score: 0.0040
--------------------------------------------------------------------------------
Content: Reinforcement learning strategies
Relevance score: 0.0036
*/

// Use rerank method for more control over topN and rankFields
const rerankedDocs = await reranker.rerank(
  docsToCompress,
  "machine learning",
  2
);
console.log("Top 2 reranked results:");
rerankedDocs.forEach(([idx, score, doc]) => {
  console.log(`  [${idx}] Score: ${score.toFixed(4)} - ${doc?.pageContent}`);
});
/*
Top 2 reranked results:
  [1] Score: 0.4351 - Advanced machine learning techniques
  [3] Score: 0.0342 - Deep learning applications
*/
