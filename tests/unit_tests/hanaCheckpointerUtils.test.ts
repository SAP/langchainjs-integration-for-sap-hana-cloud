import type { Connection } from "@sap/hana-client";
import { describe, expect, it } from "vitest";
import { HanaCheckpointSaver } from "../../src/checkpointers/index.js";

// Private methods are exercised directly, mirroring the Python unit tests for the
// checkpointer's pure query/serialization helpers. The cast keeps the tests focused
// on behavior without widening the public surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (obj: unknown): any => obj;

// A connection stub: the saver only calls setAutoCommit at construction, and these
// tests never touch the database.
const mockConnection = { setAutoCommit: () => {} } as unknown as Connection;

function makeSaver(): HanaCheckpointSaver {
  return new HanaCheckpointSaver({ connection: mockConnection });
}

describe("buildWhereClause", () => {
  it("returns an empty clause and no params for no config/filter", () => {
    const [clause, params] = priv(makeSaver()).buildWhereClause(
      undefined,
      undefined
    );
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });

  it("filters by thread_id and checkpoint_ns from config", () => {
    const config = {
      configurable: { thread_id: "t1", checkpoint_ns: "ns1" },
    };
    const [clause, params] = priv(makeSaver()).buildWhereClause(config);
    expect(clause).toBe('WHERE "THREAD_ID" = ? AND "CHECKPOINT_NS" = ?');
    expect(params).toEqual(["t1", "ns1"]);
  });

  it("filters by checkpoint_ns alone, with no thread_id", () => {
    // Independent predicates: a namespace filter must apply even without thread_id.
    const [clause, params] = priv(makeSaver()).buildWhereClause({
      configurable: { checkpoint_ns: "" },
    });
    expect(clause).toBe('WHERE "CHECKPOINT_NS" = ?');
    expect(params).toEqual([""]);
  });

  it("includes checkpoint_id and a before cursor", () => {
    const config = {
      configurable: { thread_id: "t1", checkpoint_id: "c9" },
    };
    const before = { configurable: { checkpoint_id: "c5" } };
    const [clause, params] = priv(makeSaver()).buildWhereClause(
      config,
      undefined,
      before
    );
    expect(clause).toBe(
      'WHERE "THREAD_ID" = ? AND "CHECKPOINT_ID" = ? AND "CHECKPOINT_ID" < ?'
    );
    expect(params).toEqual(["t1", "c9", "c5"]);
  });

  it("builds JSON_VALUE predicates for a scalar metadata filter", () => {
    const [clause, params] = priv(makeSaver()).buildWhereClause(undefined, {
      source: "loop",
      step: 3,
    });
    expect(clause).toBe(
      "WHERE JSON_VALUE(\"METADATA\", '$.source') = ? AND " +
        "JSON_VALUE(\"METADATA\", '$.step') = ?"
    );
    expect(params).toEqual(["loop", "3"]);
  });

  it("maps booleans to true/false strings and null to IS NULL", () => {
    const [clause, params] = priv(makeSaver()).buildWhereClause(undefined, {
      done: true,
      skipped: false,
      parent: null,
    });
    expect(clause).toBe(
      "WHERE JSON_VALUE(\"METADATA\", '$.done') = ? AND " +
        "JSON_VALUE(\"METADATA\", '$.skipped') = ? AND " +
        "JSON_VALUE(\"METADATA\", '$.parent') IS NULL"
    );
    expect(params).toEqual(["true", "false"]);
  });

  it("rejects an unsafe metadata filter key", () => {
    expect(() =>
      priv(makeSaver()).buildWhereClause(undefined, { "bad key": "x" })
    ).toThrow(/Invalid identifier/);
  });

  it("rejects a non-scalar metadata filter value", () => {
    expect(() =>
      priv(makeSaver()).buildWhereClause(undefined, { k: { nested: 1 } })
    ).toThrow(/scalar values/);
  });
});

describe("pendingWritesSql", () => {
  it("selects write columns from the writes table reference", () => {
    const sql = priv(makeSaver()).pendingWritesSql();
    expect(sql).toContain('"LANGGRAPH_CHECKPOINT_WRITES"');
    expect(sql).toContain(
      '"TASK_ID", "CHANNEL", "TYPE", "VALUE", "TASK_PATH", "IDX"'
    );
    expect(sql).toContain(
      'WHERE "THREAD_ID" = ? AND "CHECKPOINT_NS" = ? AND "CHECKPOINT_ID" = ?'
    );
  });
});

describe("dumpBlobs", () => {
  it("serializes present channels and placeholders absent ones", async () => {
    const saver = makeSaver();
    const rows: unknown[][] = await priv(saver).dumpBlobs(
      "t1",
      "",
      { present: { x: 1 } },
      { present: "1", absent: "2" }
    );
    expect(rows).toHaveLength(2);
    const byChannel = new Map(rows.map((r) => [r[2], r]));
    const present = byChannel.get("present")!;
    expect(present[3]).toBe("1"); // version stringified
    expect(present[4]).not.toBe("empty"); // serde type
    expect(Buffer.isBuffer(present[5])).toBe(true);
    const absent = byChannel.get("absent")!;
    expect(absent[3]).toBe("2");
    expect(absent[4]).toBe("empty");
    expect(absent[5]).toBeNull();
  });

  it("returns an empty array when there are no versions", async () => {
    const rows = await priv(makeSaver()).dumpBlobs("t1", "", {}, {});
    expect(rows).toEqual([]);
  });
});

describe("loadBlobs", () => {
  it("skips placeholder rows and deserializes the rest", async () => {
    const saver = makeSaver();
    const [type, bytes] = await saver.serde.dumpsTyped({ y: 2 });
    const rows = [
      { CHANNEL: "placeholder", TYPE: "empty", BLOB: null },
      { CHANNEL: "real", TYPE: type, BLOB: Buffer.from(bytes) },
    ];
    const result = await priv(saver).loadBlobs(rows);
    expect(result).toEqual({ real: { y: 2 } });
  });
});

describe("loadWrites", () => {
  it("orders by (task_path, task_id, idx) and deserializes values", async () => {
    const saver = makeSaver();
    const [type, bytes] = await saver.serde.dumpsTyped("v");
    const blob = Buffer.from(bytes);
    const rows = [
      {
        TASK_ID: "b",
        CHANNEL: "c2",
        TYPE: type,
        VALUE: blob,
        TASK_PATH: "p",
        IDX: 0,
      },
      {
        TASK_ID: "a",
        CHANNEL: "c1",
        TYPE: type,
        VALUE: blob,
        TASK_PATH: "p",
        IDX: 1,
      },
      {
        TASK_ID: "a",
        CHANNEL: "c0",
        TYPE: type,
        VALUE: blob,
        TASK_PATH: "p",
        IDX: 0,
      },
    ];
    const writes = await priv(saver).loadWrites(rows);
    // Sorted: (p, a, 0), (p, a, 1), (p, b, 0)
    expect(writes.map((w: [string, string, unknown]) => [w[0], w[1]])).toEqual([
      ["a", "c0"],
      ["a", "c1"],
      ["b", "c2"],
    ]);
    expect(writes[0][2]).toBe("v");
  });
});

describe("toBuffer", () => {
  it("passes through null/undefined and copies byte data", () => {
    const toBuffer = priv(HanaCheckpointSaver).toBuffer;
    expect(toBuffer(null)).toBeNull();
    expect(toBuffer(undefined)).toBeNull();
    const out = toBuffer(new Uint8Array([1, 2, 3]));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
