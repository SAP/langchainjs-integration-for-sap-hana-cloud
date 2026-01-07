import { OpenAIEmbeddings } from "@langchain/openai";
import hanaClient from "@sap/hana-client";
import {
  HanaDB,
  HanaDBArgs,
} from "@sap/hana-langchain";

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
const embeddings = new OpenAIEmbeddings();
const args: HanaDBArgs = {
  connection: client,
  tableName: "test_fromTexts",
};
// This function will create a table "test_fromTexts" if not exist, if exists,
// then the value will be appended to the table.
const vectorStore = await HanaDB.fromTexts(
  ["Bye bye", "Hello world", "hello nice world"],
  [
    { id: 2, name: "2" },
    { id: 1, name: "1" },
    { id: 3, name: "3" },
  ],
  embeddings,
  args
);

const response = await vectorStore.similaritySearch("hello world", 2);

console.log(response);

/* This result is based on no table "test_fromTexts" existing in the database.
  [
    { pageContent: 'Hello world', metadata: { id: 1, name: '1' } },
    { pageContent: 'hello nice world', metadata: { id: 3, name: '3' } }
  ]
*/

// Disconnect from SAP HANA after the operations
client.disconnect();
