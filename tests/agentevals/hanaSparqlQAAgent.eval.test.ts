/**
 * Agent evaluations for HanaSparqlQAAgent using agentevals.
 *
 * These evaluations require a live SAP HANA Cloud instance (with the
 * `kgdocu_movies` knowledge graph loaded) and SAP AI Core credentials.
 * Run them explicitly with `pnpm test:eval`.
 */
import hanaClient, { Connection } from "@sap/hana-client";
import { AzureOpenAiChatClient } from "@sap-ai-sdk/langchain";
import { BaseMessage } from "@langchain/core/messages";
import {
  createTrajectoryLLMAsJudge,
  createTrajectoryMatchEvaluator,
  TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE,
} from "agentevals";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { HanaRdfGraph, HanaSparqlQAAgent } from "../../src/index.js";
import { HanaTestUtils } from "../integration_tests/hana.test.utils.js";
import {
  ANSWER_EVALS,
  FOLLOWUP_EVALS,
  OFF_TOPIC_EVALS,
  TRAJECTORY_EVALS,
  type ChatMessage,
  type TrajectoryEval,
} from "../fixtures/agentEvals.fixtures.js";

/* eslint-disable no-process-env */
const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};
/* eslint-enable no-process-env */

let client: Connection;
let llm: AzureOpenAiChatClient;
let agent: ReturnType<typeof HanaSparqlQAAgent.createAgent>;
let trajectoryMatchEvaluator: ReturnType<typeof createTrajectoryMatchEvaluator>;
let trajectoryLlmJudge: ReturnType<typeof createTrajectoryLLMAsJudge>;

beforeAll(async () => {
  client = hanaClient.createConnection(connectionParams);
  await HanaTestUtils.connectToHANA(client);

  const graphOptions = {
    connection: client,
    graphUri: "kgdocu_movies",
    autoExtractOntology: true,
  };
  const graph = new HanaRdfGraph(graphOptions);
  await graph.initialize(graphOptions);

  llm = new AzureOpenAiChatClient({ modelName: "gpt-4o", temperature: 0 });
  agent = HanaSparqlQAAgent.createAgent(llm, { graph });

  trajectoryMatchEvaluator = createTrajectoryMatchEvaluator({
    trajectoryMatchMode: "superset",
    toolArgsMatchMode: "ignore",
  });
  trajectoryLlmJudge = createTrajectoryLLMAsJudge({
    prompt: TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE,
    judge: llm,
  });
});

afterAll(() => {
  client?.disconnect();
});

async function runAgent(inputMessages: ChatMessage[]): Promise<BaseMessage[]> {
  const result = await agent.invoke({ messages: inputMessages });
  return result.messages;
}

interface TrajectoryCase {
  category: string;
  question: string;
  referenceTrajectory: ChatMessage[];
  inputMessages: ChatMessage[];
}

function toCases(category: string, evals: TrajectoryEval[]): TrajectoryCase[] {
  return evals.map(([question, referenceTrajectory, inputMessages]) => ({
    category,
    question,
    referenceTrajectory,
    inputMessages,
  }));
}

const ALL_TRAJECTORY_CASES: TrajectoryCase[] = [
  ...toCases("trajectory", TRAJECTORY_EVALS),
  ...toCases("off_topic", OFF_TOPIC_EVALS),
  ...toCases("followup", FOLLOWUP_EVALS),
];

describe("HanaSparqlQAAgent trajectory match", () => {
  test.each(ALL_TRAJECTORY_CASES)(
    "$category::$question",
    async ({ category, question, referenceTrajectory, inputMessages }) => {
      const outputs = await runAgent(inputMessages);
      const result = await trajectoryMatchEvaluator({
        outputs,
        referenceOutputs: referenceTrajectory,
      });
      expect(
        result.score,
        `[${category}] trajectory mismatch for ${question}.\n` +
          `Reasoning: ${result.comment}\n` +
          `Got: ${JSON.stringify(outputs, null, 2)}`
      ).toBe(true);
    }
  );
});

describe("HanaSparqlQAAgent trajectory LLM judge", () => {
  test.each(ALL_TRAJECTORY_CASES)(
    "$category::$question",
    async ({ category, question, referenceTrajectory, inputMessages }) => {
      const outputs = await runAgent(inputMessages);
      const result = await trajectoryLlmJudge({
        outputs,
        referenceOutputs: referenceTrajectory,
      });
      expect(
        result.score,
        `[${category}] LLM judge scored trajectory as inaccurate ` +
          `for ${question}.\nReasoning: ${result.comment}`
      ).toBe(true);
    }
  );
});

const GRADER_INSTRUCTIONS = `You are a teacher grading a quiz.

You will be given a QUESTION, the GROUND TRUTH (correct) RESPONSE, and the STUDENT RESPONSE.

Here is the grade criteria to follow:
(1) Grade the student responses based ONLY on their factual accuracy relative to the ground truth answer.
(2) Ensure that the student response does not contain any conflicting statements.
(3) It is OK if the student response contains more information than the ground truth response, as long as it is factually accurate relative to the ground truth response.

Correctness:
True means that the student's response meets all of the criteria.
False means that the student's response does not meet all of the criteria.

Explain your reasoning in a step-by-step manner to ensure your reasoning and conclusion are correct.`;

const gradeSchema = z.object({
  reasoning: z
    .string()
    .describe(
      "Explain your reasoning for whether the actual response is correct or not."
    ),
  isCorrect: z
    .boolean()
    .describe(
      "True if the student response is mostly or exactly correct, otherwise False."
    ),
});

describe("HanaSparqlQAAgent answer LLM judge", () => {
  test.each(ANSWER_EVALS)("%s", async (question, referenceAnswer) => {
    const answerGrader = llm.withStructuredOutput(gradeSchema, {
      name: "grade",
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: question }],
    });
    const agentAnswer = result.messages[result.messages.length - 1].content;
    expect(
      agentAnswer,
      `Agent produced no final answer for ${question}`
    ).toBeTruthy();

    const userMessage =
      `QUESTION: ${question}\n` +
      `GROUND TRUTH RESPONSE: ${referenceAnswer}\n` +
      `STUDENT RESPONSE: ${String(agentAnswer)}`;
    const grade = await answerGrader.invoke([
      { role: "system", content: GRADER_INSTRUCTIONS },
      { role: "user", content: userMessage },
    ]);

    expect(
      grade.isCorrect,
      `LLM judge rejected the agent's answer for ${question}.\n` +
        `Reference: ${referenceAnswer}\n` +
        `Agent:     ${String(agentAnswer)}\n` +
        `Reasoning: ${grade.reasoning}`
    ).toBe(true);
  });
});
