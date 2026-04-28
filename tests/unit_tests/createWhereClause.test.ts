import { describe, expect, test, vi } from "vitest";
import { HanaDB } from "../../src/index.js";
import { CreateWhereClause } from "../../src/vectorstores/createWhereClause.js";
import {
  ERROR_FILTERING_TEST_CASES,
  FILTERING_TEST_CASES,
} from "../integration_tests/fixtures/hanaDb.fixtures.js";

const dummyHanaDB = {
  getMetadataColumn: vi.fn().mockReturnValue("VEC_META"),
  getSpecificMetadataColumns: vi.fn().mockReturnValue([]),
} as unknown as HanaDB;

describe("errorneous filter tests", () => {
  test.each(ERROR_FILTERING_TEST_CASES)(
    "filter: $0, expectedError: $1",
    (filter, expectedError) => {
      expect(() => new CreateWhereClause(dummyHanaDB).build(filter)).toThrow(
        expectedError
      );
    }
  );
});

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
      "filter: $0, expectedWhereClause: $2",
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
