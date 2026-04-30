import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";

/**
 * Parameters for initializing HanaInternalEmbeddings.
 * @property internalEmbeddingModelId - The ID of the internal embedding model used by the HANA database.
 * @property remoteSource - (Optional) The remote source name if using a deployed SAP AI CORE instance.
 */
export interface HanaInternalEmbeddingsParams extends EmbeddingsParams {
  /**
   * The ID of the internal embedding model used by the HANA database.
   */
  internalEmbeddingModelId: string;
  /**
   * (Optional) The name of the schema where the remote source is defined, if applicable.
   */
  remoteSourceSchema?: string;
  /**
   * (Optional) The remote source name if using a deployed SAP AI CORE instance.
   */
  remoteSource?: string;
}

/**
 * A dummy embeddings class for use with HANA's internal embedding functionality.
 * This class prevents the use of standard embedding methods and ensures that
 * internal embeddings are handled exclusively via database queries.
 *
 * @example
 *  const internalEmbeddings = new HanaInternalEmbeddings({
 *    internalEmbeddingModelId: "your_model_id_here",
 *  });
 *
 *  // The following calls will throw errors:
 *  await internalEmbeddings.embedQuery("sample text"); // Throws error
 *  await internalEmbeddings.embedDocuments(["text one", "text two"]); // Throws error
 *
 *  // Retrieve the internal model id:
 *  console.log(internalEmbeddings.getModelId());
 *
 *  // If using a remote source, retrieve the remote source and schema:
 *  console.log(internalEmbeddings.getRemoteSource());
 *  console.log(internalEmbeddings.getRemoteSourceSchema());
 */
export class HanaInternalEmbeddings extends Embeddings {
  private modelId: string;
  private remoteSourceSchema: string;
  private remoteSource: string;

  /**
   * A flag to indicate this class is HANA-specific.
   */
  public readonly isHanaInternalEmbeddings = true;

  constructor(fields: HanaInternalEmbeddingsParams) {
    super(fields);
    this.modelId = fields.internalEmbeddingModelId;
    this.remoteSourceSchema = fields.remoteSourceSchema || "";
    this.remoteSource = fields.remoteSource || "";
  }

  /**
   * This method is not applicable for HANA internal embeddings.
   * @throws Error indicating that internal embeddings cannot be used externally.
   */
  async embedQuery(_text: string): Promise<number[]> {
    throw new Error(
      "Internal embeddings cannot be used externally. Use HANA's internal embedding functionality instead."
    );
  }

  /**
   * This method is not applicable for HANA internal embeddings.
   * @throws Error indicating that internal embeddings cannot be used externally.
   */
  async embedDocuments(_texts: string[]): Promise<number[][]> {
    throw new Error(
      "Internal embeddings cannot be used externally. Use HANA's internal embedding functionality instead."
    );
  }

  /**
   * Retrieves the internal embedding model ID.
   * @returns The internal embedding model ID.
   */
  getModelId(): string {
    return this.modelId;
  }

  /**
   * Retrieves the internal embedding remote source schema name, if defined.
   * @returns The internal embedding remote source schema name.
   */
  getRemoteSourceSchema(): string {
    return this.remoteSourceSchema;
  }

  /**
   * Retrieves the internal embedding remote source name, if defined.
   * @returns The internal embedding remote source name.
   */
  getRemoteSource(): string {
    return this.remoteSource;
  }
}
