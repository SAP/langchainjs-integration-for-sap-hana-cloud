# Improving Search Quality with Cross-Encoding Reranking

Vector similarity search is fast and scalable, but it's not always accurate enough for production applications. **Cross-encoding reranking** is a powerful technique that dramatically improves search relevance by applying a more sophisticated model to re-score initial search results.

## The Two-Stage Retrieval Pattern

The most effective search systems use a two-stage approach:

1. **Stage 1 - Retrieval**: Fast vector similarity search retrieves a larger candidate set (e.g., top 20-50 results)
2. **Stage 2 - Reranking**: A cross-encoder model re-scores candidates for precise relevance ranking

```text
User Query
    │
    ▼
┌─────────────────────┐
│  Vector Search      │  Fast, approximate
│  (Bi-encoder)       │  Returns top 20 candidates
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Cross-Encoder      │  Slower, precise
│  Reranking          │  Returns top 5 best matches
└─────────────────────┘
    │
    ▼
Final Results (highly relevant)
```

## Why Cross-Encoding Works Better

**Bi-encoders** (used in vector search) encode the query and documents separately, then compare their embeddings. This is fast but can miss nuanced relevance signals.

**Cross-encoders** process the query and document together, allowing the model to directly compare them token-by-token. This captures subtle relationships that bi-encoders miss.

| Aspect | Bi-encoder (Vector Search) | Cross-encoder (Reranking) |
| ------ | -------------------------- | ------------------------- |
| Speed | Very fast (milliseconds) | Slower (requires per-pair scoring) |
| Accuracy | Good | Excellent |
| Scalability | Handles millions of docs | Best for <100 candidates |
| Use case | Initial retrieval | Final ranking |

---

## Using HanaReranker

SAP HANA Cloud provides built-in cross-encoding capabilities through the `HanaReranker` class.

### Basic Setup

```typescript
import {
  HanaDB,
  HanaDBArgs,
  HanaInternalEmbeddings,
  HanaReranker,
} from "@sap/hana-langchain";
import { Document } from "@langchain/core/documents";
import hanaClient from "@sap/hana-client";

// Set up connection
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};

const client = hanaClient.createConnection(connectionParams);
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => (err ? reject(err) : resolve()));
});

// Set up vector store with internal embeddings
const embeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "SAP_NEB.20240715",
});

const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "SUPPORT_ARTICLES",
});
await vectorStore.initialize();

// Initialize the reranker with a cross-encoding model
const reranker = new HanaReranker(client, "SAP_CER.20250701");
await reranker.initialize();
```

### Two-Stage Retrieval Example

```typescript
// Customer support scenario: Find the best help article for a user question
const userQuery = "How do I reset my two-factor authentication?";

// Stage 1: Fast vector search retrieves 20 candidates
const candidates = await vectorStore.similaritySearch(userQuery, 20);

// Stage 2: Cross-encoder reranks to find the 5 most relevant
const topResults = await reranker.rerank(
  candidates,
  userQuery,
  5 // Return top 5
);

// topResults is an array of [index, score, document] tuples, precisely ranked
```

The `rerank` method returns tuples of `[originalIndex, relevanceScore, document]` sorted by relevance score descending.

---

## Real-World Example: E-commerce Product Search

Let's see how reranking improves a product search experience:

```typescript
import {
  HanaDB,
  HanaInternalEmbeddings,
  HanaReranker,
} from "@sap/hana-langchain";
import { Document } from "@langchain/core/documents";
import hanaClient from "@sap/hana-client";

// Set up connection
const client = hanaClient.createConnection(connectionParams);
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => (err ? reject(err) : resolve()));
});

const embeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "SAP_NEB.20240715",
});

const productStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "PRODUCT_CATALOG",
});
await productStore.initialize();

// Add products with detailed descriptions
const products = [
  new Document({
    pageContent: "AudioMax Pro 5 wireless headphones with industry-leading noise cancellation, 30-hour battery, and premium sound quality for audiophiles",
    metadata: { name: "AudioMax Pro 5", category: "headphones", price: 349.99 },
  }),
  new Document({
    pageContent: "PocketBuds Pro 2 with adaptive transparency, personalized spatial audio, and wireless charging case",
    metadata: { name: "PocketBuds Pro 2", category: "earbuds", price: 249.99 },
  }),
  new Document({
    pageContent: "QuietShield Ultra headphones with world-class noise cancellation and immersive spatial audio experience",
    metadata: { name: "QuietShield Ultra", category: "headphones", price: 429.99 },
  }),
  new Document({
    pageContent: "TuneCore 510 on-ear wireless headphones with pure bass sound and 40-hour battery life, budget-friendly option",
    metadata: { name: "TuneCore 510", category: "headphones", price: 49.99 },
  }),
  new Document({
    pageContent: "StudioRef HD 560 open-back audiophile headphones for critical listening and mixing, reference-grade sound",
    metadata: { name: "StudioRef HD 560", category: "headphones", price: 199.99 },
  }),
  new Document({
    pageContent: "AudioMax Buds 5 true wireless earbuds with exceptional noise canceling and high-resolution audio support",
    metadata: { name: "AudioMax Buds 5", category: "earbuds", price: 299.99 },
  }),
];

await productStore.delete({ filter: {} });
await productStore.addDocuments(products);

const reranker = new HanaReranker(client, "SAP_CER.20250701");
await reranker.initialize();

// User searches for noise-canceling headphones for work
const searchQuery = "best noise canceling headphones for office work and video calls";

// Without reranking: Vector search results
const vectorResults = await productStore.similaritySearch(searchQuery, 4);
console.log("Vector Search Results (may not be optimally ordered):");
vectorResults.forEach((doc, i) => {
  console.log(`  ${i + 1}. ${doc.metadata.name}`);
});
```

```text
Vector Search Results (may not be optimally ordered):
  1. AudioMax Pro 5
  2. QuietShield Ultra
  3. AudioMax Buds 5
  4. StudioRef HD 560
```

```typescript
// With reranking: More precise ordering for the specific use case
const candidates = await productStore.similaritySearch(searchQuery, 6);
const rerankedResults = await reranker.rerank(candidates, searchQuery, 4);

console.log("\nReranked Results (optimized for 'office work and video calls'):");
rerankedResults.forEach(([index, score, doc], i) => {
  console.log(`  ${i + 1}. ${doc!.metadata.name} (relevance: ${score.toFixed(2)})`);
});
```

```text
Reranked Results (optimized for 'office work and video calls'):
  1. QuietShield Ultra (relevance: 0.52)
  2. AudioMax Buds 5 (relevance: 0.46)
  3. AudioMax Pro 5 (relevance: 0.42)
  4. StudioRef HD 560 (relevance: 0.05)
```

The cross-encoder reorders results by precise relevance to the query — QuietShield Ultra ranks first because its "world-class noise cancellation" description better matches "office work and video calls" than pure audio quality features.

---

## Integrated Reranking in Similarity Search

For convenience, you can integrate reranking directly into the similarity search call:

```typescript
import { RerankConfigOptions } from "@sap/hana-langchain";

const rerankConfig: RerankConfigOptions = {
  modelId: "SAP_CER.20250701",
  topN: 3,
};

// Single call that retrieves and reranks
const results = await productStore.similaritySearch(
  "noise canceling headphones for travel",
  6,         // Fetch 6 candidates
  undefined, // No metadata filter
  undefined, // No callbacks
  rerankConfig
);
console.log(results);
```

```text
[
  Document {
    pageContent: 'QuietShield Ultra headphones with world-class noise cancellation...',
    metadata: { name: 'QuietShield Ultra', category: 'headphones', price: 429.99 }
  },
  Document {
    pageContent: 'AudioMax Buds 5 true wireless earbuds with exceptional noise canceling...',
    metadata: { name: 'AudioMax Buds 5', category: 'earbuds', price: 299.99 }
  },
  Document {
    pageContent: 'AudioMax Pro 5 wireless headphones with industry-leading noise cancellation...',
    metadata: { name: 'AudioMax Pro 5', category: 'headphones', price: 349.99 }
  }
]
```

The results are already reranked — QuietShield Ultra ranks first for "travel" because of its "world-class noise cancellation" emphasis.

---

## Including Metadata in Reranking

You can improve reranking accuracy by including metadata fields in the scoring:

```typescript
const rerankConfig: RerankConfigOptions = {
  modelId: "SAP_CER.20250701",
  topN: 3,
  rankFields: ["name", "category"], // Include product name and category in scoring
};

const results = await productStore.similaritySearch(
  "affordable wireless headphones with long battery",
  6,
  undefined,
  undefined,
  rerankConfig
);
console.log(results);
```

```text
[
  Document {
    pageContent: 'TuneCore 510 on-ear wireless headphones with pure bass sound and 40-hour battery life, budget-friendly option',
    metadata: { name: 'TuneCore 510', category: 'headphones', price: 49.99 }
  },
  Document {
    pageContent: 'AudioMax Pro 5 wireless headphones with industry-leading noise cancellation, 30-hour battery...',
    metadata: { name: 'AudioMax Pro 5', category: 'headphones', price: 349.99 }
  },
  Document {
    pageContent: 'AudioMax Buds 5 true wireless earbuds with exceptional noise canceling and high-resolution audio...',
    metadata: { name: 'AudioMax Buds 5', category: 'earbuds', price: 299.99 }
  }
]
```

By including `name` and `category` in `rankFields`, the cross-encoder considers "TuneCore 510" and "headphones" alongside the content when scoring — boosting the budget-friendly TuneCore with its "40-hour battery" to first place for the "affordable" query.

This is especially useful when:

- Product/document names contain important keywords
- Categories or tags provide relevance signals
- You have structured metadata that complements the content

---

## Using HanaReranker as a Document Compressor

`HanaReranker` implements LangChain's `BaseDocumentCompressor` interface, making it compatible with retrieval pipelines:

```typescript
// Get candidates from vector search
const candidates = await productStore.similaritySearch("best headphones for music", 4);

// Use reranker as a document compressor
const compressedDocs = await reranker.compressDocuments(
  candidates,
  "best headphones for music production"
);
console.log(compressedDocs);
```

```text
[
  Document {
    pageContent: 'StudioRef HD 560 open-back audiophile headphones for critical listening and mixing...',
    metadata: { name: 'StudioRef HD 560', category: 'headphones', price: 199.99, relevance_score: 0.57 }
  },
  Document {
    pageContent: 'AudioMax Pro 5 wireless headphones with industry-leading noise cancellation...',
    metadata: { name: 'AudioMax Pro 5', category: 'headphones', price: 349.99, relevance_score: 0.35 }
  },
  Document {
    pageContent: 'QuietShield Ultra headphones with world-class noise cancellation...',
    metadata: { name: 'QuietShield Ultra', category: 'headphones', price: 429.99, relevance_score: 0.20 }
  },
  Document {
    pageContent: 'TuneCore 510 on-ear wireless headphones with pure bass sound...',
    metadata: { name: 'TuneCore 510', category: 'headphones', price: 49.99, relevance_score: 0.18 }
  }
]
```

The StudioRef HD 560 ranks first for "music production" because its description mentions "critical listening and mixing" — exactly what music producers need. Each document's metadata now includes `relevance_score`.

---

## Best Practices

### 1. Retrieve More, Rerank Fewer

Fetch a generous candidate set, then let the cross-encoder find the gems:

```typescript
// Good: Wide net, precise filter
const candidates = await vectorStore.similaritySearch(query, 30);
const results = await reranker.rerank(candidates, query, 5);

// Less ideal: Narrow net may miss relevant documents
const results = await vectorStore.similaritySearch(query, 5);
```

### 2. Balance Speed and Quality

Cross-encoding is more expensive than vector search. Choose your candidate set size based on your latency requirements (timings measured with `topN: 5`):

| Candidates | Rerank Time | Use Case |
| ---------- | ----------- | -------- |
| 10-20 | ~150-200ms | Real-time search |
| 30-50 | ~200-300ms | Quality-focused search |
| 100+ | ~350-500ms | Batch processing |

### 3. Combine with Metadata Filtering

Pre-filter with metadata to reduce the candidate set before reranking:

```typescript
// Filter first, then rerank within the filtered set
const candidates = await vectorStore.similaritySearch(
  query,
  30,
  { category: "headphones", in_stock: true } // Pre-filter
);
const results = await reranker.rerank(candidates, query, 5);
```

### 4. Use for RAG Applications

Reranking is especially valuable for RAG (Retrieval-Augmented Generation) where feeding the LLM with the most relevant context significantly improves response quality:

```typescript
// Retrieve and rerank context for LLM
const candidates = await vectorStore.similaritySearch(userQuestion, 20);
const topContext = await reranker.rerank(candidates, userQuestion, 3);

// Use top 3 most relevant documents as context
const context = topContext.map(([, , doc]) => doc!.pageContent).join("\n\n");

// Feed to LLM with high-quality, relevant context
const response = await llm.invoke(`Context:\n${context}\n\nQuestion: ${userQuestion}`);
```

---

## Related Resources

- [Vector Engine Guide](./blog-post.md) — Vector search, embeddings, and filtering
<!-- - [Knowledge Graph Guide](./knowledge-graph-engine.md) — RDF data and SPARQL Q&A -->
- [Performance Optimization Guide](./performance-optimization.md) — HNSW indexes and Map Merge
- [GitHub Repository](https://github.com/SAP/langchainjs-integration-for-sap-hana-cloud)
