import { Connection } from "@sap/hana-client";
import { Parser as N3Parser, Store as N3Store } from "n3";
import { Parser } from "sparqljs";
import { promises as fs, PathLike } from "fs";
import { executeSparqlQuery } from "../hanautils.js";
/**
 * Options for initializing HanaRdfGraph
 */
export interface HanaRdfGraphOptions {
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
 * const graphOptions: HanaRdfGraphOptions = {
 *   connection: conn,
 *   graphUri: 'http://example.com/graph',
 *   ontologyUri: 'http://example.com/ontology'
 * };
 * const graph = new HanaRdfGraph(graphOptions);
 * await graph.initialize(graphOptions);
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

  private fromClause: string;

  private schema: N3Store;

  /**
   * Creates a new HanaRdfGraph instance.
   *
   * @param options Initialization options for the RDF graph wrapper
   */
  constructor(options: HanaRdfGraphOptions) {
    this.connection = options.connection;
    if (!options.graphUri || options.graphUri?.toUpperCase() === "DEFAULT") {
      this.fromClause = "FROM DEFAULT";
    } else {
      this.fromClause = `FROM <${options.graphUri}>`;
    }
  }

  async initialize(options: HanaRdfGraphOptions) {
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

    const whereIndex = query.search(/\bWHERE\b/i);

    if (whereIndex === -1) {
      throw new Error("SPARQL query does not contain a WHERE clause.");
    }

    return `
      ${query.slice(0, whereIndex)}
      ${this.fromClause}
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
    const result = await executeSparqlQuery(
      this.connection,
      finalQuery,
      headers
    );
    return result;
  }

  /**
   * Load an ontology schema by executing a SPARQL CONSTRUCT query.
   *
   * @param ontologyQuery A valid SPARQL CONSTRUCT query.
   * @returns RDF dataset containing the ontology triples.
   */
  private async loadOntologySchemaGraphFromQuery(
    ontologyQuery: string
  ): Promise<N3Store> {
    HanaRdfGraph.validateConstructQuery(ontologyQuery);
    const response = await this.query(ontologyQuery, false, "");

    const graph = new N3Store();
    const n3Parser = new N3Parser({
      format: "text/turtle",
    });
    const quadStream = n3Parser.parse(response);
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
  ): Promise<N3Store> {
    let fileData: string;
    try {
      fileData = await fs.readFile(localFile, "utf8");
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

    const ontologyGraph = new N3Store();
    const parser = new N3Parser({ format: fileFormat });

    const quadStream = parser.parse(fileData);
    for await (const quad of quadStream) {
      ontologyGraph.add(quad);
    }

    return ontologyGraph;
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
      options.ontologyQuery = this.getGenericOntologyQuery();
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

    let graph: N3Store;

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

    this.schema = graph;
  }

  /**
   * Validate the query is a valid SPARQL CONSTRUCT query.
   * @param query SPARQL CONSTRUCT query string
   * @throws Error if the query is not a valid CONSTRUCT query.
   */
  private static validateConstructQuery(query: string) {
    const parser = new Parser();
    // We are using the parser from sparqljs to parse the query.
    // HANA deviates from the standard SPARQL specification where FROM DEFAULT is a valid clause.
    // Also, HANA allows the graphUris to be simple names instead of full URIs.
    // To handle this, we replace such graphUris with a dummy graphUri.
    const queryWithDummyUri = query.replace(
      /FROM\s+(?:NAMED\s+)?(?:DEFAULT|<([^>:]+)>)/gi,
      "FROM $1<http://example.org/dummy_graph>"
    );
    const parsedQuery = parser.parse(queryWithDummyUri);
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
  private getGenericOntologyQuery(): string {
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
    ${this.fromClause}
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
  getSchema(): N3Store {
    return this.schema;
  }
}
