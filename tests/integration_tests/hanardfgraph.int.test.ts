import dedent from "dedent";
import * as path from "path";
import * as fs from "fs";
import { Parser as N3Parser, Store as N3Store } from "n3";
import { isomorphic } from "rdf-isomorphic";
import hanaClient, { Connection } from "@sap/hana-client";
import { fileURLToPath } from "url";
import { HanaTestUtils } from "./hanavector.test.utils.js";
import {
  HanaRdfGraph,
  HanaRdfGraphOptions,
} from "../../src/graphs/hanaRdfGraph.js";
import { executeSparqlQuery } from "../../src/hanautils.js";

/* eslint-disable no-process-env */
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};

class Config {
  client: Connection;

  constructor(client: Connection) {
    this.client = client;
  }
}

let config: Config;

beforeAll(async () => {
  expect(process.env.HANA_DB_ADDRESS).toBeDefined();
  expect(process.env.HANA_DB_PORT).toBeDefined();
  expect(process.env.HANA_DB_USER).toBeDefined();
  expect(process.env.HANA_DB_PASSWORD).toBeDefined();
  const client = hanaClient.createConnection(connectionParams);

  await HanaTestUtils.connectToHANA(client);
  config = new Config(client);
});

afterAll(async () => {
  config.client.disconnect();
});

function getExpectedSchemaGraph(): N3Store {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const ontologyLocalFilePath = path.join(
    __dirname,
    "fixtures",
    "hana_rdf_graph_sample_schema.ttl"
  );
  const ttlData = fs.readFileSync(ontologyLocalFilePath, "utf-8");
  const parser = new N3Parser({ format: "text/turtle" });
  const quads = parser.parse(ttlData);
  const store = new N3Store();
  store.addQuads(quads);
  return store;
}

test("hana rdf graph default creation", async () => {
  const args: HanaRdfGraphOptions = {
    connection: config.client,
    autoExtractOntology: true,
  };

  const graph = new HanaRdfGraph(args);
  await graph.initialize(args);
  expect(graph).toBeDefined();
});

test("hana rdf graph creation with default graph uri", async () => {
  const args: HanaRdfGraphOptions = {
    connection: config.client,
    graphUri: "DEFAULT",
    autoExtractOntology: true,
  };

  const graph = new HanaRdfGraph(args);
  await graph.initialize(args);
  expect(graph).toBeDefined();
});

describe("example graph tests", () => {
  const graphUri = "http://example.com/graph";
  let graph: HanaRdfGraph;
  beforeEach(async () => {
    const query = `
        PREFIX ex: <http://example.com/>
        INSERT DATA {
        GRAPH <${graphUri}> {
            <P1> a ex:Puppet; ex:name "Ernie"; ex:show "Sesame Street".
            <P2> a ex:Puppet; ex:name "Bert"; ex:show "Sesame Street" .
            }
        }
        `;
    await executeSparqlQuery(config.client, query, "");

    const args: HanaRdfGraphOptions = {
      connection: config.client,
      graphUri,
      autoExtractOntology: true,
    };

    graph = new HanaRdfGraph(args);
    await graph.initialize(args);
  });
  afterEach(async () => {
    const query = `
        DROP GRAPH <${graphUri}>
        `;
    await executeSparqlQuery(config.client, query, "");
  });

  test("hana rdf graph creation with graph uri", async () => {
    expect(graph).toBeDefined();
  });

  test("hana rdf graph query", async () => {
    const query = `
        PREFIX ex: <http://example.com/>
        SELECT ?s ?name ?show
        FROM ex:graph
        WHERE {
            ?s a ex:Puppet ;
            ex:name ?name ;
            ex:show ?show .
            }
        ORDER BY ?s
        `;

    const expectedCsv = dedent(`
            s,name,show
            P1,Ernie,Sesame Street
            P2,Bert,Sesame Street
        `);
    const response = await graph.query(query);
    const trimmedResponse = response.replace(/\r\n/g, "\n").trim();
    expect(trimmedResponse).toBe(expectedCsv.trim());
  });
});

test("hana rdf graph creation with ontology uri", async () => {
  const ontologyUri = "http://example.com/ontology";

  let query = `
    PREFIX owl: <http://www.w3.org/2002/07/owl#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    PREFIX ex: <http://example.com/>

    INSERT DATA {
    GRAPH ex:ontology {

        # Define class ex:Puppet
        ex:Puppet a owl:Class ;
                rdfs:label "Puppet" .

        # Define property ex:name
        ex:name a owl:DatatypeProperty ;
                rdfs:label "name" ;
                rdfs:domain ex:Puppet ;
                rdfs:range xsd:string .

        # Define property ex:show
        ex:show a owl:DatatypeProperty ;
                rdfs:label "show" ;
                rdfs:domain ex:Puppet ;
                rdfs:range xsd:string .
        }
    }
    `;
  await executeSparqlQuery(config.client, query, "");

  const args: HanaRdfGraphOptions = {
    connection: config.client,
    ontologyUri,
  };

  const graph = new HanaRdfGraph(args);
  await graph.initialize(args);
  expect(graph).toBeDefined();

  const expectedSchemaGraph = getExpectedSchemaGraph();

  expect(
    isomorphic(
      graph.getSchema().getQuads(null, null, null, null),
      expectedSchemaGraph.getQuads(null, null, null, null)
    )
  ).toBe(true);

  query = `
    DROP GRAPH <${ontologyUri}>
    `;
  await executeSparqlQuery(config.client, query, "");
});

test("hana rdf graph creation with ontology file", async () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const ontologyLocalFilePath = path.join(
    __dirname,
    "fixtures",
    "hana_rdf_graph_sample_schema.ttl"
  );

  const args: HanaRdfGraphOptions = {
    connection: config.client,
    ontologyLocalFile: ontologyLocalFilePath,
    ontologyLocalFileFormat: "turtle",
  };

  const graph = new HanaRdfGraph(args);
  await graph.initialize(args);
  expect(graph).toBeDefined();

  const expectedSchemaGraph = getExpectedSchemaGraph();

  expect(
    isomorphic(
      graph.getSchema().getQuads(null, null, null, null),
      expectedSchemaGraph.getQuads(null, null, null, null)
    )
  ).toBe(true);
});
