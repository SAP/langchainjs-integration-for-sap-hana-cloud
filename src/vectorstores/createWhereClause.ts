import { Comparator as BaseComparator } from "@langchain/core/structured_query";

// Base value types that can be used in comparisons
export type ComparisonRValue =
  | string
  | number
  | boolean
  | Date
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
  [property: string]:
    | string
    | number
    | boolean
    | Date
    | null
    | ComparatorFilter;
};

export type Filter = PropertyFilter | LogicalFilter;

/**
 * Represents a filter operand with type information for validation and error messages.
 */
class FilterOperand {
  public readonly value: boolean | number | string;
  public readonly theType: "bool" | "int" | "float" | "str" | "date";

  constructor(value: unknown) {
    if (typeof value === "boolean") {
      this.value = value;
      this.theType = "bool";
    } else if (typeof value === "number") {
      this.value = value;
      this.theType = Number.isInteger(value) ? "int" : "float";
    } else if (typeof value === "string") {
      this.value = value;
      this.theType = "str";
      // eslint-disable-next-line no-instanceof/no-instanceof
    } else if (value instanceof Date) {
      this.value = value.toISOString().split("T")[0];
      this.theType = "date";
    } else {
      throw new Error(
        `Operand cannot be created from ${JSON.stringify(value)}`
      );
    }
  }

  toString(): string {
    return `${JSON.stringify(this.value)} (${this.theType})`;
  }
}

/**
 * SQL operand with placeholder and value for parameterized queries.
 */
class SqlOperand {
  public readonly theType: "BOOLEAN" | "DOUBLE" | "NVARCHAR" | "DATE";
  public readonly placeholder: string;
  public readonly value: string;

  /** Construct SqlOperand from a FilterOperand. */
  constructor(operand: FilterOperand) {
    if (operand.theType === "bool") {
      this.theType = "BOOLEAN";
      this.placeholder = "TO_BOOLEAN(?)";
      this.value = operand.value ? "true" : "false";
    } else if (operand.theType === "int" || operand.theType === "float") {
      this.theType = "DOUBLE";
      this.placeholder = "TO_DOUBLE(?)";
      this.value = String(operand.value);
    } else if (operand.theType === "str") {
      this.theType = "NVARCHAR";
      this.placeholder = "TO_NVARCHAR(?)";
      this.value = String(operand.value);
    } else if (operand.theType === "date") {
      this.theType = "DATE";
      this.placeholder = "TO_DATE(?)";
      this.value = String(operand.value);
    } else {
      // This should not happen if FilterOperand is constructed correctly.
      throw new Error(`Unreachable. operand=${operand}`);
    }
  }
}

/** Check that operands is an array and return list of FilterOperands. */
function determineFilterOperands(
  operator: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  operands: any
): FilterOperand[] {
  if (!Array.isArray(operands)) {
    throw new Error(
      `Operator ${operator} expects list/tuple of operands, but got ${JSON.stringify(operands)}`
    );
  }
  if (operands.length === 0) {
    throw new Error(`Operator ${operator} expects at least 1 operand`);
  }
  return operands.map((op) => determineSingleFilterOperand(operator, op));
}

/** Check that operands is a single value (not an array) and return FilterOperand. */
function determineSingleFilterOperand(
  operator: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  operand: any
): FilterOperand {
  if (Array.isArray(operand)) {
    throw new Error(
      `Operator ${operator} expects a single operand, but got ${typeof operand}: ${JSON.stringify(operand)}`
    );
  }
  try {
    return new FilterOperand(operand);
  } catch (e) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    const errorMessage = e instanceof Error ? e.message : String(e);
    throw new Error(`Operator ${operator}: ${errorMessage}`);
  }
}

function sqlSerializeLogicalClauses(
  sqlOperator: string,
  sqlClauses: string[]
): string {
  if (!["AND", "OR"].includes(sqlOperator)) {
    throw new Error(`${sqlOperator} is not in supported operators: [AND, OR]`);
  }
  if (sqlClauses.length === 0) {
    throw new Error("sqlClauses is empty");
  }
  if (sqlClauses.some((clause) => !clause)) {
    throw new Error(`Empty sql clause found in ${JSON.stringify(sqlClauses)}`);
  }
  if (sqlClauses.length === 1) {
    return sqlClauses[0];
  }
  return sqlClauses.map((clause) => `(${clause})`).join(` ${sqlOperator} `);
}

export class CreateWhereClause {
  private readonly specificMetadataColumns: string[];

  private readonly metadataColumn: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(hanaDb: any) {
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
      } else if (
        value !== null &&
        typeof value === "object" &&
        // eslint-disable-next-line no-instanceof/no-instanceof
        !(value instanceof Date)
      ) {
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
      } else if (value === null) {
        sqlClause = `${this.createSelector(key)} IS NULL`;
        queryParams = [];
      } else {
        // Value represents a typed SQL value (implicit $eq operator).
        let operand: FilterOperand;
        try {
          operand = new FilterOperand(value);
        } catch {
          throw new Error(
            `Implicit operator $eq received unsupported operand: ${JSON.stringify(value)}`
          );
        }
        const sqlOperand = new SqlOperand(operand);
        sqlClause = `${this.createSelector(key)} = ${sqlOperand.placeholder}`;
        queryParams = [sqlOperand.value];
      }
      statements.push(sqlClause);
      parameters.push(...queryParams);
    }

    return [sqlSerializeLogicalClauses("AND", statements), parameters];
  }

  private sqlSerializeColumnOperation(
    column: string,
    operator: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    operands: any
  ): [string, string[]] {
    const selector = this.createSelector(column);

    if (operator === "$contains") {
      const operand = determineSingleFilterOperand(operator, operands);
      if (operand.theType !== "str" || !operand.value) {
        throw new Error(
          `Operator $contains expects a non-empty string operand, but got ${JSON.stringify(operands)}`
        );
      }
      const sqlOperand = new SqlOperand(operand);
      const statement = `SCORE(${sqlOperand.placeholder} IN ("${column}" EXACT SEARCH MODE 'text')) > 0`;
      return [statement, [sqlOperand.value]];
    }

    if (operator === "$like") {
      const operand = determineSingleFilterOperand(operator, operands);
      if (operand.theType !== "str") {
        throw new Error(
          `Operator $like expects a string operand, but got ${JSON.stringify(operands)}`
        );
      }
      const sqlOperand = new SqlOperand(operand);
      const statement = `${selector} LIKE ${sqlOperand.placeholder}`;
      return [statement, [sqlOperand.value]];
    }

    if (operator === "$between") {
      const filterOperands = determineFilterOperands(operator, operands);
      if (filterOperands.length !== 2) {
        throw new Error(
          `Operator $between expects 2 operands, but got ${JSON.stringify(operands)}`
        );
      }
      const [fromOperand, toOperand] = filterOperands;
      if (fromOperand.theType !== toOperand.theType) {
        throw new Error(
          `Operator $between expects operands of the same type, but got ${JSON.stringify(operands)}`
        );
      }
      if (!["int", "float", "str", "date"].includes(fromOperand.theType)) {
        throw new Error(
          `Operator $between expects operand types (int, float, str, date), but got ${JSON.stringify(operands)}`
        );
      }
      const sqlFrom = new SqlOperand(fromOperand);
      const sqlTo = new SqlOperand(toOperand);
      const statement = `${selector} BETWEEN ${sqlFrom.placeholder} AND ${sqlTo.placeholder}`;
      return [statement, [sqlFrom.value, sqlTo.value]];
    }

    if (["$in", "$nin"].includes(operator)) {
      const sqlOperator = {
        $in: "IN",
        $nin: "NOT IN",
      }[operator];
      const filterOperands = determineFilterOperands(operator, operands);
      for (const op of filterOperands) {
        if (op.theType !== filterOperands[0].theType) {
          throw new Error(
            `Operator ${operator} expects operands of the same type, but got ${JSON.stringify(operands)}`
          );
        }
      }
      const sqlOperands = filterOperands.map((op) => new SqlOperand(op));
      const sqlPlaceholders = sqlOperands.map((sqlOp) => sqlOp.placeholder);
      const sqlValues = sqlOperands.map((sqlOp) => sqlOp.value);
      const statement = `${selector} ${sqlOperator} (${sqlPlaceholders.join(", ")})`;
      return [statement, sqlValues];
    }

    if (["$eq", "$ne"].includes(operator)) {
      // Allow null checks for equality operators
      if (operands === null) {
        const sqlOperation = {
          $eq: "IS NULL",
          $ne: "IS NOT NULL",
        }[operator];
        const statement = `${selector} ${sqlOperation}`;
        return [statement, []];
      }
      const sqlOperator = {
        $eq: "=",
        $ne: "<>",
      }[operator];
      const operand = determineSingleFilterOperand(operator, operands);
      const sqlOperand = new SqlOperand(operand);
      const statement = `${selector} ${sqlOperator} ${sqlOperand.placeholder}`;
      return [statement, [sqlOperand.value]];
    }

    if (["$gt", "$gte", "$lt", "$lte"].includes(operator)) {
      const operand = determineSingleFilterOperand(operator, operands);
      if (!["int", "float", "str", "date"].includes(operand.theType)) {
        throw new Error(
          `Operator ${operator} expects operand of type (int, float, str, date), but got ${JSON.stringify(operands)}`
        );
      }
      const sqlOperator = {
        $gt: ">",
        $gte: ">=",
        $lt: "<",
        $lte: "<=",
      }[operator];
      const sqlOperand = new SqlOperand(operand);
      const statement = `${selector} ${sqlOperator} ${sqlOperand.placeholder}`;
      return [statement, [sqlOperand.value]];
    }

    // Unknown operation if we reach this point.
    throw new Error(`Operator ${operator} is not supported`);
  }

  private sqlSerializeLogicalOperation(
    operator: LogicalOperator,
    operands: Filter[]
  ): [string, string[]] {
    if (!Array.isArray(operands) || operands.length < 2) {
      throw new Error(
        `Expected an array of at least two operands for operator=${operator}, but got operands=${JSON.stringify(operands)}`
      );
    }

    if (["$and", "$or"].includes(operator)) {
      const sqlClauses: string[] = [];
      const queryParams: string[] = [];

      for (const operand of operands) {
        const [clause, params] = this.createWhereClause(operand);
        sqlClauses.push(clause);
        queryParams.push(...params);
      }

      const logicalOperatorsToSql = {
        $and: "AND",
        $or: "OR",
      };

      return [
        sqlSerializeLogicalClauses(logicalOperatorsToSql[operator], sqlClauses),
        queryParams,
      ];
    }

    // if we reach this point, the operation is not supported
    throw new Error(`Operator ${operator} is not supported`);
  }

  private createSelector(column: string): string {
    if (this.specificMetadataColumns.includes(column)) {
      return `"${column}"`;
    } else {
      return `JSON_VALUE(${this.metadataColumn}, '$.${column}')`;
    }
  }
}
