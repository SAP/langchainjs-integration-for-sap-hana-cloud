import { HanaSparqlQAChain } from "../../src/index.js";

type ExtractSparqlTestCase = {
  inputQuery: string;
  expectedResult: string;
  testCaseName: string;
};

const EXTRACT_SPARQL_TEST_CASES: ExtractSparqlTestCase[] = [
  {
    inputQuery: "```sparql\nSELECT * WHERE { ?s ?p ?o }\n```",
    expectedResult: "SELECT * WHERE { ?s ?p ?o }",
    testCaseName: "lowercase sparql",
  },
  {
    inputQuery: "```SPARQL\nSELECT * WHERE { ?s ?p ?o }\n```",
    expectedResult: "SELECT * WHERE { ?s ?p ?o }",
    testCaseName: "uppercase SPARQL",
  },
  {
    inputQuery: "```Sparql\nSELECT * WHERE { ?s ?p ?o }\n```",
    expectedResult: "SELECT * WHERE { ?s ?p ?o }",
    testCaseName: "mixed case Sparql",
  },
  {
    inputQuery: "```SparQL\nSELECT * WHERE { ?s ?p ?o }\n```",
    expectedResult: "SELECT * WHERE { ?s ?p ?o }",
    testCaseName: "mixed case SparQL",
  },
  {
    inputQuery: "```\nSELECT * WHERE { ?s ?p ?o }\n```",
    expectedResult: "SELECT * WHERE { ?s ?p ?o }",
    testCaseName: "fenced no language",
  },
  {
    inputQuery: "<sparql>\nSELECT * WHERE { ?s ?p ?o }\n</sparql>",
    expectedResult: "SELECT * WHERE { ?s ?p ?o }",
    testCaseName: "xml tags",
  },
  {
    inputQuery: "SELECT * WHERE { ?s ?p ?o }",
    expectedResult: "SELECT * WHERE { ?s ?p ?o }",
    testCaseName: "plain query",
  },
  {
    inputQuery: "",
    expectedResult: "",
    testCaseName: "empty string",
  },
  {
    inputQuery: "   \n\t  ",
    expectedResult: "",
    testCaseName: "whitespace only",
  },
];


describe("extract sparql tests", () => {
  EXTRACT_SPARQL_TEST_CASES.forEach(({ inputQuery, expectedResult, testCaseName }) => {
    it(`should correctly extract SPARQL for test case: ${testCaseName}`, () => {
      const result = HanaSparqlQAChain.extractSparql(inputQuery);
      expect(result.trim()).toBe(expectedResult.trim());
    });
  });
});
