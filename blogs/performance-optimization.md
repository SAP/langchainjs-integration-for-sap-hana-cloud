# Performance Optimization: LangChain.js with SAP HANA Cloud

When building production AI applications with `@sap/hana-langchain`, performance becomes critical as your document collections grow. This guide covers three powerful optimization techniques: **Map Merge** for high-speed bulk insertions, **HNSW indexes** for faster searches at scale, and **specific metadata columns** for efficient filtering.

## Map Merge for High-Speed Bulk Insertions

When loading large document collections, the standard insertion method processes documents sequentially. **Map Merge** leverages SAP HANA's parallel processing capabilities to dramatically speed up bulk insertions.

### How Map Merge Works

Map Merge uses SAP HANA's `MAP_MERGE` function to:

1. Create embeddings in parallel across database nodes
2. Insert documents in batches using columnar processing
3. Minimize round-trips between your application and the database

**Requirements:**

- Must use `HanaInternalEmbeddings` (external embeddings are not supported)
- Best for batch insertions of 100+ documents

### Basic Usage

```typescript
const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "<YOUR_TABLE_NAME>",
});
await vectorStore.initialize();

// Enable Map Merge for fast bulk insertion
await vectorStore.addDocuments(documents, { useMapMerge: true });
```

### Real-World Benchmark: Research Paper Dataset

To demonstrate the performance difference, we use a dataset of **25,400 arXiv research paper abstracts** extracted from the [gfissore/arxiv-abstracts-2021](https://huggingface.co/datasets/gfissore/arxiv-abstracts-2021) dataset on Hugging Face (which contains 1.7M+ records). We extracted 25,400 entries into a JSON file for this benchmark.

> **Note:** All measurements in this guide were taken on a server machine with 48 cores. Absolute numbers will vary with your hardware, SAP HANA Cloud configuration, network latency, and document size; treat them as relative comparisons rather than fixed figures.

```typescript
import { HanaDB, HanaInternalEmbeddings } from "@sap/hana-langchain";
import { Document } from "@langchain/core/documents";
import hanaClient from "@sap/hana-client";
import { readFile } from "node:fs/promises";

// Load research papers (25,400 documents)
const raw = await readFile("arxiv_abstracts.json", "utf-8");
const entries = JSON.parse(raw);
const documents = entries.map(
  (e: any) => new Document({ pageContent: e.pageContent, metadata: e.metadata })
);
console.log(`Loaded ${documents.length} research papers`);

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

const embeddings = new HanaInternalEmbeddings({
  internalEmbeddingModelId: "SAP_NEB.20240715",
});

// Insert WITH Map Merge
const vsMapMerge = new HanaDB(embeddings, {
  connection: client,
  tableName: "PAPERS_MAP_MERGE",
});
await vsMapMerge.initialize();

const startMapMerge = Date.now();
await vsMapMerge.addDocuments(documents, { useMapMerge: true });
const timeMapMerge = (Date.now() - startMapMerge) / 1000;

// Insert WITHOUT Map Merge (default behavior)
const vsStandard = new HanaDB(embeddings, {
  connection: client,
  tableName: "PAPERS_STANDARD",
});
await vsStandard.initialize();

const startStandard = Date.now();
await vsStandard.addDocuments(documents);
const timeStandard = (Date.now() - startStandard) / 1000;

console.log(`Map Merge: ${timeMapMerge.toFixed(1)}s`);
console.log(`Standard:  ${timeStandard.toFixed(1)}s`);
console.log(`Speedup:   ${(timeStandard / timeMapMerge).toFixed(1)}x`);
```

```text
Loaded 25400 research papers

Map Merge: 354.2s (72 docs/s)
Standard:  3087.3s (8 docs/s)
Speedup:   8.7x faster with Map Merge
```

### Performance Comparison

| Method          | 25,400 Documents | Throughput |
| --------------- | ---------------- | ---------- |
| Standard Insert | ~51 minutes      | ~8 docs/s  |
| Map Merge       | ~6 minutes       | ~72 docs/s |
| **Speedup**     | **8.7x faster**  |            |

_Results from arXiv research paper dataset (average abstract ~1KB). Results vary based on document size, network latency, and SAP HANA configuration._

---

## HNSW Indexes for Lightning-Fast Search

As your vector store grows beyond tens of thousands of documents, exact nearest neighbor search becomes a bottleneck. HNSW (Hierarchical Navigable Small World) indexes provide approximate nearest neighbor search that's orders of magnitude faster.

### How HNSW Works

HNSW creates a multi-layer graph structure where:

1. Each document is a node connected to its nearest neighbors
2. Higher layers contain fewer nodes for fast initial navigation
3. Lower layers provide precise neighbor connections

**When to Use:**

| Dataset Size    | Recommendation                       |
| --------------- | ------------------------------------ |
| < 10K docs      | HNSW optional                        |
| 10K - 100K docs | Consider HNSW for sub-second queries |
| > 100K docs     | Strongly recommended                 |
| > 1M docs       | Essential for usable latency         |

### Basic Usage

```typescript
const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "<YOUR_TABLE_NAME>",
});
await vectorStore.initialize();

// Create HNSW index with default parameters
await vectorStore.createHnswIndex();

// Searches now automatically use the index
const results = await vectorStore.similaritySearch("your query", 5);
```

### Tuning HNSW Parameters

For specific performance requirements, you can customize the index:

```typescript
await vectorStore.createHnswIndex({
  indexName: "my_custom_index", // Optional custom name
  m: 64, // Max neighbors per node (4-1000)
  efConstruction: 200, // Build-time accuracy
  efSearch: 400, // Query-time accuracy
});
```

**Parameter Guidelines:**

| Parameter        | Low Value | High Value | Trade-off                    |
| ---------------- | --------- | ---------- | ---------------------------- |
| `m`              | 16        | 128        | Memory vs. search quality    |
| `efConstruction` | 64        | 500        | Index build time vs. quality |
| `efSearch`       | 100       | 1000       | Query latency vs. recall     |

- **`m`**: Higher values improve recall but use more memory
- **`efConstruction`**: Higher values build a better quality index but take longer
- **`efSearch`**: Higher values improve search accuracy but increase latency

### Real-World Benchmark: Research Paper Dataset

Using the 25,400 research papers we inserted earlier, let's measure search performance:

```typescript
// Using the vectorStore with 25,400 research papers
const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "PAPERS_MAP_MERGE",
});
await vectorStore.initialize();

// Measure search time WITHOUT HNSW index
const query = "machine learning applications in healthcare";
let start = Date.now();
let results = await vectorStore.similaritySearch(query, 5);
const timeWithoutIndex = Date.now() - start;
console.log(`Search without HNSW: ${timeWithoutIndex}ms`);

// Create HNSW index
start = Date.now();
await vectorStore.createHnswIndex();
const indexTime = Date.now() - start;
console.log(`HNSW index created in ${indexTime}ms`);

// Measure search time WITH HNSW index
start = Date.now();
results = await vectorStore.similaritySearch(query, 5);
const timeWithIndex = Date.now() - start;
console.log(`Search with HNSW: ${timeWithIndex}ms`);
```

```text
Search without HNSW: 72ms
HNSW index created in 1522ms
Search with HNSW: 105ms
```

**Note:** At 25,400 documents, exact search is actually faster than HNSW due to graph traversal overhead. HNSW provides significant speedups at larger scales (100K+ documents) where exact search becomes a bottleneck.

### When HNSW Provides Benefits

| Dataset Size | Exact Search | HNSW Search | Recommendation   |
| ------------ | ------------ | ----------- | ---------------- |
| 25K docs     | ~72ms        | ~105ms      | Use exact search |
| 100K docs    | ~183ms       | ~140ms      | HNSW recommended |
| 500K docs    | ~991ms       | ~166ms      | HNSW essential   |
| 1M+ docs     | ~2s+         | ~200ms      | HNSW required    |

_HNSW search time remains relatively stable (~100-200ms) regardless of dataset size, while exact search scales linearly._

---

## Filtering with Specific Metadata Columns

By default, HanaDB stores all metadata as JSON in a single column. For frequently filtered fields, you can extract them into dedicated columns for better query performance.

### How It Works

When you specify `specificMetadataColumns`, the vector store:

1. Stores specified metadata fields in dedicated SQL columns (enabling indexes and efficient comparisons)
2. Keeps remaining metadata in the JSON column
3. Uses native SQL column comparisons instead of JSON parsing during filtered searches

> **Important:** The table must be created with the specific columns before calling `initialize()`. HanaDB validates that the columns exist but does not create them automatically.

### Basic Usage

First, create the table with your specific metadata columns:

```sql
CREATE TABLE "MY_VECTORS" (
  "VEC_TEXT" NCLOB,
  "VEC_META" NCLOB,
  "VEC_VECTOR" REAL_VECTOR,
  "category" NVARCHAR(100),
  "year" INTEGER,
  "author" NVARCHAR(200)
);
```

Then configure the vector store to use those columns:

```typescript
const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "MY_VECTORS",
  specificMetadataColumns: ["category", "year", "author"],
});
await vectorStore.initialize();

// Add documents with metadata
await vectorStore.addDocuments(documents, { useMapMerge: true });

// Filter queries now use native SQL columns instead of JSON parsing
const results = await vectorStore.similaritySearch("machine learning", 5, {
  category: "cs.AI",
  year: 2023,
});
```

### Real-World Benchmark: Research Paper Dataset

Let's compare filtering performance with and without specific metadata columns:

```typescript
// WITHOUT specific metadata columns (JSON filtering)
const vsJson = new HanaDB(embeddings, {
  connection: client,
  tableName: "PAPERS_JSON_METADATA",
});
await vsJson.initialize();
await vsJson.addDocuments(documents, { useMapMerge: true });

// WITH specific metadata columns
// First create table with the columns:
// CREATE TABLE "PAPERS_SPECIFIC_COLUMNS" (
//   "VEC_TEXT" NCLOB, "VEC_META" NCLOB, "VEC_VECTOR" REAL_VECTOR,
//   "primaryCategory" NVARCHAR(100), "id" NVARCHAR(100)
// );
const vsColumns = new HanaDB(embeddings, {
  connection: client,
  tableName: "PAPERS_SPECIFIC_COLUMNS",
  specificMetadataColumns: ["primaryCategory", "id"],
});
await vsColumns.initialize();
await vsColumns.addDocuments(documents, { useMapMerge: true });

const query = "deep learning optimization";
const filter = { primaryCategory: "cs.LG" };

// Measure JSON filtering
let start = Date.now();
await vsJson.similaritySearch(query, 5, filter);
const timeJson = Date.now() - start;

// Measure specific column filtering
start = Date.now();
await vsColumns.similaritySearch(query, 5, filter);
const timeColumns = Date.now() - start;

console.log(`JSON metadata filtering: ${timeJson}ms`);
console.log(`Specific columns filtering: ${timeColumns}ms`);
```

```text
JSON metadata filtering: 166ms
Specific columns filtering: 126ms
Speedup: 1.3x faster with specific columns
```

### Performance Comparison

| Method           | Search Time | Notes                             |
| ---------------- | ----------- | --------------------------------- |
| JSON Metadata    | ~166ms      | Parses JSON on every query        |
| Specific Columns | ~126ms      | Uses native SQL column comparison |
| **Speedup**      | **1.3x**    |                                   |

_Results from filtering 25,400 research papers by `primaryCategory`. SAP HANA's JSON parsing is efficient at this scale; benefits increase with larger datasets and more complex filter conditions._

### When to Use Specific Metadata Columns

| Scenario                               | Recommendation                |
| -------------------------------------- | ----------------------------- |
| Filtering on 1-3 fields frequently     | Use `specificMetadataColumns` |
| Many different filter combinations     | Keep JSON metadata            |
| Exact match filters (category, status) | Use specific columns          |
| Range queries (price, date)            | Use specific columns          |
| Full-text search on metadata           | Keep JSON metadata            |

---

## Best Practices Summary

1. **Use Internal Embeddings** — Required for Map Merge, and provides lower latency overall

2. **Create HNSW After Loading** — Build the index after your initial data load, not during

3. **Use Specific Metadata Columns for Frequent Filters** — Extract 1-3 commonly filtered fields for faster queries

4. **Tune HNSW for Your Use Case**:
   - High recall needed? Increase `efSearch`
   - Memory constrained? Reduce `m`
   - One-time data load? Use higher `efConstruction`

5. **Monitor Performance** — SAP HANA provides system views to track index usage and query performance

---

## Related Resources

- [Vector Engine Guide](./blog-post.md) — Vector search, embeddings, and filtering
- [Knowledge Graph Guide](./knowledge-graph-engine.md) — RDF data and SPARQL Q&A
- [Cross-Encoding Reranking Guide](./cross-encoding-reranking.md) — Improving search quality
- [SAP HANA Vector Engine Guide](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide)
- [GitHub Repository](https://github.com/SAP/langchainjs-integration-for-sap-hana-cloud)
