import { BasePromptTemplate } from "@langchain/core/prompts";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Runnable, RunnableSequence } from "@langchain/core/runnables";
import { BaseChain, ChainInputs } from "langchain/chains";
import { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import { ChainValues } from "@langchain/core/utils/types";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { HanaRdfGraph } from "../../graphs/hanaRdfGraph.js";
import {
  SPARQL_GENERATION_SELECT_PROMPT,
  SPARQL_QA_PROMPT,
} from "./prompts.js";

export interface HanaSparqlQAChainOptions {
  llm: BaseChatModel;
  sparqlGenerationPrompt?: BasePromptTemplate;
  qaPrompt?: BasePromptTemplate;
  graph: HanaRdfGraph;
  allowDangerousRequests?: boolean;
}

/**
 * Chain for question-answering against a SAP HANA CLOUD Knowledge Graph Engine
 * by generating SPARQL statements.
 *
 * Example:
 *     const chain = HanaSparqlQAChain.fromLLM({
 *         llm,
 *         allowDangerousRequests: true,
 *         graph
 *     });
 *     const response = await chain.invoke({ query });
 *
 * *Security note*: Make sure that the database connection uses credentials
 *     that are narrowly-scoped to only include necessary permissions.
 *     Failure to do so may result in data corruption or loss, since the calling
 *     code may attempt commands that would result in deletion, mutation
 *     of data if appropriately prompted or reading sensitive data if such
 *     data is present in the database.
 *     The best way to guard against such negative outcomes is to (as appropriate)
 *     limit the permissions granted to the credentials used with this tool.
 *
 *     See https://js.langchain.com/docs/security for more information.
 */
export class HanaSparqlQAChain extends BaseChain {
  private graph: HanaRdfGraph;

  private sparqlGenerationChain: Runnable;

  private qaChain: Runnable;

  private inputKey = "query";

  private outputKey = "result";

  private allowDangerousRequests = false;

  /**
   * Initialize the HanaSparqlQAChain.
   * @param config - Configuration object.
   */
  constructor(config: {
    graph: HanaRdfGraph;
    sparqlGenerationChain: Runnable;
    qaChain: Runnable;
    allowDangerousRequests?: boolean;
  }) {
    super(config as ChainInputs);
    this.graph = config.graph;
    this.sparqlGenerationChain = config.sparqlGenerationChain;
    this.qaChain = config.qaChain;
    this.allowDangerousRequests = config.allowDangerousRequests ?? false;

    if (!this.allowDangerousRequests) {
      throw new Error(
        "In order to use this chain, you must acknowledge that it can make " +
          "dangerous requests by setting `allowDangerousRequests` to `true`." +
          "You must narrowly scope the permissions of the database connection " +
          "to only include necessary permissions. Failure to do so may result " +
          "in data corruption or loss or reading sensitive data if such data is " +
          "present in the database." +
          "Only use this chain if you understand the risks and have taken the " +
          "necessary precautions. " +
          "See https://js.langchain.com/docs/security for more information."
      );
    }
  }

  _chainType() {
    return "sparql_qa_chain" as const;
  }

  get inputKeys(): string[] {
    return [this.inputKey];
  }

  get outputKeys(): string[] {
    return [this.outputKey];
  }

  static fromLLM({
    llm,
    sparqlGenerationPrompt = SPARQL_GENERATION_SELECT_PROMPT,
    qaPrompt = SPARQL_QA_PROMPT,
    graph,
    allowDangerousRequests,
  }: HanaSparqlQAChainOptions): HanaSparqlQAChain {
    const sparqlGenerationChain = RunnableSequence.from([
      sparqlGenerationPrompt,
      llm,
      new StringOutputParser(),
    ]);

    const qaChain = RunnableSequence.from([
      qaPrompt,
      llm,
      new StringOutputParser(),
    ]);

    return new HanaSparqlQAChain({
      graph,
      sparqlGenerationChain,
      qaChain,
      allowDangerousRequests,
    });
  }

  /**
   * Extracts SPARQL code from a given text.
   *
   * @param query - The text to extract SPARQL code from.
   * @returns The extracted SPARQL code.
   */
  static extractSparql(query: string): string {
    let trimmedQuery = query.trim();
    const queryToks = trimmedQuery.split("```");
    if (queryToks.length === 3) {
      // eslint-disable-next-line prefer-destructuring
      trimmedQuery = queryToks[1];
      if (trimmedQuery.startsWith("sparql")) {
        trimmedQuery = trimmedQuery.slice(6);
      }
    } else if (
      trimmedQuery.startsWith("<sparql>") &&
      trimmedQuery.endsWith("</sparql>")
    ) {
      trimmedQuery = trimmedQuery.slice(8, -9);
    }
    return trimmedQuery;
  }

  /**
   * Ensures common prefixes (rdf, rdfs, owl, xsd) are declared if used in the query.
   *
   * @param query - The SPARQL query to check.
   * @returns The updated query with necessary prefixes added, if missing.
   */
  private ensureCommonPrefixes(query: string): string {
    const common: Record<string, string> = {
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      rdfs: "http://www.w3.org/2000/01/rdf-schema#",
      owl: "http://www.w3.org/2002/07/owl#",
      xsd: "http://www.w3.org/2001/XMLSchema#",
    };

    const present = new Set<string>();
    for (const line of query.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.toUpperCase().startsWith("PREFIX ")) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2 && parts[1].endsWith(":")) {
          present.add(parts[1].slice(0, -1));
        }
      }
    }

    let prefixLines = "";
    for (const [p, uri] of Object.entries(common)) {
      if (!present.has(p) && query.includes(`${p}:`)) {
        prefixLines += `PREFIX ${p}: <${uri}>\n`;
      }
    }

    return prefixLines + query;
  }

  /**
   * Generates a SPARQL query, executes it against the graph, and answers the question.
   *
   * @param question - The natural language question to be answered.
   * @returns The answer retrieved from the graph.
   */
  async _call(
    inputs: ChainValues,
    runManager?: CallbackManagerForChainRun
  ): Promise<ChainValues> {
    const callbacks = runManager?.getChild();

    // Extract user question
    const question = inputs[this.inputKey];

    //  Generate SPARQL query from the question and schema
    let generatedSparql = await this.sparqlGenerationChain.invoke(
      {
        prompt: question,
        schema: this.graph.getSchema(),
      },
      { callbacks }
    );

    // Log the generated SPARQL
    await runManager?.handleText("Generated SPARQL:\n");
    await runManager?.handleText(`${generatedSparql} green\n`);

    // Extract the SPARQL code from the generated text and inject the from clause
    generatedSparql = HanaSparqlQAChain.extractSparql(generatedSparql);
    generatedSparql = this.graph.injectFromClause(generatedSparql);
    generatedSparql = this.ensureCommonPrefixes(generatedSparql);

    await runManager?.handleText("Final SPARQL:\n");
    await runManager?.handleText(`${generatedSparql} yellow\n`);

    // Execute the generated SPARQL query against the graph
    const context = await this.graph.query(generatedSparql, false);

    // Log the full context (SPARQL results)
    await runManager?.handleText("Full Context:\n");
    await runManager?.handleText(`${context} green\n`);

    // Pass the question and query results into the QA chain
    const qaResult = await this.qaChain.invoke(
      {
        prompt: question,
        context,
      },
      { callbacks }
    );

    // Return the final answer
    return { [this.outputKey]: qaResult };
  }
}
