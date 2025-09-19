import {
  Connection,
  HanaParameterList,
  HanaParameterType,
  Statement,
} from "@sap/hana-client";

export type DistanceStrategy = "EUCLIDEAN" | "COSINE";

export function validateK(k: number) {
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error("Parameter 'k' must be an integer greater than 0");
  }
}

export function validateKAndFetchK(k: number, fetchK: number) {
  validateK(k);
  if (!Number.isInteger(fetchK) || fetchK < k) {
    throw new Error(
      "Parameter 'fetch_k' must be an integer greater than or equal to 'k'"
    );
  }
  return fetchK;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executeQuery(client: Connection, query: string): Promise<any> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.exec(query, (err: Error, result: any) => {
      if (err) {
        console.error("Execute query error", err);
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prepareQuery(
  client: Connection,
  query: string
): Promise<Statement | undefined> {
  return new Promise((resolve, reject) => {
    client.prepare(query, (err: Error, statement) => {
      if (err) {
        reject(err);
      } else {
        resolve(statement);
      }
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executeStatement(
  statement: Statement | undefined,
  params: HanaParameterList
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statement?.exec(params, (err: Error, res: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executeProcedureStatement(
  statement: Statement | undefined,
  params: HanaParameterList
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statement?.exec(
      params,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: Error, _: any, outParams: HanaParameterList) => {
        if (err) {
          reject(err);
        } else {
          resolve(outParams);
        }
      }
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executeBatchStatement(
  statement: Statement | undefined,
  params: HanaParameterType[][]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statement?.execBatch(params, (err: Error, res: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
}
