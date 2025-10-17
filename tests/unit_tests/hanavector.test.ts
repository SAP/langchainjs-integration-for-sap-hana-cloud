import { expect } from "@jest/globals";
import { HanaDB } from "../../src/vectorstores/hanavector.js";
import { validateK, validateKAndFetchK } from "../../src/hanautils.js";

describe("Sanity check tests", () => {
  it("should sanitize int with illegal value", () => {
    try {
      HanaDB.sanitizeInt("HUGO");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      expect(error.message).toContain("must not be smaller than 0");
    }
  });

  it("should sanitize int with legal values", () => {
    expect(HanaDB.sanitizeInt(42)).toBe(42);
    expect(HanaDB.sanitizeInt("21")).toBe(21);
  });

  it("should sanitize int with negative values", () => {
    expect(HanaDB.sanitizeInt(-1, -1)).toBe(-1);
    expect(HanaDB.sanitizeInt("-1", -1)).toBe(-1);
  });

  it("should sanitize int with illegal negative value", () => {
    try {
      HanaDB.sanitizeInt(-2, -1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      expect(error.message).toContain("must not be smaller than -1");
    }
  });
});

test("test validate k", () => {
  expect(() => validateK(0)).toThrow(
    "Parameter 'k' must be an integer greater than 0"
  );
  expect(() => validateK(-1)).toThrow(
    "Parameter 'k' must be an integer greater than 0"
  );
  expect(() => validateK(1.5)).toThrow(
    "Parameter 'k' must be an integer greater than 0"
  );
  expect(() => validateK(1)).not.toThrow();
});

test("test validate k and fetch k", () => {
  expect(() => validateKAndFetchK(2, 1)).toThrow(
    "Parameter 'fetch_k' must be an integer greater than or equal to 'k'"
  );
  expect(() => validateKAndFetchK(0, 1)).toThrow(
    "Parameter 'k' must be an integer greater than 0"
  );
  expect(() => validateKAndFetchK(2, 2)).not.toThrow();
  expect(() => validateKAndFetchK(2, 3)).not.toThrow();
});
