import { SystemMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { Writer } from "n3";
import { z } from "zod";
import {
  createAgent as createBaseAgent,
  modelRetryMiddleware,
  toolRetryMiddleware,
  type AnyAgentMiddleware,
} from "langchain";
import { commonPrefixes } from "../../hanautils.js";
import { HanaRdfGraph } from "../../graphs/hanaRdfGraph.js";
import { SYSTEM_PROMPT } from "./prompts.js";

/**
 * A tool that can be supplied to or created by {@link HanaSparqlQAAgent}.
 */
export type AgentTool = ClientTool | ServerTool;

/**
 * Options for constructing a {@link HanaSparqlQAAgent}.
 */
export interface HanaSparqlQAAgentOptions {
  /** The HANA RDF graph the agent queries. */
  graph: HanaRdfGraph;
  /** Additional tools to expose to the agent. */
  tools?: AgentTool[];
  /** Additional middleware to attach to the agent. */
  middleware?: AnyAgentMiddleware[];
  /** System prompt override. Defaults to the built-in SPARQL QA prompt. */
  systemPrompt?: string | SystemMessage;
  /** Whether to include the built-in ontology and SPARQL tools. Defaults to `true`. */
  includeDefaultTools?: boolean;
  /** Whether to include the built-in model call limit middleware. Defaults to `true`. */
  includeDefaultMiddleware?: boolean;
}

/**
 * Agent for answering questions using SPARQL against a SAP HANA Cloud RDF graph.
 *
 * The agent is backed by LangChain's `createAgent` harness and, by default, is
 * equipped with two tools:
 *
 * 1. `retrieveOntology` – returns the serialized ontology of the graph.
 * 2. `executeSparql` – runs a SPARQL query against the graph and returns the result.
 *
 * @example
 * ```ts
 * const agentConfig: HanaSparqlQAAgentOptions = {
 *   graph: myGraph,
 * };
 * const agent = HanaSparqlQAAgent.createAgent({
 *   model: "openai:gpt-4o",
 *   agentConfig,
 * });
 * const result = await agent.invoke({
 *   messages: [{ role: "user", content: "Who acted in Blade Runner?" }],
 * });
 * ```
 *
 * *Security note*: Make sure that the database connection uses credentials that
 *     are narrowly-scoped to only include necessary permissions. See
 *     https://js.langchain.com/docs/security for more information.
 */
export class HanaSparqlQAAgent {
  private graph: HanaRdfGraph;

  private ontology: string;

  private tools: AgentTool[];

  private middleware: AnyAgentMiddleware[];

  private systemPrompt: string | SystemMessage;

  constructor(config: HanaSparqlQAAgentOptions) {
    this.graph = config.graph;
    this.ontology = this.serializeSchema();

    if (config.systemPrompt !== undefined) {
      this.systemPrompt = config.systemPrompt;
    } else {
      this.systemPrompt = SYSTEM_PROMPT.replace(
        "{fromClause}",
        this.graph.getFromClause()
      );
    }

    // Create tools bound to this instance.
    this.tools = config.tools ? [...config.tools] : [];
    if (config.includeDefaultTools ?? true) {
      this.tools.push(this.createOntologyTool(), this.createSparqlTool());
    }

    // Create the middleware.
    this.middleware = config.middleware ? [...config.middleware] : [];
    if (config.includeDefaultMiddleware ?? true) {
      this.middleware.push(modelRetryMiddleware({ maxRetries: 3 }));
      this.middleware.push(toolRetryMiddleware({ maxRetries: 2 }));
    }
  }

  /**
   * Serializes the graph's RDF schema to a Turtle string.
   */
  private serializeSchema(): string {
    let serializedSchema = "";
    const writer = new Writer({
      format: "text/turtle",
      prefixes: commonPrefixes,
    });

    for (const quad of this.graph.getSchema()) {
      writer.addQuad(quad);
    }

    writer.end((error, result) => {
      if (error) {
        throw new Error(`Error serializing RDF graph: ${error.message}`);
      }
      serializedSchema = result;
    });

    return serializedSchema;
  }

  /**
   * Creates the tool that returns the ontology of the HANA RDF graph.
   */
  private createOntologyTool(): AgentTool {
    return tool(() => `Ontology Information:\n${this.ontology}`, {
      name: "retrieveOntology",
      description: "Retrieve ontology from the HANA RDF graph.",
      schema: z.object({}),
    });
  }

  /**
   * Creates the tool that executes a SPARQL query on the HANA RDF graph.
   */
  private createSparqlTool(): AgentTool {
    return tool(
      async ({ query }: { query: string }) => {
        try {
          const result = await this.graph.query(query);
          return `SPARQL Query Result:\n${result}`;
        } catch (error) {
          const message =
            typeof error === "object" && error !== null && "message" in error
              ? String((error as { message: unknown }).message)
              : String(error);
          return `Error executing SPARQL query: ${message}`;
        }
      },
      {
        name: "executeSparql",
        description:
          "Query the HANA RDF graph and return the fetched triples as a string.",
        schema: z.object({
          query: z
            .string()
            .describe("SPARQL query to execute on the RDF graph"),
        }),
      }
    );
  }

  /**
   * Creates a new SPARQL QA agent.
   * 
   * @param model The chat model, either a model identifier string or a `BaseChatModel` instance.
   * @param config Agent and model configuration.
   * @returns A SPARQL QA agent instance.
   */
  static createAgent(
    model : string | BaseChatModel,
    config: HanaSparqlQAAgentOptions
  ): ReturnType<typeof createBaseAgent> {
    const instance = new HanaSparqlQAAgent(config);
    return createBaseAgent({
      model,
      tools: instance.tools,
      systemPrompt: instance.systemPrompt,
      middleware: instance.middleware,
    });
  }
}
