# Building Vector Search Applications with SAP HANA Cloud and LangChain.js

In the rapidly evolving landscape of AI-powered applications, the ability to leverage enterprise-grade databases with modern AI frameworks is becoming increasingly crucial. Today, I'm excited to introduce **`@sap/hana-langchain`** — a powerful integration that brings together the robust capabilities of SAP HANA Cloud's Vector Engine with the flexibility of LangChain.js.

## What is @sap/hana-langchain?

`@sap/hana-langchain` is an open-source library that seamlessly integrates LangChain.js with SAP HANA Cloud, enabling developers to harness vector search and in-database AI capabilities as part of LLM-driven applications. Whether you're building a RAG (Retrieval-Augmented Generation) system, a semantic search engine, or an intelligent document retrieval system, this library has you covered.

<!-- > **Note:** This library also supports SAP HANA Cloud Knowledge Graph Engine. See our [Knowledge Graph Guide](./knowledge-graph-engine.md) for RDF data and SPARQL-based Q&A. -->

## Installation

Getting started is straightforward:

```bash
# Install peer dependencies
npm install @langchain/core@latest @langchain/classic@latest langchain@latest

# Install the SAP HANA integration
npm install @sap/hana-langchain

# Optional: Install SAP AI SDK for LLM features (Self-Query)
npm install @sap-ai-sdk/langchain
```

## Key Features

Let's dive into the powerful features this library offers:

---

## 1. Vector Store with HanaDB

The `HanaDB` class provides a full-featured vector store implementation backed by SAP HANA Cloud's Vector Engine. It supports storing, querying, and managing document embeddings with enterprise-grade reliability.

### Basic Usage

```typescript
import { HanaDB, HanaDBArgs, HanaInternalEmbeddings } from "@sap/hana-langchain";
import { Document } from "@langchain/core/documents";
import hanaClient from "@sap/hana-client";

// Connection parameters from environment variables
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};

// Create and establish connection
const client = hanaClient.createConnection(connectionParams);
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => {
    if (err) reject(err);
    else resolve();
  });
});

// Use SAP HANA's built-in embedding model (no external API calls needed)
const embeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "SAP_NEB.20240715",
});
const args: HanaDBArgs = {
  connection: client,
  tableName: "PRODUCT_CATALOG",
};

const vectorStore = new HanaDB(embeddings, args);
await vectorStore.initialize();

// Add product documents with rich metadata
const products = [
  new Document({
    pageContent: "Wireless noise-canceling headphones with 30-hour battery life",
    metadata: { category: "electronics", price: 299.99, in_stock: true },
  }),
  new Document({
    pageContent: "Ergonomic office chair with lumbar support and adjustable armrests",
    metadata: { category: "furniture", price: 449.00, in_stock: true },
  }),
  new Document({
    pageContent: "Professional espresso machine with built-in grinder",
    metadata: { category: "appliances", price: 899.99, in_stock: false },
  }),
];

await vectorStore.addDocuments(products);

// Find products similar to a customer query
const results = await vectorStore.similaritySearch(
  "comfortable work from home setup",
  2
);
console.log(results);
```

```text
[
  Document {
    pageContent: 'Ergonomic office chair with lumbar support and adjustable armrests',
    metadata: { category: 'furniture', price: 449, in_stock: true }
  },
  Document {
    pageContent: 'Professional espresso machine with built-in grinder',
    metadata: { category: 'appliances', price: 899.99, in_stock: false }
  }
]
```

```typescript
// Clean up connection when done
client.disconnect();
```

### Advanced Filtering

One of the most powerful features of `HanaDB` is its comprehensive filtering system. You can use various comparison operators to narrow down your search results:

```typescript
// Find only in-stock items
const inStockFilter = { in_stock: true };

// Find products under a price point
const budgetFilter = { price: { $lte: 500 } };

// Find products in a price range
const priceRangeFilter = { price: { $between: [100, 300] } };

// Find products in specific categories
const categoryFilter = { category: { $in: ["electronics", "appliances"] } };

// Exclude out-of-stock and discontinued items
const availableFilter = { status: { $nin: ["discontinued", "out_of_stock"] } };

// Search product names with pattern matching
const nameFilter = { name: { $like: "%wireless%" } };

// Full-text search in descriptions
const descriptionFilter = { description: { $contains: "noise canceling" } };

// Complex filter: in-stock electronics under $500
const complexFilter = {
  $and: [
    { in_stock: true },
    { category: "electronics" },
    { price: { $lt: 500 } },
  ],
};

const affordableElectronics = await vectorStore.similaritySearch(
  "best audio quality",
  10,
  complexFilter
);
console.log(affordableElectronics);
```

4 products found (all in-stock electronics under $500):

```text
[
  Document { pageContent: 'Premium wireless headphones with spatial audio...', metadata: { price: 349.99, in_stock: true } },
  Document { pageContent: 'Budget wireless earbuds with decent sound...', metadata: { price: 49.99, in_stock: true } },
  Document { pageContent: 'Bluetooth over-ear headphones with active noise...', metadata: { price: 249.99, in_stock: true } },
  Document { pageContent: 'Wireless noise-canceling headphones with 30-hour...', metadata: { price: 299.99, in_stock: true } }
]
```

```typescript
// Another example: featured OR highly-rated products
const featuredFilter = {
  $or: [
    { featured: true },
    { rating: { $gte: 4.5 } },
  ],
};
```

### Distance Strategies

Choose between different distance metrics based on your use case:

```typescript
// Cosine similarity (default) - best for semantic text similarity
const cosineStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "PRODUCTS_COSINE",
  distanceStrategy: "COSINE",
});
await cosineStore.initialize();

// Euclidean (L2) distance - useful for numerical feature vectors
const euclideanStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "PRODUCTS_EUCLIDEAN",
  distanceStrategy: "EUCLIDEAN",
});
await euclideanStore.initialize();
```

**Comparing Distance Strategies:**

Let's see how the same query behaves with different distance metrics:

```typescript
// Products with varying similarity to audio equipment
const products = [
  new Document({
    pageContent: "Wireless noise-canceling headphones with premium sound quality",
    metadata: { category: "electronics", price: 299.99 },
  }),
  new Document({
    pageContent: "Bluetooth speaker with deep bass and 20-hour battery",
    metadata: { category: "electronics", price: 149.99 },
  }),
  new Document({
    pageContent: "Professional studio microphone for podcasting and streaming",
    metadata: { category: "electronics", price: 199.99 },
  }),
  new Document({
    pageContent: "Ergonomic office chair with lumbar support",
    metadata: { category: "furniture", price: 449.00 },
  }),
];

// Add products to both stores
await cosineStore.addDocuments(products);
await euclideanStore.addDocuments(products);

const query = "high quality audio headphones";

// COSINE: Returns similarity scores (higher = more similar)
const cosineResults = await cosineStore.similaritySearchWithScore(query, 3);
console.log("COSINE Distance Results:");
cosineResults.forEach(([doc, score]) => console.log(`  [${score.toFixed(4)}] ${doc.pageContent}`));
```

```text
[0.7219] Wireless noise-canceling headphones with premium sound quality
[0.5506] Professional studio microphone for podcasting and streaming
[0.5206] Bluetooth speaker with deep bass and 20-hour battery
```

Cosine returns similarity scores (higher = more similar).

```typescript
// EUCLIDEAN: Returns distances (lower = more similar)
const euclideanResults = await euclideanStore.similaritySearchWithScore(query, 3);
console.log("EUCLIDEAN Distance Results:");
euclideanResults.forEach(([doc, score]) => console.log(`  [${score.toFixed(4)}] ${doc.pageContent}`));
```

```text
[0.7086] Wireless noise-canceling headphones with premium sound quality
[0.9048] Professional studio microphone for podcasting and streaming
[0.9251] Bluetooth speaker with deep bass and 20-hour battery
```

Euclidean returns distances (lower = more similar).

**When to use each:**

- **COSINE**: Ideal for text embeddings where direction matters more than magnitude. Scores range 0-1 (higher = more similar).
- **EUCLIDEAN**: Better for comparing absolute positions in vector space. Returns actual distances (lower = more similar).

<!-- > **Performance Tip:** For large datasets, see our [Performance Optimization Guide](./performance-optimization.md) covering HNSW indexes and Map Merge for faster searches and bulk insertions. -->

### Maximal Marginal Relevance (MMR) Search

Standard similarity search returns the top-k most similar documents. That's exactly what you want when the user has a narrow query. But there are spots in a product journey where pure similarity hurts the experience, and the most common one is the **"customers also viewed"** recommendations strip on a product detail page.

Imagine a shopper is looking at a premium open-back studio headphone (`StudioRef HD 560`). The strip beneath should help them discover comparable options: another wireless premium pair, a different form factor, maybe a budget alternative. Plain similarity search will fill that strip with four near-identical premium over-ear headphones, because that's what's most similar to what they're already looking at. **MMR** picks results that are both relevant *and* different from each other, so the strip actually helps the shopper compare.

```typescript
// Set up a small mixed headphone catalogue for the "customers also viewed" demo.
// Several premium over-ear headphones share vocabulary with the query, which is
// exactly the situation MMR is designed for.
const products = [
  new Document({
    pageContent:
      "StudioRef HD 560 open-back wired headphones for critical listening and mixing, reference-grade sound",
    metadata: { name: "StudioRef HD 560", form: "over-ear-wired", price: 199.99 },
  }),
  new Document({
    pageContent:
      "AudioMax Pro 5 wireless over-ear noise-canceling headphones with 30-hour battery and premium sound quality",
    metadata: { name: "AudioMax Pro 5", form: "over-ear-wireless", price: 349.99 },
  }),
  new Document({
    pageContent:
      "QuietShield Ultra premium over-ear headphones with world-class noise cancellation and immersive spatial audio",
    metadata: { name: "QuietShield Ultra", form: "over-ear-wireless", price: 429.99 },
  }),
  new Document({
    pageContent:
      "Premium wireless over-ear headphones with spatial audio, active noise cancellation, and studio-grade drivers",
    metadata: { name: "AuroraSound Pro", form: "over-ear-wireless", price: 379.99 },
  }),
  new Document({
    pageContent:
      "TuneCore 510 budget on-ear wireless headphones with pure bass sound and 40-hour battery life",
    metadata: { name: "TuneCore 510", form: "on-ear-wireless", price: 49.99 },
  }),
  new Document({
    pageContent:
      "AudioMax Buds 5 true wireless earbuds with exceptional noise canceling and high-resolution audio support",
    metadata: { name: "AudioMax Buds 5", form: "true-wireless", price: 299.99 },
  }),
  new Document({
    pageContent:
      "Wired in-ear monitor earphones with dual-driver design for stage and studio use",
    metadata: { name: "StageMonitor IE-200", form: "wired-in-ear", price: 129.99 },
  }),
  new Document({
    pageContent:
      "Sport wireless neckband earphones, sweat-resistant with secure-fit ear hooks",
    metadata: { name: "FlexFit Sport", form: "neckband", price: 89.99 },
  }),
];

await vectorStore.delete({ filter: {} });
await vectorStore.addDocuments(products);

const query = "premium wireless over-ear headphones";

// Plain similarity search: top-4 candidates ordered by closeness alone
const similar = await vectorStore.similaritySearch(query, 4);
console.log("similaritySearch top 4:");
similar.forEach((doc, i) => console.log(`  ${i + 1}. ${doc.metadata.name} (${doc.metadata.form}, $${doc.metadata.price})`));
```

```text
similaritySearch top 4:
  1. AudioMax Pro 5     (over-ear-wireless, $349.99)
  2. AuroraSound Pro    (over-ear-wireless, $379.99)
  3. AudioMax Buds 5    (true-wireless,     $299.99)
  4. QuietShield Ultra  (over-ear-wireless, $429.99)
```

Three of the four are premium over-ear wireless headphones, almost interchangeable for the shopper. Not a useful "customers also viewed" strip.

```typescript
// MMR: same query, but pick 4 from a wider candidate pool while penalising
// redundancy. lambda=0.5 balances relevance and diversity evenly.
const recommendations = await vectorStore.maxMarginalRelevanceSearch(query, {
  k: 4,        // Return 4 recommendations
  fetchK: 12,  // Consider 12 candidates
  lambda: 0.5, // Balance relevance and diversity
});
console.log("maxMarginalRelevanceSearch top 4:");
recommendations.forEach((doc, i) => console.log(`  ${i + 1}. ${doc.metadata.name} (${doc.metadata.form}, $${doc.metadata.price})`));
```

```text
maxMarginalRelevanceSearch top 4:
  1. AudioMax Pro 5     (over-ear-wireless, $349.99)
  2. FlexFit Sport      (neckband,           $89.99)
  3. AuroraSound Pro    (over-ear-wireless, $379.99)
  4. TuneCore 510       (on-ear-wireless,    $49.99)
```

The top match is still the most relevant premium over-ear pair, but the next three deliberately span different form factors and price tiers. The shopper now sees an actual mix to choose from, all from one method swap on the same vector store and the same product catalogue.

**When to reach for MMR:**

- **Product recommendation strips**: span different form factors, price tiers, or styles instead of stacking near-duplicates.
- **RAG context selection**: feed the LLM passages that cover multiple sub-topics of the question, not five rewordings of the same paragraph.
- **"Related articles" or "Discover" modules**: where coverage matters more than the single closest match.

Use `similaritySearch` when the goal is the closest match. Use `maxMarginalRelevanceSearch` when the goal is *coverage*.

---

## 2. Internal Embeddings with HanaInternalEmbeddings

SAP HANA Cloud includes built-in embedding models, eliminating the need for external embedding services. This reduces latency, simplifies architecture, and keeps your data within the database.

```typescript
import {
  HanaDB,
  HanaDBArgs,
  HanaInternalEmbeddings,
} from "@sap/hana-langchain";
import { Document } from "@langchain/core/documents";
import hanaClient from "@sap/hana-client";

// Use SAP HANA's built-in embedding model
const embeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "SAP_NEB.20240715",
});

// For enterprise deployments with SAP AI Core
const aiCoreEmbeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "text-embedding-ada-002",
  remoteSourceSchema: "AI_CORE_SCHEMA",
  remoteSource: "MY_AI_CORE_CONNECTION",
});

// Set up connection
const client = hanaClient.createConnection(connectionParams);
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => (err ? reject(err) : resolve()));
});

// Create vector store with internal embeddings
const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "PRODUCT_CATALOG",
});
await vectorStore.initialize();

// Add product data
const products = [
  new Document({
    pageContent: "Wireless noise-canceling headphones with 30-hour battery life and premium sound",
    metadata: { name: "AudioMax Pro 5", category: "electronics", price: 349.99 },
  }),
  new Document({
    pageContent: "Ergonomic office chair with lumbar support and adjustable armrests",
    metadata: { name: "ErgoChair Pro", category: "furniture", price: 449.00 },
  }),
  new Document({
    pageContent: "Mechanical keyboard with customizable RGB lighting and Cherry MX switches",
    metadata: { name: "TypePro K2", category: "electronics", price: 89.99 },
  }),
  new Document({
    pageContent: "Ultra-wide curved monitor for productivity with USB-C connectivity",
    metadata: { name: "WideView 34", category: "electronics", price: 599.99 },
  }),
];

await vectorStore.addDocuments(products);

// Search for products - embeddings computed inside SAP HANA
const results = await vectorStore.similaritySearch(
  "comfortable desk setup for long work sessions",
  3
);
console.log(results);
```

```text
[
  Document {
    pageContent: 'Ergonomic office chair with lumbar support and adjustable armrests',
    metadata: { name: 'ErgoChair Pro', category: 'furniture', price: 449 }
  },
  Document {
    pageContent: 'Ultra-wide curved monitor for productivity with USB-C connectivity',
    metadata: { name: 'WideView 34', category: 'electronics', price: 599.99 }
  },
  Document {
    pageContent: 'Wireless noise-canceling headphones with 30-hour battery life and premium sound',
    metadata: { name: 'AudioMax Pro 5', category: 'electronics', price: 349.99 }
  }
]
```

**Benefits of Internal Embeddings:**

- **Lower latency**: No external API calls needed
- **Data privacy**: Your data never leaves the database
- **Cost efficiency**: No per-token embedding costs
- **Simplified architecture**: Fewer moving parts

---

## 3. Cross-Encoding Reranking

Vector search is fast but not always precise. **Cross-encoding reranking** applies a more sophisticated model to re-score initial search results, dramatically improving relevance. You can integrate reranking directly into similarity search:

```typescript
import { HanaDB, HanaInternalEmbeddings, RerankConfigOptions } from "@sap/hana-langchain";
import { Document } from "@langchain/core/documents";
import hanaClient from "@sap/hana-client";

// Set up connection and vector store (as shown above)
const embeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "SAP_NEB.20240715",
});

const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "PRODUCT_CATALOG",
});
await vectorStore.initialize();

// Add products
const products = [
  new Document({
    pageContent: "Wireless noise-canceling headphones with 30-hour battery life and premium sound",
    metadata: { name: "AudioMax Pro 5", category: "electronics", price: 349.99 },
  }),
  new Document({
    pageContent: "Ergonomic office chair with lumbar support and adjustable armrests",
    metadata: { name: "ErgoChair Pro", category: "furniture", price: 449.00 },
  }),
  new Document({
    pageContent: "Standing desk converter with adjustable height and spacious work surface",
    metadata: { name: "DeskFlex M2", category: "furniture", price: 299.99 },
  }),
  new Document({
    pageContent: "Mechanical keyboard with customizable RGB lighting",
    metadata: { name: "TypePro K2", category: "electronics", price: 89.99 },
  }),
];
await vectorStore.addDocuments(products);

// Configure reranking with cross-encoder model
const rerankConfig: RerankConfigOptions = {
  modelId: "SAP_CER.20250701",
  topN: 3,
};

// Single call: vector search + cross-encoder reranking
const results = await vectorStore.similaritySearch(
  "comfortable work from home setup for long hours",
  6,         // Fetch 6 candidates internally
  undefined, // No metadata filter
  undefined, // No callbacks
  rerankConfig
);
console.log(results);
```

```text
[
  Document {
    pageContent: 'Ergonomic office chair with lumbar support and adjustable armrests',
    metadata: { name: 'ErgoChair Pro', category: 'furniture', price: 449 }
  },
  Document {
    pageContent: 'Standing desk converter with adjustable height and spacious work surface',
    metadata: { name: 'DeskFlex M2', category: 'furniture', price: 299.99 }
  },
  Document {
    pageContent: 'Wireless noise-canceling headphones with 30-hour battery life and premium sound',
    metadata: { name: 'AudioMax Pro 5', category: 'electronics', price: 349.99 }
  }
]
```

The cross-encoder re-scores all 6 candidates and returns the top 3 most relevant for "comfortable work from home setup" — notice how the ergonomic chair and standing desk rank higher than headphones, which is more contextually accurate than pure vector similarity.

<!-- For a complete guide with two-stage retrieval patterns, `HanaReranker` usage, and best practices, see our **[Cross-Encoding Reranking Guide](./cross-encoding-reranking.md)**. -->

---

## 4. Self-Query Retriever with HanaTranslator

The `HanaTranslator` enables self-querying — where an LLM automatically generates metadata filters from natural language queries. This is powerful for e-commerce, content libraries, or any searchable catalog.

```typescript
import {
  HanaDB,
  HanaDBArgs,
  HanaInternalEmbeddings,
  HanaTranslator,
} from "@sap/hana-langchain";
import { SelfQueryRetriever } from "@langchain/classic/retrievers/self_query";
import { AttributeInfo } from "@langchain/classic/chains/query_constructor";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { Document } from "@langchain/core/documents";
import hanaClient from "@sap/hana-client";

// Set up connection
const client = hanaClient.createConnection(connectionParams);
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => (err ? reject(err) : resolve()));
});

// Define your product catalog metadata schema
const attributeInfo = [
  new AttributeInfo("brand", "The product brand name", "string"),
  new AttributeInfo("category", "Product category (electronics, clothing, home)", "string"),
  new AttributeInfo("price", "Price in USD", "number"),
  new AttributeInfo("rating", "Customer rating from 1-5", "number"),
  new AttributeInfo("in_stock", "Whether the product is currently available", "boolean"),
];

// Use SAP HANA's built-in embeddings for the vector store
const embeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "SAP_NEB.20240715",
});
const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "PRODUCT_CATALOG",
  specificMetadataColumns: ["brand", "category", "price", "rating", "in_stock"],
});
await vectorStore.initialize();

// Add sample products
const products = [
  new Document({
    pageContent: "Premium wireless headphones with active noise cancellation",
    metadata: { brand: "AudioMax", category: "electronics", price: 349.99, rating: 4.7, in_stock: true },
  }),
  new Document({
    pageContent: "Lightweight running shoes with responsive cushioning",
    metadata: { brand: "TrailRunner", category: "clothing", price: 129.99, rating: 4.5, in_stock: true },
  }),
  new Document({
    pageContent: "Smart home speaker with voice assistant integration",
    metadata: { brand: "HomeVoice", category: "electronics", price: 99.99, rating: 4.3, in_stock: false },
  }),
];
await vectorStore.addDocuments(products);

// Set up the self-query retriever with SAP AI SDK LLM
const llm = new AzureOpenAiChatClient({ modelName: "gpt-4o" });

const retriever = SelfQueryRetriever.fromLLM({
  llm,
  vectorStore,
  documentContents: "Product description for an e-commerce catalog",
  attributeInfo,
  structuredQueryTranslator: new HanaTranslator(),
});

// Natural language queries automatically include filters!
const results1 = await retriever.invoke(
  "Show me AudioMax electronics under $400 with good ratings"
);
// Auto-generates: { $and: [{ brand: "AudioMax" }, { category: "electronics" }, { price: { $lt: 400 } }, { rating: { $gte: 4 } }] }

const results2 = await retriever.invoke(
  "Find in-stock products rated above 4.5 stars"
);
// Auto-generates: { $and: [{ in_stock: true }, { rating: { $gt: 4.5 } }] }

const results3 = await retriever.invoke(
  "TrailRunner or PaceMaker shoes"
);
// Auto-generates: { $and: [{ category: "clothing" }, { $or: [{ brand: "TrailRunner" }, { brand: "PaceMaker" }] }] }
```

---

## Configuration Options

### HanaDBArgs Reference

| Property | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `connection` | Connection | *required* | SAP HANA database connection |
| `tableName` | string | "EMBEDDINGS" | Table name for storing vectors |
| `contentColumn` | string | "VEC_TEXT" | Column for document content |
| `metadataColumn` | string | "VEC_META" | Column for JSON metadata |
| `vectorColumn` | string | "VEC_VECTOR" | Column for embeddings |
| `vectorColumnLength` | number | -1 (dynamic) | Fixed vector dimensionality |
| `vectorColumnType` | string | "REAL_VECTOR" | Vector type (REAL_VECTOR or HALF_VECTOR) |
| `distanceStrategy` | string | "COSINE" | Distance metric (COSINE or EUCLIDEAN) |
| `specificMetadataColumns` | string[] | undefined | Individual metadata columns for filtering |

---

## Best Practices

### 1. Use Specific Metadata Columns for Better Performance

When you frequently filter on specific metadata fields, define them as dedicated columns:

```typescript
const args: HanaDBArgs = {
  connection: client,
  tableName: "PRODUCTS",
  specificMetadataColumns: ["category", "price", "in_stock"],
};
```

### 2. Optimize for Large Datasets

For production workloads, use HNSW indexes and Map Merge. See our [Performance Optimization Guide](./performance-optimization.md) for details:

```typescript
// Fast bulk insertion with Map Merge
await vectorStore.addDocuments(documents, { useMapMerge: true });

// Create HNSW index for fast searches
await vectorStore.createHnswIndex();
```

### 3. Use Internal Embeddings When Possible

Internal embeddings reduce external dependencies and improve latency:

```typescript
const embeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "SAP_NEB.20240715",
});
```

### 4. Combine Vector Search with Reranking

For highest quality results, use initial vector search followed by reranking. See our [Cross-Encoding Guide](./cross-encoding-reranking.md):

```typescript
const candidates = await vectorStore.similaritySearch(query, 20);
const topResults = await reranker.rerank(candidates, query, 5);
```

### 5. Use HALF_VECTOR for Memory Efficiency

When memory is a concern, use half-precision vectors:

```typescript
const args: HanaDBArgs = {
  connection: client,
  tableName: "LARGE_DATASET",
  vectorColumnType: "HALF_VECTOR", // 50% memory savings
};
```

---

## Conclusion

`@sap/hana-langchain` bridges the gap between enterprise database capabilities and modern AI frameworks. With features spanning vector search, internal embeddings, intelligent reranking, and self-query retrieval, it provides everything you need to build production-ready vector search applications.

**Key Takeaways:**

- **Vector Store**: Full-featured embedding storage with advanced filtering and MMR search
- **Internal Embeddings**: Keep data processing entirely within SAP HANA
- **Reranking**: Improve search quality with cross-encoding models
- **Self-Query**: Automatic metadata filter generation from natural language
- **Performance**: HNSW indexes and Map Merge for production scale

## Resources

- **GitHub Repository**: [SAP/langchainjs-integration-for-sap-hana-cloud](https://github.com/SAP/langchainjs-integration-for-sap-hana-cloud)
- **SAP HANA Cloud Vector Engine Guide**: [SAP Help Portal](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide)
- **LangChain.js Documentation**: [js.langchain.com](https://js.langchain.com)
<!-- Add these when all blogs are published -->
<!-- - **Knowledge Graph Guide**: [RDF & SPARQL Q&A](./knowledge-graph-engine.md)
- **Performance Optimization Guide**: [HNSW & Map Merge](./performance-optimization.md)
- **Cross-Encoding Reranking Guide**: [Improving Search Quality](./cross-encoding-reranking.md) -->

---

*Ready to get started? Install the package and explore the [examples](https://github.com/SAP/langchainjs-integration-for-sap-hana-cloud/tree/main/examples) to see these features in action!*
