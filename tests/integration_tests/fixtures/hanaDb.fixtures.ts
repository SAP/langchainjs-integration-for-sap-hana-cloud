import { Document } from "@langchain/core/documents";
import { Filter } from "../../../src/vectorstores/createWhereClause.js";

interface Metadata {
  name: string;
  date: string;
  count: number;
  is_active: boolean;
  tags: string[];
  location: number[];
  id: number;
  height: number | null;
  happiness: number | null;
  sadness?: number;
}

const metadatas: Metadata[] = [
  {
    name: "adam",
    date: "2021-01-01",
    count: 1,
    is_active: true,
    tags: ["a", "b"],
    location: [1.0, 2.0],
    id: 1,
    height: 10.0,
    happiness: 0.9,
    sadness: 0.1,
  },
  {
    name: "bob",
    date: "2021-01-02",
    count: 2,
    is_active: false,
    tags: ["b", "c"],
    location: [2.0, 3.0],
    id: 2,
    height: 5.7,
    happiness: 0.8,
    sadness: 0.1,
  },
  {
    name: "jane",
    date: "2021-01-01",
    count: 3,
    is_active: true,
    tags: ["b", "d"],
    location: [3.0, 4.0],
    id: 3,
    height: 2.4,
    happiness: null,
  },
];

const texts: string[] = metadatas.map((metadata) => `id ${metadata.id} `);

export const FILTERING_DOCUMENTS: Document[] = texts.map(
  (text, index) =>
    new Document({ pageContent: text, metadata: metadatas[index] })
);

type FilteringTestCase = [
  filter: Filter,
  matchingIds: number[],
  expectedWhereClause: string,
  expectedParams: (string | boolean | number | Date)[],
];

type ErrorFilteringTestCase = [filter: Filter, expectedError: string];

export const TYPE_1_FILTERING_TEST_CASES: FilteringTestCase[] = [
  // These tests only involve equality checks
  [{ id: 1 }, [1], "WHERE JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)", [1]],
  // NULL filtering check
  [
    { happiness: null },
    [3],
    "WHERE JSON_VALUE(VEC_META, '$.happiness') IS NULL",
    [],
  ],
  // String field
  [
    { name: "adam" },
    [1],
    "WHERE JSON_VALUE(VEC_META, '$.name') = TO_NVARCHAR(?)",
    ["adam"],
  ],
  // String field (empty string)
  [
    { name: "" },
    [],
    "WHERE JSON_VALUE(VEC_META, '$.name') = TO_NVARCHAR(?)",
    [""],
  ],
  // Boolean fields
  [
    { is_active: true },
    [1, 3],
    "WHERE JSON_VALUE(VEC_META, '$.is_active') = TO_BOOLEAN(?)",
    ["true"],
  ],
  [
    { is_active: false },
    [2],
    "WHERE JSON_VALUE(VEC_META, '$.is_active') = TO_BOOLEAN(?)",
    ["false"],
  ],
  // And semantics for top level filtering
  [
    { id: 1, is_active: true },
    [1],
    "WHERE (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)) AND (JSON_VALUE(VEC_META, '$.is_active') = TO_BOOLEAN(?))",
    [1, "true"],
  ],
  [
    { id: 1, is_active: false },
    [],
    "WHERE (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)) AND (JSON_VALUE(VEC_META, '$.is_active') = TO_BOOLEAN(?))",
    [1, "false"],
  ],
];

export const TYPE_2_FILTERING_TEST_CASES: FilteringTestCase[] = [
  // These involve equality checks and other operators
  // like $ne, $gt, $gte, $lt, $lte, $not
  [{ id: 1 }, [1], "WHERE JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)", [1]],
  // $eq with null value
  [
    { happiness: { $eq: null } },
    [3],
    "WHERE JSON_VALUE(VEC_META, '$.happiness') IS NULL",
    [],
  ],
  [
    { id: { $ne: 1 } },
    [2, 3],
    "WHERE JSON_VALUE(VEC_META, '$.id') <> TO_DOUBLE(?)",
    [1],
  ],
  // $ne with null value
  [
    { sadness: { $ne: null } },
    [1, 2],
    "WHERE JSON_VALUE(VEC_META, '$.sadness') IS NOT NULL",
    [],
  ],
  [
    { id: { $gt: 0 } },
    [1, 2, 3],
    "WHERE JSON_VALUE(VEC_META, '$.id') > TO_DOUBLE(?)",
    [0],
  ],
  [
    { id: { $gt: 1 } },
    [2, 3],
    "WHERE JSON_VALUE(VEC_META, '$.id') > TO_DOUBLE(?)",
    [1],
  ],
  [
    { id: { $gte: 1 } },
    [1, 2, 3],
    "WHERE JSON_VALUE(VEC_META, '$.id') >= TO_DOUBLE(?)",
    [1],
  ],
  [
    { id: { $lt: 1 } },
    [],
    "WHERE JSON_VALUE(VEC_META, '$.id') < TO_DOUBLE(?)",
    [1],
  ],
  [
    { id: { $lte: 1 } },
    [1],
    "WHERE JSON_VALUE(VEC_META, '$.id') <= TO_DOUBLE(?)",
    [1],
  ],
  // Repeat all the same tests with name (string column)
  [
    { name: "adam" },
    [1],
    "WHERE JSON_VALUE(VEC_META, '$.name') = TO_NVARCHAR(?)",
    ["adam"],
  ],
  [
    { name: "bob" },
    [2],
    "WHERE JSON_VALUE(VEC_META, '$.name') = TO_NVARCHAR(?)",
    ["bob"],
  ],
  [
    { name: { $eq: "adam" } },
    [1],
    "WHERE JSON_VALUE(VEC_META, '$.name') = TO_NVARCHAR(?)",
    ["adam"],
  ],
  [
    { name: { $ne: "adam" } },
    [2, 3],
    "WHERE JSON_VALUE(VEC_META, '$.name') <> TO_NVARCHAR(?)",
    ["adam"],
  ],
  // And also gt, gte, lt, lte relying on lexicographical ordering
  [
    { name: { $gt: "jane" } },
    [],
    "WHERE JSON_VALUE(VEC_META, '$.name') > TO_NVARCHAR(?)",
    ["jane"],
  ],
  [
    { name: { $gte: "jane" } },
    [3],
    "WHERE JSON_VALUE(VEC_META, '$.name') >= TO_NVARCHAR(?)",
    ["jane"],
  ],
  [
    { name: { $lt: "jane" } },
    [1, 2],
    "WHERE JSON_VALUE(VEC_META, '$.name') < TO_NVARCHAR(?)",
    ["jane"],
  ],
  [
    { name: { $lte: "jane" } },
    [1, 2, 3],
    "WHERE JSON_VALUE(VEC_META, '$.name') <= TO_NVARCHAR(?)",
    ["jane"],
  ],
  [
    { is_active: { $eq: true } },
    [1, 3],
    "WHERE JSON_VALUE(VEC_META, '$.is_active') = TO_BOOLEAN(?)",
    ["true"],
  ],
  [
    { is_active: { $eq: false } },
    [2],
    "WHERE JSON_VALUE(VEC_META, '$.is_active') = TO_BOOLEAN(?)",
    ["false"],
  ],
  [
    { is_active: { $ne: true } },
    [2],
    "WHERE JSON_VALUE(VEC_META, '$.is_active') <> TO_BOOLEAN(?)",
    ["true"],
  ],
  // Test float column.
  [
    { height: 5.7 },
    [2],
    "WHERE JSON_VALUE(VEC_META, '$.height') = TO_DOUBLE(?)",
    [5.7],
  ],
  [
    { height: { $gt: 0.0 } },
    [1, 2, 3],
    "WHERE JSON_VALUE(VEC_META, '$.height') > TO_DOUBLE(?)",
    [0.0],
  ],
  [
    { height: { $gt: 5.0 } },
    [1, 2],
    "WHERE JSON_VALUE(VEC_META, '$.height') > TO_DOUBLE(?)",
    [5.0],
  ],
  [
    { height: { $gte: 5.0 } },
    [1, 2],
    "WHERE JSON_VALUE(VEC_META, '$.height') >= TO_DOUBLE(?)",
    [5.0],
  ],
  [
    { height: { $lt: 5.0 } },
    [3],
    "WHERE JSON_VALUE(VEC_META, '$.height') < TO_DOUBLE(?)",
    [5.0],
  ],
  [
    { height: { $lte: 5.8 } },
    [2, 3],
    "WHERE JSON_VALUE(VEC_META, '$.height') <= TO_DOUBLE(?)",
    [5.8],
  ],
];

export const TYPE_3_FILTERING_TEST_CASES: FilteringTestCase[] = [
  // These involve usage of AND and OR operators
  [
    { $or: [{ id: 1 }, { id: 2 }] },
    [1, 2],
    "WHERE (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)) OR (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?))",
    [1, 2],
  ],
  [
    { $or: [{ id: 1 }, { name: "bob" }] },
    [1, 2],
    "WHERE (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)) OR (JSON_VALUE(VEC_META, '$.name') = TO_NVARCHAR(?))",
    [1, "bob"],
  ],
  [
    { $and: [{ id: 1 }, { id: 2 }] },
    [],
    "WHERE (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)) AND (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?))",
    [1, 2],
  ],
  [
    { $or: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    [1, 2, 3],
    "WHERE (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)) OR (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?)) OR (JSON_VALUE(VEC_META, '$.id') = TO_DOUBLE(?))",
    [1, 2, 3],
  ],
];

export const TYPE_4_FILTERING_TEST_CASES: FilteringTestCase[] = [
  // These involve special operators like $in, $nin, $between
  // Test between
  [
    { id: { $between: [1, 2] } },
    [1, 2],
    "WHERE JSON_VALUE(VEC_META, '$.id') BETWEEN TO_DOUBLE(?) AND TO_DOUBLE(?)",
    [1, 2],
  ],
  [
    { id: { $between: [1, 1] } },
    [1],
    "WHERE JSON_VALUE(VEC_META, '$.id') BETWEEN TO_DOUBLE(?) AND TO_DOUBLE(?)",
    [1, 1],
  ],
  [
    { name: { $in: ["adam", "bob"] } },
    [1, 2],
    "WHERE JSON_VALUE(VEC_META, '$.name') IN (TO_NVARCHAR(?), TO_NVARCHAR(?))",
    ["adam", "bob"],
  ],
];

export const TYPE_4B_FILTERING_TEST_CASES: FilteringTestCase[] = [
  // Test $nin, which is missing in TYPE_4_FILTERING_TEST_CASES
  [
    { name: { $nin: ["adam", "bob"] } },
    [3],
    "WHERE JSON_VALUE(VEC_META, '$.name') NOT IN (TO_NVARCHAR(?), TO_NVARCHAR(?))",
    ["adam", "bob"],
  ],
];

export const TYPE_5_FILTERING_TEST_CASES: FilteringTestCase[] = [
  // These involve special operators like $like, $ilike that
  // may be specified to certain databases.
  [
    { name: { $like: "a%" } },
    [1],
    "WHERE JSON_VALUE(VEC_META, '$.name') LIKE TO_NVARCHAR(?)",
    ["a%"],
  ],
  [
    { name: { $like: "%a%" } },
    [1, 3],
    "WHERE JSON_VALUE(VEC_META, '$.name') LIKE TO_NVARCHAR(?)",
    ["%a%"],
  ],
];

export const TYPE_6_DATE_FILTERING_TEST_CASES: FilteringTestCase[] = [
  // These involve date filtering with TO_DATE
  // Implicit $eq with date
  [
    { date: new Date("2021-01-01") },
    [1, 3], // adam and jane have date 2021-01-01
    "WHERE JSON_VALUE(VEC_META, '$.date') = TO_DATE(?)",
    ["2021-01-01"],
  ],
  // Explicit $eq with date
  [
    { date: { $eq: new Date("2021-01-02") } },
    [2], // bob has date 2021-01-02
    "WHERE JSON_VALUE(VEC_META, '$.date') = TO_DATE(?)",
    ["2021-01-02"],
  ],
  // $ne with date
  [
    { date: { $ne: new Date("2021-01-01") } },
    [2], // bob is the only one with a different date
    "WHERE JSON_VALUE(VEC_META, '$.date') <> TO_DATE(?)",
    ["2021-01-01"],
  ],
  // $gt with date
  [
    { date: { $gt: new Date("2021-01-01") } },
    [2], // bob has date 2021-01-02
    "WHERE JSON_VALUE(VEC_META, '$.date') > TO_DATE(?)",
    ["2021-01-01"],
  ],
  // $gte with date
  [
    { date: { $gte: new Date("2021-01-01") } },
    [1, 2, 3], // all documents
    "WHERE JSON_VALUE(VEC_META, '$.date') >= TO_DATE(?)",
    ["2021-01-01"],
  ],
  // $lt with date
  [
    { date: { $lt: new Date("2021-01-02") } },
    [1, 3], // adam and jane
    "WHERE JSON_VALUE(VEC_META, '$.date') < TO_DATE(?)",
    ["2021-01-02"],
  ],
  // $lte with date
  [
    { date: { $lte: new Date("2021-01-01") } },
    [1, 3], // adam and jane
    "WHERE JSON_VALUE(VEC_META, '$.date') <= TO_DATE(?)",
    ["2021-01-01"],
  ],
  // $between with dates
  [
    { date: { $between: [new Date("2021-01-01"), new Date("2021-01-02")] } },
    [1, 2, 3], // all documents
    "WHERE JSON_VALUE(VEC_META, '$.date') BETWEEN TO_DATE(?) AND TO_DATE(?)",
    ["2021-01-01", "2021-01-02"],
  ],
  // $in with dates
  [
    {
      date: {
        $in: [
          new Date("2021-01-01"),
          new Date("2021-01-03"), // date that doesn't exist
        ],
      },
    },
    [1, 3], // adam and jane
    "WHERE JSON_VALUE(VEC_META, '$.date') IN (TO_DATE(?), TO_DATE(?))",
    ["2021-01-01", "2021-01-03"],
  ],
];

export const FILTERING_TEST_CASES: FilteringTestCase[] = [
  ...TYPE_1_FILTERING_TEST_CASES,
  ...TYPE_2_FILTERING_TEST_CASES,
  ...TYPE_3_FILTERING_TEST_CASES,
  ...TYPE_4_FILTERING_TEST_CASES,
  ...TYPE_4B_FILTERING_TEST_CASES,
  ...TYPE_5_FILTERING_TEST_CASES,
  ...TYPE_6_DATE_FILTERING_TEST_CASES,
];

export const ERROR_FILTERING_TEST_CASES: ErrorFilteringTestCase[] = [
  // These involve invalid filter formats that should raise errors
  // more than one operator at the same level
  [
    { name: { $eq: "adam", $ne: "bob" } },
    'Expecting a single entry \'operator: operands\', but got {"$eq":"adam","$ne":"bob"}',
  ],
  // logical operators
  [
    { $or: [{ id: 1 }] },
    'Expected an array of at least two operands for operator=$or, but got operands=[{"id":1}]',
  ],
  [
    { $and: "adam" },
    'Expected an array of at least two operands for operator=$and, but got operands="adam"',
  ],
  // contains operator
  [
    { tags: { $contains: "" } },
    'Operator $contains expects a non-empty string operand, but got ""',
  ],
  [
    { tags: { $contains: 5 } },
    "Operator $contains expects a non-empty string operand, but got 5",
  ],
  // like operator
  [
    { name: { $like: false } },
    "Operator $like expects a string operand, but got false",
  ],
  // between operator
  [
    { id: { $between: [1] } },
    "Operator $between expects 2 operands, but got [1]",
  ],
  [
    { id: { $between: [1, "2"] } },
    'Operator $between expects operands of the same type, but got [1,"2"]',
  ],
  [
    // Typescript infers isInteger(2.0) as true, therefore we need a non-zero decimal part
    { id: { $between: [1, 2.1] } },
    "Operator $between expects operands of the same type, but got [1,2.1]",
  ],
  [
    { id: { $between: [false, true] } },
    "Operator $between expects operand types (int, float, str, date), but got [false,true]",
  ],
  // in operators
  [{ name: { $in: [] } }, "Operator $in expects at least 1 operand"],
  [
    { name: { $in: ["adam", 1] } },
    'Operator $in expects operands of the same type, but got ["adam",1]',
  ],
  [{ name: { $nin: [] } }, "Operator $nin expects at least 1 operand"],
  [
    { name: { $nin: ["adam", 1] } },
    'Operator $nin expects operands of the same type, but got ["adam",1]',
  ],
  // eq and ne operators
  [
    { name: { $eq: ["unexpected", "list"] } },
    'Operator $eq expects a single operand, but got object: ["unexpected","list"]',
  ],
  [
    { name: { $ne: ["unexpected", "list"] } },
    'Operator $ne expects a single operand, but got object: ["unexpected","list"]',
  ],
  // gt, gte, lt, lte operators
  [
    { name: { $gt: ["unexpected", "list"] } },
    'Operator $gt expects a single operand, but got object: ["unexpected","list"]',
  ],
  [
    { name: { $gte: false } },
    "Operator $gte expects operand of type (int, float, str, date), but got false",
  ],
  [
    { name: { $lt: ["unexpected", "list"] } },
    'Operator $lt expects a single operand, but got object: ["unexpected","list"]',
  ],
  [
    { name: { $lte: true } },
    "Operator $lte expects operand of type (int, float, str, date), but got true",
  ],
];
