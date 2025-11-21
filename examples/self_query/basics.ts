import hanaClient from "@sap/hana-client";
// or import another node.js driver
// import hanaClient from "hdb"
import { HanaDB, HanaDBArgs, HanaTranslator } from "@sap/hana-langchain";
import { Document } from "@langchain/core/documents";
import {
  ChatOpenAI,
  OpenAIEmbeddings,
} from "@langchain/openai";
import { AttributeInfo } from "@langchain/classic/chains/query_constructor";
import { SelfQueryRetriever } from "@langchain/classic/retrievers/self_query";

/**
 * Prerequisite: Self Query features require
 * peggy to be installed as a peer dependency.
 * You can install it via:
 * npm install peggy or
 * yarn add peggy
 */

const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};

const client = hanaClient.createConnection(connectionParams);

// connect to hanaDB
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => {
    // Use arrow function here
    if (err) {
      reject(err);
    } else {
      console.log("Connected to SAP HANA successfully.");
      resolve();
    }
  });
});

// To be able to self query with good performance we create additional metadata fields
// for our vectorstore table in HANA:

// create table with metadata fields
// ensure table is not existing in the DB instance
await new Promise<void>((resolve, reject) => {
  client.exec(
    `CREATE TABLE "LANGCHAIN_DEMO_SELF_QUERY"  (
        "name" NVARCHAR(100), "is_active" BOOLEAN, "id" INTEGER, "height" DOUBLE,
        "VEC_TEXT" NCLOB, 
        "VEC_META" NCLOB, 
        "VEC_VECTOR" REAL_VECTOR
        )`,
    (err: Error) => {
      if (err) {
        console.log("Unable to create table");
        reject(err);
      }
      resolve();
    }
  );
});

const embeddings = new OpenAIEmbeddings();

// Add some test documents
const docs = [
  new Document({
    pageContent: "First",
    metadata: { name: "adam", is_active: true, id: 1, height: 10.0 },
  }),
  new Document({
    pageContent: "Second",
    metadata: { name: "bob", is_active: false, id: 2, height: 5.7 },
  }),
  new Document({
    pageContent: "Third",
    metadata: { name: "jane", is_active: true, id: 3, height: 2.4 },
  }),
];

const args: HanaDBArgs = {
  connection: client,
  tableName: "LANGCHAIN_DEMO_SELF_QUERY",
  specificMetadataColumns: ["name", "is_active", "id", "height"],
};

const db = new HanaDB(embeddings, args);
await db.initialize();

await db.delete({ filter: {} });
await db.addDocuments(docs);

// construct a self query retriever for hana vectorstore

const llm = new ChatOpenAI({ model: "gpt-4o" });

const metadataFieldInfo = [
  new AttributeInfo("name", "The name of the person", "string"),
  new AttributeInfo("is_active", "Whether the person is active", "boolean"),
  new AttributeInfo("id", "The ID of the person", "integer"),
  new AttributeInfo("height", "The height of the person in meters", "float"),
];

const documentContentDescription = "A collection of persons";

const hanaTranslator = new HanaTranslator();

const retriever = SelfQueryRetriever.fromLLM({
  llm,
  vectorStore: db,
  documentContents: documentContentDescription,
  attributeInfo: metadataFieldInfo,
  structuredQueryTranslator: hanaTranslator,
});

// use the retriever to prepare the self query for a person
const queryPrompt = "Which person is not active?"
const retreivedDocs = await retriever.invoke(queryPrompt);

for (const doc of retreivedDocs){
  console.log("-".repeat(80));
  console.log(doc.pageContent + " " + JSON.stringify(doc.metadata));
}
/**
--------------------------------------------------------------------------------
Second {"name":"bob","is_active":false,"id":2,"height":5.7}
 */
