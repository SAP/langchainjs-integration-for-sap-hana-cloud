import { describe, expect, test, vi } from "vitest";
import { HanaDB } from "../../src/index.js";
import { CreateWhereClause } from "../../src/vectorstores/createWhereClause.js";
import {
  ERROR_FILTERING_TEST_CASES,
  FILTERING_TEST_CASES,
} from "../fixtures/hanaDb.fixtures.js";

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

const INJECTION_COLUMN_NAMES = [
  "col') FROM DUAL UNION SELECT * FROM SYS.USERS--",
  'col"evil',
  "col; DROP TABLE users--",
  "col OR 1=1",
  "col/*comment*/",
  "1col",
  "col name",
  "col-name",
  "col.name",
];

describe("SQL injection via filter key raises", () => {
  test.each(INJECTION_COLUMN_NAMES)("filter key: %s", (badColumn) => {
    expect(() =>
      new CreateWhereClause(dummyHanaDB).build({ [badColumn]: "value" })
    ).toThrow("Invalid identifier");
  });
});

describe("SQL injection via $contains filter key raises", () => {
  test.each(INJECTION_COLUMN_NAMES)("$contains key: %s", (badColumn) => {
    expect(() =>
      new CreateWhereClause(dummyHanaDB).build({
        [badColumn]: { $contains: "search term" },
      })
    ).toThrow("Invalid identifier");
  });
});

describe("valid column names accepted", () => {
  test.each(["name", "my_column", "_private", "col123", "CamelCase"])(
    "column: %s",
    (goodColumn) => {
      const [clause] = new CreateWhereClause(dummyHanaDB).build({
        [goodColumn]: "value",
      });
      expect(clause).toContain(goodColumn);
    }
  );
});
