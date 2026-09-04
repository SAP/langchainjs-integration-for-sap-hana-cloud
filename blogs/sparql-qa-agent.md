# Natural Language Queries on Knowledge Graphs with HanaSparqlQAAgent

SAP HANA Cloud's Knowledge Graph Engine stores rich relational data as RDF triples, capturing meaningful connections between entities. But querying this data requires SPARQL, a specialized graph query language that most application developers don't want to write by hand.

**HanaSparqlQAAgent** bridges natural language and SPARQL. It wraps the Knowledge Graph Engine in an agentic loop that automatically inspects your graph's ontology, generates the correct SPARQL query, executes it, and returns a human-readable answer — all from a plain English question.

To make this concrete, this guide uses the **Nobel Prize dataset** from [data.nobelprize.org](https://data.nobelprize.org): 993 laureates, 630 prizes, and 1,012 individual awards spanning every Nobel Prize from 1901 to the present.

---

## The Nobel Prize Knowledge Graph

The Nobel Prize Foundation publishes its data as RDF Linked Data using a purpose-built ontology at `http://data.nobelprize.org/terms/`. The graph connects laureates to prizes through award records, and links laureates to universities, cities, and countries through biographical properties.

The core structure looks like this:

```text
<laureate/6>  rdf:type        nobel:Laureate
<laureate/6>  foaf:name       "Marie Curie"
<laureate/6>  dbo:birthPlace  <city/Warsaw>
<laureate/6>  nobel:nobelPrize  <nobelprize/Physics/1903>
<laureate/6>  nobel:nobelPrize  <nobelprize/Chemistry/1911>

<nobelprize/Chemistry/1911>  rdf:type       nobel:NobelPrize
<nobelprize/Chemistry/1911>  nobel:year     "1911"
<nobelprize/Chemistry/1911>  nobel:category  nobel:Chemistry
<nobelprize/Chemistry/1911>  nobel:laureate  <laureate/6>
```

The prefixes are namespace abbreviations. `rdf:` is the W3C RDF standard, `foaf:` (Friend of a Friend) describes people and organizations, `dbo:` is the DBpedia ontology used for common properties like birth place, and `nobel:` is the Nobel Prize Foundation's own vocabulary at `http://data.nobelprize.org/terms/`.

Three classes carry all the meaningful data:

| Class                 | Description                                                                          | Count |
| --------------------- | ------------------------------------------------------------------------------------ | ----- |
| `nobel:Laureate`      | A person or organization that received a prize                                       | 993   |
| `nobel:NobelPrize`    | A prize awarded in a given year and category                                         | 630   |
| `nobel:LaureateAward` | The individual award record linking a laureate to a prize, with share and motivation | 1,012 |

---

## Setting Up the Graph

### Prerequisites

You need a SAP HANA Cloud instance with the **triple store** feature enabled. See the [Enable Triple Store guide](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/enable-triple-store/) for setup instructions.

### Loading the Nobel Prize data

The data comes from the [Nobel Prize Linked Data](https://data.nobelprize.org) published by the Nobel Prize Foundation. The foundation exposes their full dataset through a public SPARQL endpoint at `https://data.nobelprize.org/store/sparql`.

You can dump the entire graph with a single query. The endpoint returns CSV, so use `Accept: text/csv`:

```bash
curl -G "https://data.nobelprize.org/store/sparql" \
  --data-urlencode "query=SELECT DISTINCT ?s ?p ?o WHERE { ?s ?p ?o }" \
  -H "Accept: text/csv" \
  -o nobel_prizes.csv
```

The `SELECT DISTINCT` is important — each triple is stored in two named graphs by the platform (a main graph and a per-resource metadata graph), so without `DISTINCT` every triple appears twice.

Before inserting into HANA, two categories of triples need to be filtered out:

- **Blank nodes** — triples whose subject or object is an anonymous blank node (`_:b0`). Blank nodes have no stable URI so they cannot be matched in subsequent queries.
- **Invalid `xsd:date` literals** — the dataset uses partial dates like `"1956-00-00"^^xsd:date` for laureates whose exact birth date is unknown. HANA's triple store rejects month or day values of `00`.

Once filtered, insert the triples into a named graph using `INSERT DATA` via `SYS.SPARQL_EXECUTE`:

```typescript
const insertQuery = `
  INSERT DATA {
    GRAPH <nobelprizes> {
      <http://data.nobelprize.org/resource/laureate/6>
        a <http://data.nobelprize.org/terms/Laureate> ;
        <http://xmlns.com/foaf/0.1/name> "Marie Curie" .
      # ... remaining triples
    }
  }
`;

await new Promise<void>((resolve, reject) => {
  client.prepare("CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)", (err, stmt) => {
    if (err) return reject(err);
    stmt.exec({ REQUEST: insertQuery, PARAMETER: "" }, (err2: Error) =>
      err2 ? reject(err2) : resolve()
    );
  });
});
```

For large datasets, split the triples into multiple `INSERT DATA` statements rather than sending them all at once.

### Initializing HanaRdfGraph

With the data loaded, create a `HanaRdfGraph` pointing at the `nobelprizes` named graph:

```typescript
import hanaClient from "@sap/hana-client";
import { HanaRdfGraph, HanaRdfGraphOptions } from "@sap/hana-langchain";

const client = hanaClient.createConnection({
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
});

await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => (err ? reject(err) : resolve()));
});

const graphOptions: HanaRdfGraphOptions = {
  connection: client,
  graphUri: "nobelprizes",
  autoExtractOntology: true,
};

const graph = new HanaRdfGraph(graphOptions);
await graph.initialize(graphOptions);
```

`autoExtractOntology: true` runs a built-in SPARQL CONSTRUCT query that derives the OWL schema from your data — the simplest way to get started without a separate ontology file.

---

## Using HanaSparqlQAAgent

### Basic Usage

```typescript
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import {
  HanaRdfGraph,
  HanaSparqlQAAgent,
  HanaSparqlQAAgentOptions,
} from "@sap/hana-langchain";

// ... graph setup from above

const llm = new AzureOpenAiChatClient({ modelName: "gpt-4o" });
// const llm = new ChatOpenAI({ model: "gpt-4o" });

const agentConfig: HanaSparqlQAAgentOptions = { graph };
const agent = HanaSparqlQAAgent.createAgent(llm, agentConfig);

const result = await agent.invoke({
  messages: [
    { role: "user", content: "Who won the Nobel Prize in Literature in 1947?" },
  ],
});
console.log(result.messages.at(-1)?.content);
```

```text
André Gide won the Nobel Prize in Literature in 1947, for his comprehensive
and artistically significant writings, in which human problems and conditions
have been presented with a fearless love of truth and keen psychological insight.
```

`createAgent` is a static factory that constructs the internal agent instance, registers the built-in tools, and returns a LangChain agent ready to invoke or stream.

---

## How the Agent Works

`HanaSparqlQAAgent` is built on the **ReAct** loop (Reasoning + Acting), a pattern where the model alternates between thinking and taking actions until it has enough information to answer.

```text
                      request
                         │
                         ▼
            ┌───────────────────────┐
   action ··│         model         │· · · ·┐
          · └───────────────────────┘       ·
          ·              ▲                  ·
          ▼  observation │                  ▼
    ┌──────────┐         │             ┌──────────┐
    │  tools   │─────────┘             │  result  │
    └──────────┘                       └──────────┘
```

The loop repeats until the model decides it has enough information, at which point it produces a result instead of another tool call. For most Nobel Prize questions this takes exactly two turns — one to read the schema, one to run the query — but the model can make additional tool calls if the first query returns ambiguous or incomplete results.

In practice the two-step pattern looks like this:

```text
User Question
      │
      ▼
┌─────────────────────┐
│  retrieveOntology   │  Returns the graph's OWL schema in Turtle format
│  (tool call 1)      │  Agent learns: Laureate, NobelPrize, LaureateAward classes;
│                     │  foaf:name, nobel:year, nobel:category, dbo:birthPlace, etc.
└─────────────────────┘
      │
      ▼
┌─────────────────────┐
│  executeSparql      │  Runs the generated SELECT query against HANA
│  (tool call 2)      │  Returns raw CSV result
└─────────────────────┘
      │
      ▼
Natural language answer synthesized from results
```

**`retrieveOntology`** returns the graph's OWL schema in Turtle format. The agent reads this to understand what classes and properties exist before writing any query.

**`executeSparql`** accepts a SPARQL SELECT query string, automatically injects the correct `FROM <nobelprizes>` clause, and returns the raw result set.

The built-in system prompt enforces a hard rule: only SELECT queries can be generated. No INSERT, UPDATE, or DELETE.

---

> **Note:** LLM outputs are non-deterministic — the exact SPARQL generated and the phrasing of answers will vary between runs. More capable models generally produce more accurate queries and more reliable answers.

## Querying the Graph

### Simple lookups

```typescript
const result = await agent.invoke({
  messages: [
    { role: "user", content: "Who won the Nobel Prize in Physics in 2018?" },
  ],
});
console.log(result.messages.at(-1)?.content);
```

```text
The Nobel Prize in Physics 2018 was awarded to three scientists:

- Arthur Ashkin (Bell Laboratories, USA)
- Gérard Mourou (École Polytechnique, France / University of Michigan, USA)
- Donna Strickland (University of Waterloo, Canada)
```

### Multi-hop traversal

Questions that follow relationship chains across multiple nodes — for example, linking a laureate to their birthplace through the graph:

```typescript
const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content:
        "In which city was Marie Curie born, and how many Nobel Prizes did she win?",
    },
  ],
});
console.log(result.messages.at(-1)?.content);
```

```text
Marie Curie was born in Warsaw, Poland. She won two Nobel Prizes:
the Nobel Prize in Physics in 1903 and the Nobel Prize in Chemistry in 1911,
making her the first person to win Nobel Prizes in two different sciences.
```

### Aggregation queries

The agent generates GROUP BY and ORDER BY SPARQL automatically:

```typescript
const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content: "Which university has produced the most Nobel laureates?",
    },
  ],
});
console.log(result.messages.at(-1)?.content);
```

```text
The University of California has produced the most Nobel laureates,
with 42 laureates affiliated with the university.
```

### Questions about data not in the graph

The agent responds honestly rather than hallucinating:

```typescript
const result = await agent.invoke({
  messages: [
    {
      role: "user",
      content: "Who won the Nobel Prize in Artificial Intelligence?",
    },
  ],
});
console.log(result.messages.at(-1)?.content);
```

```text
There is no Nobel Prize in Artificial Intelligence in the available data.
The Nobel Prize categories are Physics, Chemistry, Physiology or Medicine,
Literature, Peace, and Economic Sciences.
```

---

## Streaming Responses

For interactive applications, use `agent.stream` with `streamMode: "messages"` to receive tokens as they arrive:

```typescript
const query = "Which scientists have won more than one Nobel Prize?";

for await (const [chunk] of await agent.stream(
  { messages: [{ role: "user", content: query }] },
  { streamMode: "messages" }
)) {
  if (chunk.content) process.stdout.write(chunk.text);
}
```

```text
Several scientists have won more than one Nobel Prize:

- Marie Curie — Physics (1903) and Chemistry (1911)
- John Bardeen — Physics (1956) and Physics (1972)
- Linus Pauling — Chemistry (1954) and Peace (1962)
- Frederick Sanger — Chemistry (1958) and Chemistry (1980)
- K. Barry Sharpless — Chemistry (2001) and Chemistry (2022)

The International Committee of the Red Cross has received three Nobel Peace Prizes
(1917, 1944, and 1963).
```

This pattern is recommended for user-facing applications where you want to start displaying results before the full answer is ready.

---

## Customizing the Agent

### Adding Custom Tools

Supply additional tools that will be available alongside the built-in ontology and SPARQL tools:

```typescript
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const currentYearTool = tool(() => String(new Date().getFullYear()), {
  name: "getCurrentYear",
  description: "Returns the current year as a number.",
  schema: z.object({}),
});

const agentConfig: HanaSparqlQAAgentOptions = {
  graph,
  tools: [currentYearTool],
};
```

### Custom System Prompt

Override the default prompt to focus the agent on a specific domain:

```typescript
import { SYSTEM_PROMPT } from "@sap/hana-langchain";
const agentConfig: HanaSparqlQAAgentOptions = {
  graph,
  systemPrompt: `You are a Nobel Prize historian. When answering, always mention
the year of the prize and the laureate's institutional affiliation if available.
${SYSTEM_PROMPT}`,
};
```

### Disabling Default Tools or Middleware

For full control over the agent's tool set or retry behavior:

```typescript
const agentConfig: HanaSparqlQAAgentOptions = {
  graph,
  includeDefaultTools: false, // Supply your own tools entirely
  includeDefaultMiddleware: false, // Supply your own middleware
  tools: [myOntologyTool, mySparqlTool],
  middleware: [myRateLimiter],
};
```

---

## When to Use HanaSparqlQAAgent

**Reach for `HanaSparqlQAAgent` when:**

- Your data is modeled as RDF triples in a HANA Cloud triple store
- You want to expose a knowledge graph to users who don't know SPARQL
- Questions may require multi-hop traversal, joins, or aggregations across the graph
- You need a conversational interface that reasons about entity relationships

**Consider alternatives when:**

- Your data is in relational tables — use a SQL-generating chain instead
- You need deterministic, hand-tuned queries — call `graph.query()` directly for full control
- You want a lighter-weight approach without an agentic loop — `HanaSparqlQAChain` provides a simpler chain-based alternative

---

## Best Practices

### 1. Use Read-Only Database Credentials

The agent is instructed to generate only SELECT queries, but the strongest defense is database-level enforcement. Connect with credentials scoped to read-only access on your target graphs:

```typescript
const client = hanaClient.createConnection({
  host: process.env.HANA_DB_ADDRESS,
  user: process.env.HANA_DB_READONLY_USER,
  password: process.env.HANA_DB_READONLY_PASSWORD,
});
```

### 2. Inspect the Extracted Schema Before Deploying

Before deploying the agent, verify that the ontology it receives accurately reflects your data model. Incomplete schemas lead to incomplete queries:

```typescript
import { Writer } from "n3";

const schemaStore = graph.getSchema();
const writer = new Writer({
  prefixes: {
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    owl: "http://www.w3.org/2002/07/owl#",
  },
});
schemaStore.forEach((quad) => writer.addQuad(quad));
writer.end((_, result) => console.log("Ontology:\n", result));
```

```text
Ontology:
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix owl: <http://www.w3.org/2002/07/owl#>.

<http://data.nobelprize.org/terms/Laureate> a owl:Class;
    rdfs:label "Laureate".
<http://data.nobelprize.org/terms/NobelPrize> a owl:Class;
    rdfs:label "NobelPrize".
<http://data.nobelprize.org/terms/nobelPrize> a owl:ObjectProperty;
    rdfs:domain <http://data.nobelprize.org/terms/Laureate>;
    rdfs:range <http://data.nobelprize.org/terms/NobelPrize>.
...
```

### 3. Add RDFS Labels to All Classes and Properties

Include `rdfs:label` on your classes and properties. The system prompt instructs the agent to always retrieve labels when they exist — answers synthesized from human-readable names are significantly better than answers built from raw URIs.

### 4. Use a Custom Ontology Query for Complex Graphs

When `autoExtractOntology` produces an incomplete or noisy schema for a large graph, write a targeted CONSTRUCT query:

```typescript
const graphOptions: HanaRdfGraphOptions = {
  connection: client,
  graphUri: "nobelprizes",
  ontologyQuery: `
    CONSTRUCT { ?s ?p ?o }
    WHERE {
      GRAPH <nobel_ontology> { ?s ?p ?o }
    }
  `,
};
```

---

## Related Resources

- [Knowledge Graph Engine Guide](./knowledge-graph-engine.md) — Connecting to the HANA triple store with `HanaRdfGraph` and running SPARQL queries
- [Vector Engine Guide](./blog-post.md) — Vector search, embeddings, and filtering
- [Cross-Encoding Reranking Guide](./cross-encoding-reranking.md) — Improving search precision with cross-encoders
- [Performance Optimization Guide](./performance-optimization.md) — HNSW indexes and Map Merge
- [GitHub Repository](https://github.com/SAP/langchainjs-integration-for-sap-hana-cloud)
