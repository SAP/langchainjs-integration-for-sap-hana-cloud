import { Document } from "@langchain/core/documents";
import { BaseDocumentCompressor } from "@langchain/core/retrievers/document_compressors";
import { Connection } from "@sap/hana-client";
import {
  executeBatchStatement,
  executeQuery,
  executeStatement,
  prepareQuery,
} from "../hanautils.js";
import {
  generateCrossEncodingSqlAndParams,
  sanitizeMetadataKeys,
  validateRerankModelId,
} from "./utils.js";

export class HanaReranker extends BaseDocumentCompressor {
  private connection: Connection;

  private modelId: string;

  constructor(connection: Connection, modelId: string) {
    super();
    this.connection = connection;
    this.modelId = modelId;
  }

  public async initialize() {
    await validateRerankModelId(this.modelId, this.connection);
  }

  /**
   * Reranks documents based on relevance to the query using SAP HANA's CROSS_ENCODE function.
   * @param documents - A sequence of Document objects to be reranked.
   * @param query - The query string to compare the documents against.
   * @param topN - Optional number of top results to return. If not provided, uses the default topN = 3.
   * @param returnDocuments - Whether to return the documents in the reranking results.
   * @param rankFields - additional list of metadata fields to include in the reranking along with the pageContent. Defaults to empty.
   * @returns A list of tuples containing the index, document, and score, ordered by relevance.
   */
  async rerank(
    documents: Document[],
    query: string,
    topN: number = 3,
    returnDocuments: boolean = true,
    rankFields: string[] = []
  ): Promise<[number, number][] | [number, number, Document][]> {
    if (topN <= 0 || topN > documents.length) {
      throw new Error(
        `topN must be greater than 0 and less than or equal to the number of documents`
      );
    }

    sanitizeMetadataKeys(rankFields);

    const client = this.connection;

    const tempTableName = `#RERANK_DOCS`;
    const createTempTableSql = `
      CREATE LOCAL TEMPORARY TABLE "${tempTableName}" (
        "INDEX" INTEGER,
        "ID" NVARCHAR(5000),
        "TEXT" NCLOB,
        "METADATA" NCLOB
      )
    `;
    await executeQuery(client, createTempTableSql);

    try {
      const insertSql = `INSERT INTO "${tempTableName}" ("INDEX", "ID", "TEXT", "METADATA") VALUES (?, ?, ?, ?)`;
      const insertStm = await prepareQuery(client, insertSql);
      const insertSqlParams = documents.map((doc, idx) => [
        idx,
        doc.id,
        doc.pageContent,
        JSON.stringify(doc.metadata),
      ]);
      await executeBatchStatement(insertStm, insertSqlParams);

      const [crossEncodingSql, crossEncodingParams] =
        generateCrossEncodingSqlAndParams(
          "TEXT",
          "METADATA",
          query,
          rankFields,
          this.modelId
        );

      const rerankSql = `
        SELECT 
          TOP ${topN}
          "INDEX",
          "ID",
          "TEXT",
          "METADATA",
          ${crossEncodingSql} AS "SCORE"
        FROM "${tempTableName}"
        ORDER BY "SCORE" DESC
      `;
      const rerankStm = await prepareQuery(client, rerankSql);
      const rerankResultSet = await executeStatement(
        rerankStm,
        crossEncodingParams
      );
      //eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = rerankResultSet.map((row: any) => {
        const index = row.INDEX;
        const score = row.SCORE;
        if (returnDocuments) {
          const id = row.ID;
          const text = row.TEXT;
          const metadata = JSON.parse(row.METADATA);
          const document = new Document({
            id,
            pageContent: text,
            metadata: metadata,
          });
          return [index, score, document];
        } else {
          return [index, score];
        }
      });
      return result;
    } finally {
      const dropTempTableSql = `DROP TABLE "${tempTableName}"`;
      await executeQuery(client, dropTempTableSql);
    }
  }

  /**
   * Compress documents using the rerank method.
   * @param documents - A sequence of Document objects to be compressed.
   * @param query - The query string to compare the documents against for relevance.
   * @returns A list of Document objects reranked according to relevance to the query.
   * Only the top 5 documents are returned, or fewer if there are less than 5 documents.
   * The scores are added to the metadata of each Document under the key "relevance_score".
   */
  async compressDocuments(
    documents: Document[],
    query: string
  ): Promise<Document[]> {
    const rerankResults = await this.rerank(
      documents,
      query,
      Math.min(5, documents.length)
    );
    const compressedDocs = rerankResults.map(([, score, doc]) => {
      doc!.metadata["relevance_score"] = score;
      return doc!;
    });
    return compressedDocs;
  }
}
