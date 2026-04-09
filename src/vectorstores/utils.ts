import { HanaParameterType } from "@sap/hana-client";

export const compiledPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**Validate that all metadata keys are valid identifiers.*/
export function sanitizeMetadataKeys(metadataKeys: string[]): void {
  metadataKeys.forEach((key) => {
    if (!compiledPattern.test(key)) {
      throw new Error(`Invalid metadata key ${key}`);
    }
  });
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
    crossEncodeInput = `'${textColumn}:' || TO_NVARCHAR(${textColumn})`;
    for (const field of rankFields) {
      crossEncodeInput += ` || '| ${field}:' || TO_NVARCHAR(COALESCE(JSON_VALUE(${metadataColumn}, '$.${field}'), ''))`;
    }
  } else {
    crossEncodeInput = `TO_NVARCHAR(${textColumn})`;
  }
  const crossEncodingSql = `CROSS_ENCODE(${crossEncodeInput}, ?, ?) OVER()`;
  const crossEncodingParams: HanaParameterType[] = [query, rerankModelId];
  return [crossEncodingSql, crossEncodingParams];
}
