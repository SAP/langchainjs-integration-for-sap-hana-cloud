import { ChatOpenAI } from "@langchain/openai";
import hanaClient from "@sap/hana-client";
import {
  HanaRdfGraph,
  HanaRdfGraphOptions,
  HanaSparqlQAChain,
  HanaSparqlQAChainOptions,
} from "@sap/hana-langchain";
// or import another node.js driver
// import hanaClient from "hdb"

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

const graphOptions: HanaRdfGraphOptions = {
  connection: client,
  graphUri,
  autoExtractOntology: true,
};

// create a Graph instance from a source URI
const graph = new HanaRdfGraph({
  connection: client,
  graphUri: "http://example.com/graph",
  ontologyUri: "http://example.com/ontology",
});

// need to initialize once an instance is created.
await graph.initialize(graphOptions);

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });

const chainOptions: HanaSparqlQAChainOptions = {
  llm,
  allowDangerousRequests: true,
  graph,
};

const chain = HanaSparqlQAChain.fromLLM(chainOptions);

const query = "YOUR QUESTION HERE";

const response = await chain.invoke({ query });
console.log(response);
