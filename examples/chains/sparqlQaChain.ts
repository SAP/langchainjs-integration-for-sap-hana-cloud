import { ChatOpenAI } from "@langchain/openai";
import { Writer } from "n3";
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

/*
Prerequisite:  
You must have an SAP HANA Cloud instance with the **triple store** feature enabled.  
For detailed instructions, refer to: [Enable Triple Store](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/enable-triple-store/)<br />
Load the `kgdocu_movies` example data. See [Knowledge Graph Example](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-knowledge-graph-guide/knowledge-graph-example).

Below we’ll:

1. Instantiate the `HanaRdfGraph` pointing at our “movies” data graph  
2. Wrap it in a `HanaSparqlQAChain` powered by an LLM  
3. Ask natural-language questions and print out the chain’s responses 
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
const llm = new ChatOpenAI({ model: "gpt-4o" });

const chainOptions: HanaSparqlQAChainOptions = {
  llm,
  allowDangerousRequests: true,
  graph,
  debug: true,
};

// Initialize the QA chain
const chain = HanaSparqlQAChain.fromLLM(chainOptions);

const query = "which actors acted in Blade Runner?";
// const query = "Which movies are in the data?"
// const query = "In which movies did Keanu Reeves and Carrie-Anne Moss play in together"
// const query = "which movie genres are in the data?"
// const query = "which are the two most assigned movie genres?"
// const query = "where were the actors of 'Blade Runner' born?"
// const query = "which actors acted together in a movie and were born in the same city?"

const response = await chain.invoke({ query });
console.log(response["result"]);
/*
Generated SPARQL:
```sparql
PREFIX kg: <http://kg.demo.sap.com/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?actor ?actorLabel
WHERE {
    ?movie rdf:type kg:Film .
    ?movie kg:title "Blade Runner" .
    ?actor kg:acted_in ?movie .
    ?actor rdfs:label ?actorLabel .
}
```
Final SPARQL:

      
PREFIX kg: <http://kg.demo.sap.com/>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?actor ?actorLabel

      FROM <kgdocu_movies>
      WHERE {
    ?movie rdf:type kg:Film .
    ?movie kg:title "Blade Runner" .
    ?actor kg:acted_in ?movie .
    ?actor rdfs:label ?actorLabel .
}

    
Full Context:
actor,actorLabel
http://www.wikidata.org/entity/Q1353691,Morgan Paull
http://www.wikidata.org/entity/Q1372770,William Sanderson
http://www.wikidata.org/entity/Q358990,James Hong
http://www.wikidata.org/entity/Q723780,Brion James
http://www.wikidata.org/entity/Q81328,Q81328
http://www.wikidata.org/entity/Q498420,M. Emmet Walsh
http://www.wikidata.org/entity/Q1691628,Joe Turkel
http://www.wikidata.org/entity/Q207596,Daryl Hannah
http://www.wikidata.org/entity/Q236702,Joanna Cassidy
http://www.wikidata.org/entity/Q213574,Rutger Hauer
http://www.wikidata.org/entity/Q3143555,Hy Pyke
http://www.wikidata.org/entity/Q230736,Sean Young
http://www.wikidata.org/entity/Q211415,Edward James Olmos

The actors who acted in Blade Runner include Morgan Paull, William Sanderson, James Hong, Brion James, M. Emmet Walsh, Joe Turkel, Daryl Hannah, Joanna Cassidy, Rutger Hauer, Hy Pyke, Sean Young, and Edward James Olmos.
*/

// Disconnect from SAP HANA after the operations
client.disconnect();
