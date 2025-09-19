import { ChatOpenAI } from "@langchain/openai";
import { HanaSparqlQAChain } from "@sap/hana-langchain/chains";
import hanaClient from "@sap/hana-client";
import { HanaRdfGraph } from "@sap/hana-langchain/graphs";
// or import another node.js driver
// import hanaClient from "hdb"

const connectionParams = {
  host: process.env.HANA_HOST,
  port: process.env.HANA_PORT,
  user: process.env.HANA_UID,
  password: process.env.HANA_PWD,
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

// create a Graph instance from a source URI
const graph = new HanaRdfGraph({
    connection: client,
    graphUri: 'http://example.com/graph',
    ontologyUri: 'http://example.com/ontology'
});

// need to initialize once an instance is created.
await graph.initialize();

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });

const chain = HanaSparqlQAChain.fromLLM({
    llm,
    allowDangerousRequests: true,
    graph
});

const query = "YOUR QUESTION HERE";

const response = await chain.invoke({ query });
console.log(response);