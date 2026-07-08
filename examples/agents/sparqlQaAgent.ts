import { ChatOpenAI } from "@langchain/openai";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { Writer } from "n3";
import hanaClient from "@sap/hana-client";
import {
  HanaRdfGraph,
  HanaRdfGraphOptions,
  HanaSparqlQAAgent,
  HanaSparqlQAAgentOptions,
} from "@sap/hana-langchain";
// or import another node.js driver
// import hanaClient from "hdb"

/* eslint-disable no-process-env */
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};

const client = hanaClient.createConnection(connectionParams);

// connect to hanaDB
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => {
    // Use arrow function here
    if (err) {
      reject(err);
    } else {
      console.log("Connected to SAP HANA successfully.");
      resolve();
    }
  });
});

/*
Prerequisite:  
You must have an SAP HANA Cloud instance with the **triple store** feature enabled.  
For detailed instructions, refer to: [Enable Triple Store](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/enable-triple-store/)<br />
Load the `kgdocu_movies` example data. See [Knowledge Graph Example](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/knowledge-graph-example).

Below we’ll:

1. Instantiate the `HanaRdfGraph` pointing at our “movies” data graph  
2. Wrap it in a `HanaSparqlQAAgent` powered by an LLM  
3. Ask natural-language questions and print out the agent's responses 
*/

const graphOptions: HanaRdfGraphOptions = {
  connection: client,
  graphUri: "kgdocu_movies",
  autoExtractOntology: true,
};

// create a Graph instance from a source URI
const graph = new HanaRdfGraph(graphOptions);

// need to initialize once an instance is created.
await graph.initialize(graphOptions);

// Serialise the graph schema (optional)
// Internally, the schema is stored as an N3 Store instance,
// We use the N3 Writer to serialise it to Turtle format for display.
const schemaStore = graph.getSchema();
const writer = new Writer({
  prefixes: {
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rdfs: "http://www.w3.org/2000/01/rdf-schema#",
    owl: "http://www.w3.org/2002/07/owl#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
  },
});
schemaStore.forEach((quad) => {
  writer.addQuad(quad);
});
writer.end((error, result) => {
  if (error) {
    console.error("Error serialising schema:", error);
  } else {
    console.log("Graph Schema in Turtle format:\n", result);
  }
});
/*
Graph Schema in Turtle format:
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix owl: <http://www.w3.org/2002/07/owl#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<http://kg.demo.sap.com/Place> a owl:Class;
    rdfs:label "Place".
rdfs:label a owl:DatatypeProperty;
    rdfs:label "label";
    rdfs:domain <http://kg.demo.sap.com/Place>, <http://kg.demo.sap.com/Actor>, <http://kg.demo.sap.com/Director>, <http://kg.demo.sap.com/Genre>;
    rdfs:range xsd:string.
<http://kg.demo.sap.com/Actor> a owl:Class;
    rdfs:label "Actor".
<http://kg.demo.sap.com/Film> a owl:Class;
    rdfs:label "Film".
<http://kg.demo.sap.com/Director> a owl:Class;
    rdfs:label "Director".
<http://kg.demo.sap.com/Genre> a owl:Class;
    rdfs:label "Genre".
<http://kg.demo.sap.com/dateOfBirth> a owl:DatatypeProperty;
    rdfs:label "dateOfBirth";
    rdfs:domain <http://kg.demo.sap.com/Actor>;
    rdfs:range xsd:dateTime.
<http://kg.demo.sap.com/placeOfBirth> a owl:ObjectProperty;
    rdfs:label "placeOfBirth";
    rdfs:domain <http://kg.demo.sap.com/Actor>;
    rdfs:range <http://kg.demo.sap.com/Place>.
<http://kg.demo.sap.com/title> a owl:DatatypeProperty;
    rdfs:label "title";
    rdfs:domain <http://kg.demo.sap.com/Film>;
    rdfs:range xsd:string.
<http://kg.demo.sap.com/directed> a owl:ObjectProperty;
    rdfs:label "directed";
    rdfs:domain <http://kg.demo.sap.com/Director>;
    rdfs:range <http://kg.demo.sap.com/Film>.
<http://kg.demo.sap.com/acted_in> a owl:ObjectProperty;
    rdfs:label "acted_in";
    rdfs:domain <http://kg.demo.sap.com/Actor>;
    rdfs:range <http://kg.demo.sap.com/Film>.
<http://kg.demo.sap.com/genre> a owl:ObjectProperty;
    rdfs:label "genre";
    rdfs:domain <http://kg.demo.sap.com/Film>;
    rdfs:range <http://kg.demo.sap.com/Genre>.
*/

// Initialise the LLM
// const llm = new ChatOpenAI({ model: "gpt-4o" });
const llm = new AzureOpenAiChatClient({ modelName: "gpt-4o" });

const agentConfig: HanaSparqlQAAgentOptions = {
  graph: graph,
};

// Initialize the QA agent
const agent = HanaSparqlQAAgent.createAgent(llm, agentConfig);

const query = "which actors acted in Blade Runner?";
// const query = "Which movies are in the data?"
// const query = "In which movies did Keanu Reeves and Carrie-Anne Moss play in together"
// const query = "which movie genres are in the data?"
// const query = "which are the two most assigned movie genres?"
// const query = "where were the actors of 'Blade Runner' born?"
// const query = "which actors acted together in a movie and were born in the same city?"

console.log("\n--- Streamed (messages: token-by-token) ---");
for await (const [chunk, _metadata] of await agent.stream(
  { messages: [{ role: "user", content: query }] },
  { streamMode: "messages" }
)) {
  if (chunk.content) {
    process.stdout.write(chunk.text);
  }
}
console.log();
/*
--- Streamed (messages: token-by-token) ---
Ontology Information:
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix owl: <http://www.w3.org/2002/07/owl#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<http://kg.demo.sap.com/Actor> a owl:Class;
    rdfs:label "Actor".
rdfs:label a owl:DatatypeProperty;
    rdfs:label "label";
    rdfs:domain <http://kg.demo.sap.com/Actor>, <http://kg.demo.sap.com/Place>, <http://kg.demo.sap.com/Genre>, <http://kg.demo.sap.com/Director>;
    rdfs:range xsd:string.
<http://kg.demo.sap.com/Film> a owl:Class;
    rdfs:label "Film".
<http://kg.demo.sap.com/Place> a owl:Class;
    rdfs:label "Place".
<http://kg.demo.sap.com/Genre> a owl:Class;
    rdfs:label "Genre".
<http://kg.demo.sap.com/Director> a owl:Class;
    rdfs:label "Director".
<http://kg.demo.sap.com/dateOfBirth> a owl:DatatypeProperty;
    rdfs:label "dateOfBirth";
    rdfs:domain <http://kg.demo.sap.com/Actor>;
    rdfs:range xsd:dateTime.
<http://kg.demo.sap.com/placeOfBirth> a owl:ObjectProperty;
    rdfs:label "placeOfBirth";
    rdfs:domain <http://kg.demo.sap.com/Actor>;
    rdfs:range <http://kg.demo.sap.com/Place>.
<http://kg.demo.sap.com/title> a owl:DatatypeProperty;
    rdfs:label "title";
    rdfs:domain <http://kg.demo.sap.com/Film>;
    rdfs:range xsd:string.
<http://kg.demo.sap.com/acted_in> a owl:ObjectProperty;
    rdfs:label "acted_in";
    rdfs:domain <http://kg.demo.sap.com/Actor>;
    rdfs:range <http://kg.demo.sap.com/Film>.
<http://kg.demo.sap.com/directed> a owl:ObjectProperty;
    rdfs:label "directed";
    rdfs:domain <http://kg.demo.sap.com/Director>;
    rdfs:range <http://kg.demo.sap.com/Film>.
<http://kg.demo.sap.com/genre> a owl:ObjectProperty;
    rdfs:label "genre";
    rdfs:domain <http://kg.demo.sap.com/Film>;
    rdfs:range <http://kg.demo.sap.com/Genre>.
SPARQL Query Result:
actorLabel
William Sanderson
Morgan Paull
James Hong
Daryl Hannah
M. Emmet Walsh
Brion James
Q81328
Rutger Hauer
Joanna Cassidy
Hy Pyke
Sean Young
Edward James Olmos
Joe Turkel
In the movie "Blade Runner," the following actors were part of the cast:

- William Sanderson
- Morgan Paull
- James Hong
- Daryl Hannah
- M. Emmet Walsh
- Brion James
- Rutger Hauer
- Joanna Cassidy
- Hy Pyke
- Sean Young
- Edward James Olmos
- Joe Turkel
*/

// Disconnect from SAP HANA after the operations
client.disconnect();
