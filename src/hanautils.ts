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
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

export async function executeSparqlQuery(
  client: Connection,
  query: string,
  requestHeaders: string
): Promise<string> {
  const sparqlQuery = `CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)`;
  const stmt = await prepareQuery(client, sparqlQuery);

  return new Promise((resolve, reject) => {
    const params: HanaParameterList = {
      REQUEST: query,
      PARAMETER: requestHeaders,
    };
    stmt?.exec(params, (err: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve(stmt.getParameterValue(2));
      }
    });
  });
}

export function prepareQuery(
  client: Connection,
  query: string
): Promise<Statement | undefined> {
  return new Promise((resolve, reject) => {
    client.prepare(query, (err: Error, statement) => {
      if (err) {
        console.error("Prepare query error", err);
        reject(err);
      } else {
        resolve(statement);
      }
    });
  });
}

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

export const commonPrefixes: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};
