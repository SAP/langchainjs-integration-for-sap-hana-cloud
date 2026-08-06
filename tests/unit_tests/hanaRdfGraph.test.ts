import { describe, expect, it, vi } from "vitest";
import { Connection } from "@sap/hana-client";
import { NamedNode, Store } from "n3";
import { HanaRdfGraph } from "../../src/index.js";

function mockGraph(
  graphUri?: string,
  ontologyUri?: string,
  autoExtractOntology: boolean = true
): Promise<HanaRdfGraph> {
  const mockConnection = {} as Connection;
  const testSchema = new Store();

  const loadOntologyMock = vi
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .spyOn(HanaRdfGraph.prototype as any, "loadOntologySchemaGraphFromQuery")
    .mockReturnValue(testSchema);
  const validateConstructQueryMock = vi
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .spyOn(HanaRdfGraph as any, "validateConstructQuery")
    .mockImplementation(() => {});

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options: any = { connection: mockConnection };
  if (graphUri) options.graphUri = graphUri;
  if (ontologyUri !== undefined) {
    options.ontologyUri = ontologyUri;
    options.autoExtractOntology = false;
  } else {
    options.autoExtractOntology = autoExtractOntology;
  }

  const graph = new HanaRdfGraph(options);
  return graph.initialize(options).then(() => {
    loadOntologyMock.mockRestore();
    validateConstructQueryMock.mockRestore();
    return graph;
  });
}

describe("test getSchema return value", () => {
  it("should return a N3 Store instance not a string", async () => {
    const graph = await mockGraph();
    expect(graph.getSchema()).toBeInstanceOf(Store);
  });
});

describe("IRI injection guard", () => {
  it.each([
    "http://example.com/graph> WHERE {?s ?p ?o} #",
    'http://example.com/graph"evil',
    "http://example.com/{graph}",
    "http://example.com/graph|pipe",
    "http://example.com/graph\\backslash",
    "http://example.com/graph^caret",
    "http://example.com/graph`tick",
    "http://example.com/graph\x00null",
    "http://example.com/graph\x01control",
  ])("validateIri rejects bad URI: %s", (bad) => {
    expect(() => HanaRdfGraph.validateIri(bad)).toThrow("Invalid IRI");
  });

  it.each([
    "http://example.com/graph",
    "http://example.com/ontology#Class",
    "urn:example:graph",
    "https://dbpedia.org/ontology/Person",
  ])("validateIri accepts valid URI: %s", (good) => {
    expect(() => HanaRdfGraph.validateIri(good)).not.toThrow();
  });

  it("graph_uri with injection raises on init", () => {
    expect(
      () =>
        new HanaRdfGraph({
          connection: {} as Connection,
          graphUri: "http://x.com/g> UNION SELECT * WHERE {?s ?p ?o}",
        })
    ).toThrow("Invalid IRI");
  });

  it("valid graph_uri sets fromClause correctly", async () => {
    const graph = await mockGraph("http://example.com/mygraph");
    expect(graph["fromClause"]).toBe("FROM <http://example.com/mygraph>");
  });

  it("ontologyUri with injection raises", async () => {
    await expect(
      mockGraph(undefined, "http://x.com/ont> INJECT")
    ).rejects.toThrow("Invalid IRI");
  });

  it("valid ontologyUri does not raise", async () => {
    await expect(
      mockGraph(undefined, "http://example.com/ontology")
    ).resolves.not.toThrow();
  });
});

describe("HTTP header injection guard", () => {
  it.each([
    "text/csv\r\nX-Injected: evil",
    "text/csv\nX-Injected: evil",
    "text/csv\rX-Injected: evil",
  ])("query raises on CR/LF in content_type: %s", async (bad) => {
    const graph = await mockGraph();
    await expect(
      graph.query("SELECT ?s WHERE { ?s ?p ?o }", true, bad)
    ).rejects.toThrow("CR/LF");
  });
});
