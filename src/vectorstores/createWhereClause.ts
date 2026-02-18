import { Comparator as BaseComparator } from "@langchain/core/structured_query";
import { HanaDB } from "./hanaDb.js";

// Base value types that can be used in comparisons
export type ComparisonRValue =
  | string
  | number
  | boolean
  | DateValue
  | null
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
  [property: string]: string | number | boolean | Date | null | ComparatorFilter;
};

export type Filter = PropertyFilter | LogicalFilter;

interface DateValue {
  type: "date";
  date: string | Date;
}

const isDateValue = (value: unknown): value is DateValue => {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as DateValue).type === "date"
  );
};

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
          value
        );
      } else {
        if (value !== null && typeof value === "object" && !("type" in value)) {
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
          if (value === null) {
            sqlClause = `${this.createSelector(key)} IS NULL`;
            queryParams = [];
          } else {
            const [placeholder, paramValue] =
              CreateWhereClause.determineTypedSqlPlaceholder(value);
            sqlClause = `${this.createSelector(key)} = ${placeholder}`;
            queryParams = [paramValue];
          }
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

  private validateOperatorWithOperands(operator: string, operands: Filter[]| ComparisonRValue): void {
    if (operator in LOGICAL_OPERATORS_TO_SQL) {
      if (!Array.isArray(operands) || operands.length < 2) {
        throw new Error(
          `Expected an array of at least two operands for operator=${operator}, but got operands=${JSON.stringify(operands)}`
        );
      }
    } else if (operator in COLUMN_OPERATORS) {
      if (operator === CONTAINS_OPERATOR) {
        if (typeof operands !== "string" || !operands) {
          throw new Error(
            `Expected a non-empty string operand for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
      } else if (operator === LIKE_OPERATOR) {
        if (typeof operands !== "string") {
          throw new Error(
            `Expected a string operand for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
      } else if (operator === BETWEEN_OPERATOR) {
        if (!Array.isArray(operands) || operands.length !== 2) {
          throw new Error(
            `Expected an array of two operands for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
        if (typeof operands[0] !== typeof operands[1]) {
          throw new Error(
            `Expected operands of the same type for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
        if (
          typeof operands[0] === "boolean" ||
          !(
            typeof operands[0] === "number" ||
            typeof operands[0] === "string" ||
            isDateValue(operands[0])
          )
        ) {
          throw new Error(
            `Expected an array of (number, string, date) for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
      } else if (operator in IN_OPERATORS_TO_SQL) {
        if (!Array.isArray(operands) || operands.length === 0) {
          throw new Error(
            `Expected a non-empty array of operands for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
        const checkTypes = new Set(operands.map((op) => typeof op));
        if (checkTypes.size > 1) {
          throw new Error(
            `Expected operands of the same type for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
        const firstType = typeof operands[0];
        if (
          !(
            firstType === "number" ||
            firstType === "string" ||
            firstType === "boolean" ||
            operands.every((op) => isDateValue(op))
          )
        ) {
          throw new Error(
            `Expected an array of (number, string, boolean, date) for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
      }

      if (operator === "$eq" || operator === "$ne") {
        if (
          !(
            typeof operands === "number" ||
            typeof operands === "string" ||
            typeof operands === "boolean" ||
            isDateValue(operands) ||
            operands === null
          )
        ) {
          throw new Error(
            `Expected a (number, string, boolean, date, null) for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
      }
      if (
        operator === "$gt" ||
        operator === "$gte" ||
        operator === "$lt" ||
        operator === "$lte"
      ) {
        if (
          typeof operands === "boolean" ||
          !(
            typeof operands === "number" ||
            typeof operands === "string" ||
            isDateValue(operands)
          )
        ) {
          throw new Error(
            `Expected a (number, string, date) for operator=${operator}, but got operands=${JSON.stringify(operands)}`
          );
        }
      }
    } else {
      throw new Error(`Unexpected operator: operator=${operator}`);
    }
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

    this.validateOperatorWithOperands(operator, operands);

    const sqlOperator = COLUMN_OPERATORS[operator];
    const selector = this.createSelector(column);

    if (operator === CONTAINS_OPERATOR) {
      const [placeholder, value] =
        CreateWhereClause.determineTypedSqlPlaceholder(operands);
      const statement = `SCORE(${placeholder} IN ("${column}" EXACT SEARCH MODE 'text')) > 0`;
      return [statement, [value]];
    }

    if (operator === BETWEEN_OPERATOR) {
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
      const placeholderValueList = (operands as Array<ComparisonRValue>).map((item) =>
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

    // Allow null checks for equality operators
    if(operator === "$eq" && operands === null) {
      const statement = `${selector} IS NULL`;
      return [statement, []];
    }
    if(operator === "$ne" && operands === null) {
      const statement = `${selector} IS NOT NULL`;
      return [statement, []];
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
    if (theType === "string") {
      return ["TO_NVARCHAR(?)", value];
    }

    // Handle container types: only allowed for dates.
    if (isDateValue(value)) {
      return ["TO_DATE(?)", value.date.toString()];
    }
    if (theType === "object") {
      throw new Error(`Cannot handle value ${JSON.stringify(value)}`);
    }

    // if we reach this point, the value type is not supported.
    throw new Error(`Unsupported value type: ${theType} for value ${JSON.stringify(value)}`);
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
    this.validateOperatorWithOperands(operator, operands);
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
