import hanaClient, { HanaParameterList } from "@sap/hana-client";
import { HanaRdfGraph } from "@sap/hana-langchain";
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

// let us insert data into a graph named Puppets
await new Promise<void>((resolve, reject) => {
  const sparqlQuery = `CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)`;
  client.prepare(sparqlQuery, (err: Error, stmt) => {
    if (err) {
      reject(err);
    } else {
      const query = `
      INSERT DATA {
        GRAPH <Puppets> {
            <P1> a <Puppet>; <name> "Ernie"; <show> "Sesame Street".
            <P2> a <Puppet>; <name> "Bert"; <show> "Sesame Street" .
            }
        }`;
      const params: HanaParameterList = {
        REQUEST: query,
        PARAMETER: "",
      };
      stmt?.exec(params, (err: Error) => {
        if (err) {
          reject(err);
        } else {
          resolve(stmt.getParameterValue(2));
        }
      });
    }
  });
});

const graphOptions = {
  connection: client,
  graphUri: "Puppets",
  autoExtractOntology: true,
};

// create a Graph instance from a source URI
const graph = new HanaRdfGraph(graphOptions);

// need to initialize once an instance is created.
await graph.initialize(graphOptions);

// Run a query on the graph
const results = await graph.query(`
SELECT ?s ?p ?o
WHERE {
    GRAPH <Puppets> {
        ?s ?p ?o .
    }
}
ORDER BY ?s`);
console.log(results);
/*
s,p,o
P1,name,Ernie
P1,show,Sesame Street
P1,http://www.w3.org/1999/02/22-rdf-syntax-ns#type,Puppet
P2,name,Bert
P2,show,Sesame Street
P2,http://www.w3.org/1999/02/22-rdf-syntax-ns#type,Puppet
*/
