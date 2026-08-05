import { Connection, HanaParameterType } from "@sap/hana-client";
import { executeStatement, prepareQuery } from "../hanautils.js";

const _VALID_IDENTIFIER_RE = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

/**Raise an error if name is not a safe SQL/JSON identifier.*/
export function validateIdentifier(name: string): void {
  if (!_VALID_IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Invalid identifier '${name}': only letters, digits, and underscores are allowed, and it must not start with a digit.`
    );
  }
}

/**Validate that all metadata keys are valid identifiers.*/
export function sanitizeMetadataKeys(metadataKeys: string[]): void {
  metadataKeys.forEach((key) => {
    validateIdentifier(key);
  });
}

/**Validate that the provided model is supported by SAP HANA for reranking.*/
export async function validateRerankModelId(
  modelId: string,
  connection: Connection
): Promise<void> {
  if (!modelId) {
    throw new Error("modelId must be a non-empty string");
  }
  const sql = `SELECT CROSS_ENCODE('test', 'test', ?) OVER() FROM SYS.DUMMY`;
  const stm = await prepareQuery(connection, sql);
  await executeStatement(stm, [modelId]);
}

/**Generate SQL and parameters for CROSS_ENCODE function.*/
export function generateCrossEncodingSqlAndParams(
  textColumn: string,
  metadataColumn: string,
  query: string,
  rankFields: string[],
  rerankModelId: string
): [string, HanaParameterType[]] {
  let crossEncodeInput = "";
  if (rankFields.length > 0) {
    crossEncodeInput = `'${textColumn}:' || TO_NVARCHAR("${textColumn}")`;
    for (const field of rankFields) {
      crossEncodeInput += ` || '| ${field}:' || TO_NVARCHAR(COALESCE(JSON_VALUE("${metadataColumn}", '$.${field}'), ''))`;
    }
  } else {
    crossEncodeInput = `TO_NVARCHAR("${textColumn}")`;
  }
  const crossEncodingSql = `CROSS_ENCODE(${crossEncodeInput}, ?, ?) OVER()`;
  const crossEncodingParams: HanaParameterType[] = [query, rerankModelId];
  return [crossEncodingSql, crossEncodingParams];
}
