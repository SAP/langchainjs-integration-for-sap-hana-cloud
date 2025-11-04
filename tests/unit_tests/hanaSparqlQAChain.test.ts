import { HanaSparqlQAChain } from "../../src/index.js";
import { EXTRACT_SPARQL_TEST_CASES } from "../integration_tests/fixtures/hanaRdfGraph.fixtures.js";

describe("extract sparql tests", () => {
  EXTRACT_SPARQL_TEST_CASES.forEach(({ inputQuery, expectedResult, testCaseName }) => {
    it(`should correctly extract SPARQL for test case: ${testCaseName}`, () => {
      const result = HanaSparqlQAChain.extractSparql(inputQuery);
      expect(result.trim()).toBe(expectedResult.trim());
    });
  });
});
