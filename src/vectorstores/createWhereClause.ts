import { Comparator as BaseComparator } from "@langchain/core/structured_query";
import { HanaDB } from "./hanaDb.js";

// Base value types that can be used in comparisons
export type ComparisonRValue =
  | string
  | number
  | boolean
  | DateValue
  | Array<ComparisonRValue>;

type Comparator =
  | BaseComparator
  | "like"
  | "contains"
  | "in"
  | "nin"
  | "between";

// Filter using comparison operators
// Defines the relationship between a comparison operator and its value
type ComparatorFilter = {
  [K in Comparator as `$${K}`]?: ComparisonRValue;
};

type LogicalOperator = "$and" | "$or";

type LogicalFilter = {
  [K in LogicalOperator]?: Filter[];
};
type PropertyFilter = {
  [property: string]: string | number | boolean | Date | ComparatorFilter;
};

export type Filter = PropertyFilter | LogicalFilter;

interface DateValue {
  type: "date";
  date: string | Date;
}

const COMPARISONS_TO_SQL: Record<string, string> = {
  $eq: "=",
  $ne: "<>",
  $lt: "<",
  $lte: "<=",
  $gt: ">",
  $gte: ">=",
};

const IN_OPERATORS_TO_SQL: Record<string, string> = {
  $in: "IN",
  $nin: "NOT IN",
};

const BETWEEN_OPERATOR = "$between";
const LIKE_OPERATOR = "$like";
export const CONTAINS_OPERATOR = "$contains";

const CONTAINS_NEEDS_SPECIAL_SYNTAX = Symbol(
  "CONTAINS_OPERATOR needs special SQL syntax"
);

const COLUMN_OPERATORS: Record<
  string,
  string | typeof CONTAINS_NEEDS_SPECIAL_SYNTAX
> = {
  ...COMPARISONS_TO_SQL,
  ...IN_OPERATORS_TO_SQL,

  [BETWEEN_OPERATOR]: "BETWEEN",
  [LIKE_OPERATOR]: "LIKE",

  [CONTAINS_OPERATOR]: CONTAINS_NEEDS_SPECIAL_SYNTAX,
};

export const LOGICAL_OPERATORS_TO_SQL = { $and: "AND", $or: "OR" };

export class CreateWhereClause {
  private readonly specificMetadataColumns: string[];

  private readonly metadataColumn: string;

  constructor(hanaDb: HanaDB) {
    this.specificMetadataColumns = hanaDb.getSpecificMetadataColumns();
    this.metadataColumn = hanaDb.getMetadataColumn();
  }

  /**
   * Serializes a filter object to a WHERE clause (prepared statement) and its parameters.
   * The where clause should be appended to an existing SQL statement.
   *
   * @example
   * const [whereClause, parameters] = new CreateWhereClause(hanaDb).build(filter);
   * const [whereStr, queryTuple] = new CreateWhereClause(this).build(filter);
   * const sqlStr = `DELETE FROM "${this.tableName}" ${whereStr}`;
   * const client = this.connection;
   * const stm = await this.prepareQuery(client, sqlStr);
   * await this.executeStatement(stm, queryTuple);
   *
   * @param filter The filter object to serialize.
   * @returns A tuple containing the WHERE clause string and an array of parameters.
   */
  public build(filter?: Filter): [string, string[]] {
    if (!filter || Object.keys(filter).length === 0) {
      return ["", []];
    }

    const [statement, parameters] = this.createWhereClause(filter);

    const placeholderCount = (statement.match(/\?/g) || []).length;
    if (placeholderCount !== parameters.length) {
      throw new Error(
        `Internal error: Mismatch between '?' placeholders (${placeholderCount}) and parameters (${parameters.length})`
      );
    }

    return [`WHERE ${statement}`, parameters];
  }

  private createWhereClause(filter: Filter): [string, string[]] {
    if (!filter || Object.keys(filter).length === 0) {
      throw new Error("Empty filter");
    }
    const statements: string[] = [];
    const parameters: string[] = [];

    for (const [key, value] of Object.entries(filter)) {
      let sqlClause: string;
      let queryParams: string[];

      if (key.startsWith("$")) {
        // Generic filter objects may only have logical operators.
        [sqlClause, queryParams] = this.sqlSerializeLogicalOperation(
          key as LogicalOperator,
          value as Filter[]
        );
      } else {
        if (typeof value === "number" && !Number.isInteger(value)) {
          throw new Error(`Unsupported filter value type: ${typeof value}`);
        }
        if (typeof value === "object" && !("type" in value)) {
          if (Object.keys(value).length !== 1) {
            throw new Error(
              `Expecting a single entry 'operator: operands', but got ${JSON.stringify(
                value
              )}`
            );
          }
          const [operator, operands] = Object.entries(value)[0];
          [sqlClause, queryParams] = this.sqlSerializeColumnOperation(
            key,
            operator,
            operands
          );
        } else {
          const [placeholder, paramValue] =
            CreateWhereClause.determineTypedSqlPlaceholder(value);
          sqlClause = `${this.createSelector(key)} = ${placeholder}`;
          queryParams = [paramValue];
        }
      }
      statements.push(sqlClause);
      parameters.push(...queryParams);
    }

    return [
      CreateWhereClause.sqlSerializeLogicalClauses("AND", statements),
      parameters,
    ];
  }

  private sqlSerializeColumnOperation(
    column: string,
    operator: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    operands: any
  ): [string, string[]] {
    if (operator in LOGICAL_OPERATORS_TO_SQL) {
      throw new Error(`Did not expect a logical operator, but got ${operator}`);
    }
    if (!(operator in COLUMN_OPERATORS)) {
      throw new Error(`${operator} is not a valid column operator.`);
    }

    const sqlOperator = COLUMN_OPERATORS[operator];
    const selector = this.createSelector(column);

    if (operator === CONTAINS_OPERATOR) {
      const [placeholder, value] =
        CreateWhereClause.determineTypedSqlPlaceholder(operands);
      const statement = `SCORE(${placeholder} IN ("${column}" EXACT SEARCH MODE 'text')) > 0`;
      return [statement, [value]];
    }

    if (operator === BETWEEN_OPERATOR) {
      if (!Array.isArray(operands) || operands.length !== 2) {
        throw new Error(
          `Expected 2 operands for BETWEEN, but got ${JSON.stringify(operands)}`
        );
      }
      const [fromPlaceholder, fromValue] =
        CreateWhereClause.determineTypedSqlPlaceholder(operands[0]);
      const [toPlaceholder, toValue] =
        CreateWhereClause.determineTypedSqlPlaceholder(operands[1]);
      const statement = `${selector} ${
        sqlOperator as string
      } ${fromPlaceholder} AND ${toPlaceholder}`;
      return [statement, [fromValue, toValue]];
    }

    if (operator in IN_OPERATORS_TO_SQL) {
      if (!Array.isArray(operands)) {
        throw new Error(
          `Expected an array for IN operator, but got ${JSON.stringify(
            operands
          )}`
        );
      }
      const placeholderValueList = operands.map((item) =>
        CreateWhereClause.determineTypedSqlPlaceholder(item)
      );
      const placeholders = placeholderValueList
        .map((item) => item[0])
        .join(", ");
      const values = placeholderValueList.map((item) => item[1]);
      const statement = `${selector} ${
        sqlOperator as string
      } (${placeholders})`;
      return [statement, values];
    }

    // Default behavior for single value operators (e.g., =, >, <).
    const [placeholder, value] =
      CreateWhereClause.determineTypedSqlPlaceholder(operands);
    const statement = `${selector} ${sqlOperator as string} ${placeholder}`;
    return [statement, [value]];
  }

  // hdb requires string while sap/hana-client doesn't
  private static determineTypedSqlPlaceholder(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any
  ): [string, string] {
    const theType = typeof value;

    // Handle plain values
    if (theType === "boolean") {
      return ["TO_BOOLEAN(?)", value ? "true" : "false"];
    }
    if (theType === "number") {
      return ["TO_DOUBLE(?)", value.toString()];
    }

    // Do not accept empty values
    if (!value) {
      throw new Error("No operands provided");
    }

    // Handle container types: only allowed for dates.
    if (
      value instanceof Object &&
      "type" in value &&
      value.type === "date"
    ) {
      return ["TO_DATE(?)", value.date.toString()];
    }
    if (value instanceof Object) {
      throw new Error(`Cannot handle value ${JSON.stringify(value)}`);
    }

    console.warn(`Using plain SQL placeholder '?' for string value: ${value}`);
    return ["?", value];
  }

  private static sqlSerializeLogicalClauses(
    sqlOperator: string,
    sqlClauses: string[]
  ): string {
    const supportedOperators = Object.values(LOGICAL_OPERATORS_TO_SQL);
    if (!supportedOperators.includes(sqlOperator)) {
      throw new Error(
        `${sqlOperator} is not in supported operators: ${supportedOperators}`
      );
    }
    if (sqlClauses.length === 0) {
      throw new Error("sqlClauses is empty");
    }
    if (sqlClauses.some((clause) => !clause)) {
      throw new Error(
        `Empty sql clause found in ${JSON.stringify(sqlClauses)}`
      );
    }
    if (sqlClauses.length === 1) {
      return sqlClauses[0];
    }
    return sqlClauses.map((clause) => `(${clause})`).join(` ${sqlOperator} `);
  }

  private sqlSerializeLogicalOperation(
    operator: LogicalOperator,
    operands: Filter[]
  ): [string, string[]] {
    const sqlClauses: string[] = [];
    const queryParams: string[] = [];

    for (const operand of operands) {
      const [clause, params] = this.createWhereClause(operand);
      sqlClauses.push(clause);
      queryParams.push(...params);
    }

    return [
      CreateWhereClause.sqlSerializeLogicalClauses(
        LOGICAL_OPERATORS_TO_SQL[operator],
        sqlClauses
      ),
      queryParams,
    ];
  }

  private createSelector(column: string): string {
    if (this.specificMetadataColumns.includes(column)) {
      return `"${column}"`;
    } else {
      return `JSON_VALUE(${this.metadataColumn}, '$.${column}')`;
    }
  }
}
