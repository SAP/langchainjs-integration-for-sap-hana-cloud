import { describe, expect, it, test, vi } from "vitest";
import { validateK, validateKAndFetchK } from "../../src/hanautils.js";
import { HanaDB, HanaInternalEmbeddings } from "../../src/index.js";
import { validateIdentifier } from "../../src/vectorstores/utils.js";

const BAD_IDENTIFIERS = [
  "schema'; DROP TABLE users--",
  "schema OR 1=1",
  "schema name",
  "1schema",
  "schema-name",
  "schema.name",
  "col\n",
  "",
];

const VALID_IDENTIFIERS = ["valid_col", "_leading_underscore", "Col123", "a"];

describe("validateIdentifier", () => {
  test.each(VALID_IDENTIFIERS)("accepts valid name: %s", (name) => {
    expect(() => validateIdentifier(name)).not.toThrow();
  });

  test.each(BAD_IDENTIFIERS)("rejects invalid name: %s", (name) => {
    expect(() => validateIdentifier(name)).toThrow("Invalid identifier");
  });
});

function makeHanaDb(embedding: HanaInternalEmbeddings): HanaDB {
  const mockInitializeTable = vi
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .spyOn(HanaDB.prototype as any, "initializeTable")
    .mockResolvedValue(undefined);
  const mockValidateInternal = vi
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .spyOn(HanaDB.prototype as any, "validateInternalEmbeddingFunction")
    .mockResolvedValue(undefined);
  const mockSanitizeVectorColumnType = vi
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .spyOn(HanaDB as any, "sanitizeVectorColumnType")
    .mockReturnValue("REAL_VECTOR");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new HanaDB(embedding, { connection: {} as any });

  mockInitializeTable.mockRestore();
  mockValidateInternal.mockRestore();
  mockSanitizeVectorColumnType.mockRestore();

  return db;
}

describe("HanaDB remote source validation", () => {
  test.each(BAD_IDENTIFIERS.filter(Boolean))(
    "invalid remoteSourceSchema raises: %s",
    (bad) => {
      const embedding = new HanaInternalEmbeddings({
        internalEmbeddingModelId: "model",
        remoteSourceSchema: bad,
        remoteSource: "valid_source",
      });
      expect(() => makeHanaDb(embedding)).toThrow("Invalid identifier");
    }
  );

  test.each(BAD_IDENTIFIERS.filter(Boolean))(
    "invalid remoteSource raises: %s",
    (bad) => {
      const embedding = new HanaInternalEmbeddings({
        internalEmbeddingModelId: "model",
        remoteSourceSchema: "valid_schema",
        remoteSource: bad,
      });
      expect(() => makeHanaDb(embedding)).toThrow("Invalid identifier");
    }
  );

  test.each(VALID_IDENTIFIERS)(
    "valid remoteSource and schema accepted: %s",
    (valid) => {
      const embedding = new HanaInternalEmbeddings({
        internalEmbeddingModelId: "model",
        remoteSourceSchema: valid,
        remoteSource: valid,
      });
      const db = makeHanaDb(embedding);
      expect(db["internalEmbeddingRemoteSourceSchema"]).toBe(valid);
      expect(db["internalEmbeddingRemoteSource"]).toBe(valid);
    }
  );
});

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
