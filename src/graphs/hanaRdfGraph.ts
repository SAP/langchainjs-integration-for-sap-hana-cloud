import { DatasetCore } from "@rdfjs/types";
import { Connection } from "@sap/hana-client";
import { Parser } from "sparqljs";
import { promises as fs, createReadStream, PathLike } from "fs";
import { Readable } from "stream";
import rdf from "rdf-ext";
import { rdfParser } from "rdf-parse";
import { executeProcedureStatement, prepareQuery } from "../hanautils.js";

/**
 * Options for initializing HanaRdfGraph
 */
interface HanaRdfGraphOptions {
  connection: Connection;
  graphUri?: string;
  ontologyQuery?: string;
  ontologyUri?: string;
  ontologyLocalFile?: string;
  ontologyLocalFileFormat?: string;
  autoExtractOntology?: boolean;
}

/**
 * SAP HANA CLOUD Knowledge Graph Engine Wrapper
 *
 * This class connects to a SAP HANA Graph SPARQL endpoint, executes queries,
 * and loads or generates ontology/schema data via one of four methods:
 *
 * 1. `ontologyQuery`: Provide a SPARQL CONSTRUCT query to extract the schema.
 * 2. `ontologyUri`: Specify a remote ontology graph URI.
 * 3. `ontologyLocalFile`: Load the schema from a local RDF file.
 * 4. `autoExtractOntology`: When true and no schema source is provided,
 *     run a built-in generic CONSTRUCT query to infer the schema.
 *
 * @example
 * ```ts
 * const conn = hanaClient.createConnection();
 * conn.connect({
 *   serverNode: 'your-host:30015',
 *   uid: 'your-username',
 *   pwd: 'your-password',
 * });
 *
 * const graph = new HanaRdfGraph({
 *   connection: conn,
 *   graphUri: 'http://example.com/graph',
 *   ontologyUri: 'http://example.com/ontology'
 * });
 * await graph.initialize();
 *
 * const results = await graph.query('SELECT ?s ?p ?o WHERE { ?s ?p ?o }');
 * console.log(results);
 * ```
 *
 * @security
 * Use narrowly-scoped credentials with read-only access to avoid accidental
 * data modification or exposure of sensitive data.
 */
export class HanaRdfGraph {
  private connection: Connection;

  private graphUri: string;

  private schema: string = "";

  /**
   * Creates a new HanaRdfGraph instance.
   *
   * @param options Initialization options for the RDF graph wrapper
   */
  constructor(options: HanaRdfGraphOptions) {
    this.connection = options.connection;
    this.graphUri = options.graphUri ?? "DEFAULT";
  }

  async initialize(options: HanaRdfGraphOptions) {
    await this.checkConnectivity();
    await this.refreshSchema({
      ontologyQuery: options.ontologyQuery,
      ontologyUri: options.ontologyUri,
      ontologyLocalFile: options.ontologyLocalFile,
      ontologyLocalFileFormat: options.ontologyLocalFileFormat,
      autoExtractOntology: options.autoExtractOntology ?? false,
    });
  }

  /**
   * Injects a FROM clause into a SPARQL query if none is present.
   *
   * @param query The original SPARQL query.
   * @returns Modified query with FROM clause added.
   * @throws Error if no WHERE clause is found in the query.
   */
  injectFromClause(query: string): string {
    if (/FROM/i.test(query)) return query;

    const fromClause =
      this.graphUri === "DEFAULT" ? "FROM DEFAULT" : `FROM <${this.graphUri}>`;
    const whereIndex = query.search(/\bWHERE\b/i);

    if (whereIndex === -1) {
      throw new Error("SPARQL query does not contain a WHERE clause.");
    }

    return `
      ${query.slice(0, whereIndex)}
      ${fromClause}
      ${query.slice(whereIndex)}
    `;
  }

  /**
   * Executes a SPARQL query against the HANA SPARQL engine.
   *
   * @param query The SPARQL query string.
   * @param injectFrom Whether to automatically inject a FROM clause.
   * @param contentType The expected response content type.
   * @returns The raw query result as a string.
   */
  async query(
    query: string,
    injectFrom: boolean = true,
    contentType: string = "application/sparql-results+csv"
  ): Promise<string> {
    const finalQuery = injectFrom ? this.injectFromClause(query) : query;
    const headers = `Accept: ${contentType}\r\nContent-Type: application/sparql-query`;
    const sql = "CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)";
    const stmt = await prepareQuery(this.connection, sql);

    const result = await executeProcedureStatement(stmt, [
      finalQuery,
      headers,
      "",
      null,
    ]);

    return result[2];
  }

  /**
   * Ensures that the specified graph exists in HANA.
   *
   * @throws Error if the graph does not exist or connectivity fails.
   */
  private async checkConnectivity() {
    const fromClause =
      this.graphUri !== "DEFAULT" ? `FROM <${this.graphUri}>` : "";
    const askQuery = `ASK ${fromClause} { ?s ?p ?o }`;

    const response = await this.query(askQuery, false);
    if (response.trim() === "false") {
      throw new Error(`No named graph found for URI: '${this.graphUri}'`);
    }
  }

  /**
   * Load an ontology schema by executing a SPARQL CONSTRUCT query.
   *
   * @param ontologyQuery A valid SPARQL CONSTRUCT query.
   * @returns RDF dataset containing the ontology triples.
   */
  private async loadOntologySchemaGraphFromQuery(
    ontologyQuery: string
  ): Promise<DatasetCore> {
    HanaRdfGraph.validateConstructQuery(ontologyQuery);
    const response = await this.query(ontologyQuery, false, "");
    const stringStream = new Readable({
      read() {
        this.push(response); // push the string data
        this.push(null); // signal the end of the stream
      },
    });
    const graph = rdf.dataset();

    const quadStream = rdfParser.parse(stringStream, {
      contentType: "text/turtle",
    });
    for await (const quad of quadStream) {
      graph.add(quad);
    }

    return graph;
  }

  /**
   * Parse the ontology schema statements from provided file
   *
   * @param localFile File system path to RDF file.
   * @param fileFormat RDF content type (e.g., 'text/turtle').
   * @returns RDF dataset parsed from the file.
   */
  private async loadOntologySchemaFromFile(
    localFile: PathLike,
    fileFormat: string = "text/turtle"
  ): Promise<DatasetCore> {
    try {
      await fs.readFile(localFile, "utf8");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      if (err.code === "ENOENT") {
        throw new Error(`File does not exist: ${localFile}`);
      } else if (err.code === "EACCES" || err.code === "EPERM") {
        throw new Error(`No read permission for file: ${localFile}`);
      } else {
        throw new Error(`Error reading file: ${err.message}`);
      }
    }

    const fileStream = createReadStream(localFile);

    const dataset = rdf.dataset();

    const quadStream = rdfParser.parse(fileStream, { contentType: fileFormat });
    for await (const quad of quadStream) {
      dataset.add(quad);
    }

    return dataset;
  }

  /**
   * Loads or generates the RDF schema graph.
   *
   * @param options Schema source options.
   * @throws Error if multiple or no schema sources are provided.
   */
  async refreshSchema(options: {
    ontologyQuery?: string;
    ontologyUri?: string;
    ontologyLocalFile?: string;
    ontologyLocalFileFormat?: string;
    autoExtractOntology?: boolean;
  }): Promise<void> {
    let schemaSourceCount = [
      options.ontologyQuery,
      options.ontologyUri,
      options.ontologyLocalFile,
    ].filter(Boolean).length;

    if (schemaSourceCount === 0 && options.autoExtractOntology) {
      // eslint-disable-next-line no-param-reassign
      options.ontologyQuery = HanaRdfGraph.getGenericOntologyQuery(
        this.graphUri
      );
      schemaSourceCount = 1;
    }

    if (schemaSourceCount > 1) {
      throw new Error(
        "Multiple ontology/schema sources provided. Use only one of: ontologyQuery, ontologyUri, or ontologyLocalFile."
      );
    }

    if (schemaSourceCount === 0) {
      throw new Error("No ontology/schema sources provided.");
    }

    let graph: DatasetCore;

    if (options.ontologyLocalFile) {
      graph = await this.loadOntologySchemaFromFile(
        options.ontologyLocalFile,
        options.ontologyLocalFileFormat
      );
    } else {
      if (options.ontologyUri) {
        // eslint-disable-next-line no-param-reassign
        options.ontologyQuery = `CONSTRUCT { ?s ?p ?o } FROM <${options.ontologyUri}> WHERE { ?s ?p ?o . }`;
      }

      graph = await this.loadOntologySchemaGraphFromQuery(
        options.ontologyQuery!
      );
    }

    const serialized = await rdf.serializeTurtle(graph);
    this.schema = serialized.toString();
  }

  /**
   * Validate the query is a valid SPARQL CONSTRUCT query.
   * @param query SPARQL CONSTRUCT query string
   * @throws Error if the query is not a valid CONSTRUCT query.
   */
  private static validateConstructQuery(query: string) {
    const parser = new Parser();
    const parsedQuery = parser.parse(query);
    if (
      !(parsedQuery.type === "query" && parsedQuery.queryType === "CONSTRUCT")
    ) {
      throw new Error("Only CONSTRUCT queries are supported.");
    }
  }

  /**
   * Returns a generic SPARQL CONSTRUCT query that extracts
   * a minimal OWL Schema from the graph.
   *
   * @param graphUri Named graph URI to extract schema from.
   * @returns SPARQL CONSTRUCT query string.
   */
  static getGenericOntologyQuery(graphUri: string): string {
    const ontologyQuery = `
    PREFIX owl: <http://www.w3.org/2002/07/owl#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    CONSTRUCT { 
      ?cls rdf:type owl:Class . 
      ?cls rdfs:label ?clsLabel . 
      ?rel rdf:type ?propertyType . 
      ?rel rdfs:label ?relLabel . 
      ?rel rdfs:domain ?domain . 
      ?rel rdfs:range ?range .
    }
    FROM <${graphUri}>
    WHERE { 
      { 
        SELECT DISTINCT ?domain ?rel ?relLabel ?propertyType ?range
        WHERE {
          ?subj ?rel ?obj .
          ?subj a ?domain .
          OPTIONAL { ?obj a ?rangeClass . }
          FILTER(?rel != rdf:type)
          BIND(IF(isIRI(?obj), owl:ObjectProperty, owl:DatatypeProperty) AS ?propertyType)
          BIND(COALESCE(?rangeClass, DATATYPE(?obj)) AS ?range)
          BIND(STR(?rel) AS ?uriStr)
          BIND(REPLACE(?uriStr, "^.*[/#]", "") AS ?relLabel)
        }
      }
      UNION {
        SELECT DISTINCT ?cls ?clsLabel
        WHERE {
          ?instance a/rdfs:subClassOf* ?cls .
          FILTER(isIRI(?cls)) .
          BIND(STR(?cls) AS ?uriStr)
          BIND(REPLACE(?uriStr, "^.*[/#]", "") AS ?clsLabel)
        }
      }
    }
  `;
    return ontologyQuery;
  }

  /**
   * Returns the currently loaded RDF schema in Turtle format.
   *
   * @returns RDF schema as a Turtle string.
   */
  getSchema(): string {
    return this.schema;
  }
}
