import { Connection, HanaParameterType } from "@sap/hana-client";
import {
  executeStatement,
  prepareQuery,
  validateIdentifier,
} from "../hanautils.js";

// Re-exported from the shared hanautils module, which is the single source of
// truth for identifier validation across the vector store, checkpointers and
// memory stores.
export { validateIdentifier };

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
