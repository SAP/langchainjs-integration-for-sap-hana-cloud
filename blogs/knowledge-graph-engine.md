# Building Knowledge Graph Applications with SAP HANA Cloud and LangChain.js

Knowledge graphs provide a powerful way to represent and query structured information with rich relationships. SAP HANA Cloud's Knowledge Graph Engine brings enterprise-grade graph capabilities to your AI applications. This guide shows you how to leverage `@sap/hana-langchain` to build knowledge graph-powered solutions.

## What is SAP HANA Cloud Knowledge Graph Engine?

The SAP HANA Cloud Knowledge Graph Engine provides native support for RDF (Resource Description Framework) data and SPARQL queries. It allows you to:

- Store and query semantic data with complex relationships
- Run SPARQL queries directly against your HANA database
- Combine knowledge graph reasoning with vector search
- Build natural language Q&A systems over structured data

## Installation

```bash
# Install peer dependencies
npm install @langchain/core@latest @langchain/classic@latest langchain@latest

# Install the SAP HANA integration
npm install @sap/hana-langchain
```

> **Note:** The Knowledge Graph Engine requires the **triplestore feature** to be enabled on your SAP HANA Cloud instance. Contact your HANA administrator or enable it via SAP HANA Cloud Central if not already active.

---

## Working with Knowledge Graphs using HanaRdfGraph

The `HanaRdfGraph` class provides a wrapper around SAP HANA's SPARQL endpoint, making it easy to query RDF data and manage ontologies.

### Basic Setup and Querying

```typescript
import { HanaRdfGraph, HanaRdfGraphOptions } from "@sap/hana-langchain";
import hanaClient from "@sap/hana-client";

// Connection parameters from environment variables
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};

// Set up connection
const client = hanaClient.createConnection(connectionParams);
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => (err ? reject(err) : resolve()));
});

// Connect to a knowledge graph about company employees
const graphOptions: HanaRdfGraphOptions = {
  connection: client,
  graphUri: "http://company.example.com/org-chart",
  autoExtractOntology: true, // Automatically infer schema from data
};

const graph = new HanaRdfGraph(graphOptions);
await graph.initialize(graphOptions);

// Query the organization structure
const teamMembers = await graph.query(`
  PREFIX org: <http://company.example.com/ontology#>
  
  SELECT ?name ?role ?department
  WHERE {
    ?employee a org:Employee ;
              org:name ?name ;
              org:role ?role ;
              org:department ?department .
    FILTER (?department = "Engineering")
  }
  ORDER BY ?name
`);

console.log(teamMembers);
// Returns CSV-formatted results:
// name,role,department
// Alice Chen,Senior Developer,Engineering
// Bob Smith,Tech Lead,Engineering
```

### Schema/Ontology Loading Options

The `HanaRdfGraph` supports multiple ways to load your ontology, giving you flexibility based on your data management strategy:

```typescript
// Option 1: Auto-extract schema from existing data
// Best for: Quick prototyping or when schema is implicit in data
const autoGraph = new HanaRdfGraph({
  connection: client,
  graphUri: "http://company.example.com/products",
  autoExtractOntology: true,
});

// Option 2: Load ontology from a separate graph in the database
// Best for: When your ontology is stored in a different named graph
const remoteGraph = new HanaRdfGraph({
  connection: client,
  graphUri: "http://company.example.com/products",
  ontologyUri: "http://company.example.com/ontology", // Graph containing schema definitions
});

// Option 3: Load from a local Turtle file
// Best for: Custom ontologies managed in version control
const localGraph = new HanaRdfGraph({
  connection: client,
  graphUri: "http://company.example.com/products",
  ontologyLocalFile: "./ontologies/product-schema.ttl",
  ontologyLocalFileFormat: "text/turtle",
});

// Option 4: Custom SPARQL CONSTRUCT query
// Best for: Precise control over which schema elements to extract
const customGraph = new HanaRdfGraph({
  connection: client,
  graphUri: "http://company.example.com/products",
  ontologyQuery: `
    CONSTRUCT {
      ?class a owl:Class .
      ?prop rdfs:domain ?class ;
            rdfs:range ?range .
    }
    WHERE {
      ?class a owl:Class .
      ?prop rdfs:domain ?class ;
            rdfs:range ?range .
    }
  `,
});

// Don't forget to initialize after creation
await autoGraph.initialize(graphOptions);
```

### Accessing the Schema

You can access the loaded schema for inspection or serialization:

```typescript
import { Writer } from "n3";

// Get the schema as an N3 Store
const schemaStore = graph.getSchema();

// Serialize to Turtle format for display
const writer = new Writer({
  prefixes: {
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    owl: "http://www.w3.org/2002/07/owl#",
  },
});

schemaStore.forEach((quad) => {
  writer.addQuad(quad);
});

writer.end((error, result) => {
  console.log("Graph Schema:\n", result);
});
```

---

## Real-World Example: International Relations Dataset

Let's explore a real dataset modeling international relations between 14 nations, including diplomatic relationships, treaties, economic aid, and more.

### The Dataset

The [nations dataset](https://github.com/dongwookim-ml/kg-data/tree/master/nation) contains 2,024 triples representing relationships between countries like USA, UK, USSR, China, and others. Relationships include:

- **treaties** — Formal agreements between nations
- **economicaid** — Economic assistance relationships
- **embassy** — Diplomatic presence
- **militaryalliance** — Defense partnerships
- **exports** — Trade relationships

### Loading Data into SAP HANA

First, load the triples into a named graph:

```typescript
import hanaClient from "@sap/hana-client";
import { readFile } from "node:fs/promises";

const client = hanaClient.createConnection(connectionParams);
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => (err ? reject(err) : resolve()));
});

// Read and parse the triples file (TSV format: subject\tpredicate\tobject)
const data = await readFile("./datasets/nation/triples.txt", "utf-8");
const triples = data
  .trim()
  .split("\n")
  .map((line) => {
    const [subject, predicate, object] = line.split("\t");
    return { subject, predicate, object };
  });

// Build SPARQL INSERT query
const insertStatements = triples
  .map((t) => `<${t.subject}> <${t.predicate}> <${t.object}> .`)
  .join("\n");

const sparqlInsert = `
  INSERT DATA {
    GRAPH <Nations> {
      ${insertStatements}
    }
  }
`;

// Execute via SPARQL endpoint
await new Promise<void>((resolve, reject) => {
  client.prepare("CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)", (err, stmt) => {
    if (err) reject(err);
    stmt.exec({ REQUEST: sparqlInsert, PARAMETER: "" }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

console.log(`Loaded ${triples.length} triples into Nations graph`);
```

```text
Loaded 2024 triples into Nations graph
```

### Querying the Graph

Connect to the graph and run SPARQL queries:

```typescript
import { HanaRdfGraph } from "@sap/hana-langchain";

const graph = new HanaRdfGraph({
  connection: client,
  graphUri: "Nations",
  autoExtractOntology: true,
});
await graph.initialize({
  connection: client,
  graphUri: "Nations",
  autoExtractOntology: true,
});

// Find all countries that have treaties with the USA
const usaTreaties = await graph.query(`
  SELECT ?country
  WHERE {
    ?country <treaties> <USA> .
  }
  ORDER BY ?country
`);
console.log("Countries with USA treaties:", usaTreaties);
```

```text
country
Brazil
Cuba
Egypt
India
Israel
Netherlands
Poland
UK
USSR
```

### More Example Queries

```typescript
// Find countries receiving economic aid from multiple superpowers
const multiAid = await graph.query(`
  SELECT ?recipient (COUNT(?donor) AS ?donorCount)
  WHERE {
    ?donor <economicaid> ?recipient .
  }
  GROUP BY ?recipient
  HAVING (COUNT(?donor) > 1)
  ORDER BY DESC(?donorCount)
`);
console.log("Countries receiving aid from multiple nations:", multiAid);
```

```text
recipient,donorCount
India,3
Egypt,2
Jordan,2
```

```typescript
// Find bilateral relationships (countries with mutual treaties)
const bilateral = await graph.query(`
  SELECT DISTINCT ?country1 ?country2
  WHERE {
    ?country1 <treaties> ?country2 .
    ?country2 <treaties> ?country1 .
    FILTER (STR(?country1) < STR(?country2))
  }
  ORDER BY ?country1 ?country2
`);
console.log("Mutual treaty relationships:", bilateral);
```

```text
country1,country2
Brazil,USA
Burma,China
China,Cuba
China,Egypt
China,Indonesia
China,Poland
China,USSR
Cuba,UK
Cuba,USA
Egypt,UK
Egypt,USA
India,Netherlands
India,UK
India,USA
Israel,UK
Israel,USA
Jordan,UK
Netherlands,Poland
Netherlands,UK
Netherlands,USA
Netherlands,USSR
Poland,UK
Poland,USA
Poland,USSR
UK,USA
UK,USSR
USA,USSR
```

---

## Best Practices

### 1. Provide Clear Schema Documentation

The better your ontology is documented, the better the LLM can generate accurate SPARQL:

```turtle
# Good: Well-documented ontology
:Employee a owl:Class ;
    rdfs:label "Employee" ;
    rdfs:comment "A person employed by the company" .

:reportsTo a owl:ObjectProperty ;
    rdfs:label "reports to" ;
    rdfs:comment "The manager this employee reports to" ;
    rdfs:domain :Employee ;
    rdfs:range :Employee .
```

### 2. Start with Auto-Extract, Refine Later

For new projects, start with `autoExtractOntology: true`, then create a formal ontology as your understanding grows:

```typescript
// Development: Auto-extract
const devGraph = new HanaRdfGraph({
  connection: client,
  graphUri: "my-graph",
  autoExtractOntology: true,
});

// Production: Explicit ontology
const prodGraph = new HanaRdfGraph({
  connection: client,
  graphUri: "my-graph",
  ontologyLocalFile: "./ontologies/production-schema.ttl",
});
```

### 3. Combine with Vector Search

For the best of both worlds, combine knowledge graph queries with vector search:

```typescript
import {
  HanaDB,
  HanaInternalEmbeddings,
  HanaRdfGraph,
} from "@sap/hana-langchain";

// Vector search for semantic similarity
const vectorStore = new HanaDB(embeddings, {
  connection: client,
  tableName: "DOCUMENTS",
});
const semanticResults = await vectorStore.similaritySearch(
  "customer complaints about delivery",
  5
);

// Knowledge graph for structured queries
const graph = new HanaRdfGraph({
  connection: client,
  graphUri: "customer-data",
});
const structuredResults = await graph.query(`
  SELECT ?customer ?orderCount WHERE {
    ?customer a :Customer ;
              :totalOrders ?orderCount .
    FILTER (?orderCount > 100)
  }
`);

// Combine insights from both
```

---

## Related Resources

- [Vector Engine Guide](./blog-post.md) — Vector search, embeddings, and filtering
- [Performance Optimization Guide](./performance-optimization.md) — HNSW indexes and Map Merge
- [Cross-Encoding Reranking Guide](./cross-encoding-reranking.md) — Improving search quality
- [SAP HANA Knowledge Graph Guide](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide)
- [GitHub Repository](https://github.com/SAP/langchainjs-integration-for-sap-hana-cloud)

---

_Ready to build knowledge graph applications? Check out the [examples](https://github.com/SAP/langchainjs-integration-for-sap-hana-cloud/tree/main/examples/graphs) to see these features in action!_
