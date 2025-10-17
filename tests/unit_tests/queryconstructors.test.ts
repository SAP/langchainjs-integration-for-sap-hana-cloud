import { jest } from "@jest/globals";
import { HanaDB } from "../../src/vectorstores/hanavector.js";
import { CreateWhereClause } from "../../src/vectorstores/whereclausebuilder.js";
import { FILTERING_TEST_CASES } from "../integration_tests/fixtures/hanavector.fixtures.js";

const dummyHanaDB = {
  getMetadataColumn: jest.fn().mockReturnValue("VEC_META"),
  getSpecificMetadataColumns: jest.fn().mockReturnValue([]),
} as unknown as HanaDB;

describe("where clause creation tests", () => {
  test("test create where clause with empty filter", () => {
    const [whereClause, parameters] = new CreateWhereClause(dummyHanaDB).build(
      {}
    );
    expect(whereClause).toBe("");
    expect(parameters).toEqual([]);
  });

  describe("valid filters", () => {
    test.each(FILTERING_TEST_CASES)(
      "filter: %o, expectedWhereClause: %s, expectedParams: %o",
      (filter, _matchingIds, expectedWhereClause, expectedParams) => {
        const [whereClause, parameters] = new CreateWhereClause(
          dummyHanaDB
        ).build(filter);
        expect(whereClause).toBe(expectedWhereClause);
        const stringArr = expectedParams.map((item) => item.toString());
        expect(parameters).toEqual(stringArr);
      }
    );
  });
});
