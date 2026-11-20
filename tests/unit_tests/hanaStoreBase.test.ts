import { describe, expect, it } from "vitest";
import { HanaStore } from "../../src/memorystores/index.js";

// Pure, DB-free helpers are exercised directly, mirroring the Python
// `test_base_hana_store.py` unit tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (obj: unknown): any => obj;

describe("namespace encoding", () => {
  it("round-trips a namespace through the PREFIX text form", () => {
    const ns = ["users", "123", "prefs"];
    const text = priv(HanaStore).namespaceToText(ns);
    expect(text).toBe("users.123.prefs");
    expect(priv(HanaStore).decodeNs(text)).toEqual(ns);
  });

  it("escapes LIKE metacharacters", () => {
    expect(priv(HanaStore).escapeLike("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
  });
});

describe("vectorToStr", () => {
  it("renders a bracketed comma-joined literal", () => {
    expect(priv(HanaStore).vectorToStr([1, 2.5, -3])).toBe("[1,2.5,-3]");
  });
});

describe("dedupePutOps", () => {
  it("keeps the last put for a given (namespace, key)", () => {
    const first = { namespace: ["a"], key: "k", value: { v: 1 } };
    const second = { namespace: ["a"], key: "k", value: { v: 2 } };
    const map = priv(HanaStore).dedupePutOps([
      [0, first],
      [1, second],
    ]);
    expect(map.size).toBe(1);
    expect([...map.values()][0]).toBe(second);
  });
});

describe("matchesFilter", () => {
  it("matches scalar equality and comparison operators", () => {
    expect(priv(HanaStore).matchesFilter({ a: 1, b: "x" }, { b: "x" })).toBe(
      true
    );
    expect(priv(HanaStore).matchesFilter({ a: 1 }, { a: { $gte: 1 } })).toBe(
      true
    );
    expect(priv(HanaStore).matchesFilter({ a: 1 }, { a: { $gt: 1 } })).toBe(
      false
    );
    expect(priv(HanaStore).matchesFilter({ a: 1 }, { a: { $ne: 2 } })).toBe(
      true
    );
  });

  it("matches nested objects and lists element-wise", () => {
    expect(
      priv(HanaStore).matchesFilter(
        { meta: { lang: "en" } },
        { meta: { lang: "en" } }
      )
    ).toBe(true);
    expect(
      priv(HanaStore).matchesFilter({ tags: [1, 2] }, { tags: [1, 2] })
    ).toBe(true);
    expect(
      priv(HanaStore).matchesFilter({ tags: [1, 2] }, { tags: [1, 3] })
    ).toBe(false);
  });

  it("returns true for an empty/undefined filter", () => {
    expect(priv(HanaStore).matchesFilter({ a: 1 }, undefined)).toBe(true);
    expect(priv(HanaStore).matchesFilter({ a: 1 }, {})).toBe(true);
  });
});

describe("applyOperator", () => {
  it("rejects an unknown operator", () => {
    expect(() => priv(HanaStore).applyOperator(1, "$bogus", 1)).toThrow(
      /Unsupported operator/
    );
  });
});

describe("doesMatch", () => {
  it("matches prefix, suffix and wildcard conditions", () => {
    const key = ["a", "b", "c"];
    expect(
      priv(HanaStore).doesMatch({ matchType: "prefix", path: ["a", "b"] }, key)
    ).toBe(true);
    expect(
      priv(HanaStore).doesMatch({ matchType: "prefix", path: ["a", "x"] }, key)
    ).toBe(false);
    expect(
      priv(HanaStore).doesMatch({ matchType: "suffix", path: ["b", "c"] }, key)
    ).toBe(true);
    expect(
      priv(HanaStore).doesMatch({ matchType: "prefix", path: ["*", "b"] }, key)
    ).toBe(true);
    // A path longer than the key never matches.
    expect(
      priv(HanaStore).doesMatch(
        { matchType: "prefix", path: ["a", "b", "c", "d"] },
        key
      )
    ).toBe(false);
  });
});

describe("filterNamespaces", () => {
  it("dedupes, truncates to maxDepth and paginates", () => {
    const prefixes = ["a.b.c", "a.b.d", "a.b.c", "x.y"];
    const result = priv(HanaStore).filterNamespaces(prefixes, {
      maxDepth: 2,
      limit: 10,
      offset: 0,
    });
    // a.b.c and a.b.d both truncate to [a, b]; x.y stays.
    expect(result).toEqual([
      ["a", "b"],
      ["x", "y"],
    ]);
  });

  it("applies a prefix match condition", () => {
    const prefixes = ["a.b", "a.c", "z.a"];
    const result = priv(HanaStore).filterNamespaces(prefixes, {
      matchConditions: [{ matchType: "prefix", path: ["a"] }],
      limit: 10,
      offset: 0,
    });
    expect(result).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
  });
});

describe("finalizeSearch", () => {
  const items = [
    {
      namespace: ["n"],
      key: "k1",
      value: { score: 1 },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      namespace: ["n"],
      key: "k2",
      value: { score: 2 },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      namespace: ["n"],
      key: "k3",
      value: { score: 3 },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  it("filters then applies the offset/limit window", () => {
    const page = priv(HanaStore).finalizeSearch(
      {
        namespacePrefix: ["n"],
        filter: { score: { $gte: 2 } },
        limit: 1,
        offset: 1,
      },
      items
    );
    expect(page.map((i: { key: string }) => i.key)).toEqual(["k3"]);
  });

  it("returns the window when there is no filter", () => {
    const page = priv(HanaStore).finalizeSearch(
      { namespacePrefix: ["n"], limit: 2, offset: 0 },
      items
    );
    expect(page.map((i: { key: string }) => i.key)).toEqual(["k1", "k2"]);
  });
});
