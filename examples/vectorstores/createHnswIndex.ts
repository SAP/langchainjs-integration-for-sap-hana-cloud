import hanaClient from "@sap/hana-client";
import { HanaDB, HanaDBArgs } from "@sap/hana-langchain";
import { OpenAIEmbeddings } from "@langchain/openai";

// table "test_fromDocs" is already created with the previous example.
// Now, we will use this existing table to create indexes and perform similarity search.

const connectionParams = {
  host: process.env.HANA_DB_ADDRESS,
  port: process.env.HANA_DB_PORT,
  user: process.env.HANA_DB_USER,
  password: process.env.HANA_DB_PASSWORD,
};
const client = hanaClient.createConnection(connectionParams);

// Connect to SAP HANA
await new Promise<void>((resolve, reject) => {
  client.connect((err: Error) => {
    if (err) {
      reject(err);
    } else {
      console.log("Connected to SAP HANA successfully.");
      resolve();
    }
  });
});

// Initialize embeddings
const embeddings = new OpenAIEmbeddings();

// First instance using the existing table "test_fromDocs" (default: Cosine similarity)
const argsCosine: HanaDBArgs = {
  connection: client,
  tableName: "test_fromDocs",
};

// Creating a HanaDB instance with L2 distance as the similarity function and defined values
const argsL2: HanaDBArgs = {
  connection: client,
  tableName: "test_fromDocs",
  distanceStrategy: "EUCLIDEAN", // Use Euclidean distance for this instance
};

// Initialize both HanaDB instances
const vectorStoreCosine = new HanaDB(embeddings, argsCosine);
await vectorStoreCosine.initialize();
const vectorStoreL2 = new HanaDB(embeddings, argsL2);
await vectorStoreL2.initialize();

// Create HNSW index with Cosine similarity (default)
// create the HNSW index with default parameters
await vectorStoreCosine.createHnswIndex(); // If no other parameters are specified, the default values will be used
// Default values: m=64, efConstruction=128, efSearch=200
// The default index name will be: test_fromDocs_idx

// Create HNSW index with Euclidean (L2) distance
await vectorStoreL2.createHnswIndex({
  indexName: "hnsw_l2_index", 
  efSearch: 400, // Max number of neighbors per graph node (valid range: 4 to 1000)
  m: 50, // Max number of candidates during graph construction (valid range: 1 to 100000)
  efConstruction: 150, // Min number of candidates during the search (valid range: 1 to 100000)
});

// Query text for similarity search
const query = "What did the president say about Ketanji Brown Jackson";

// Use L2 index to perform MMR
const docsL2HNSW = await vectorStoreL2.maxMarginalRelevanceSearch(query, {
  k: 2,
  fetchK: 20,
});
docsL2HNSW.forEach((doc) => {
  console.log("-".repeat(80));
  console.log(doc.pageContent);
});
/*
--------------------------------------------------------------------------------
One of the most serious constitutional responsibilities a President has is nominating someone to serve on the United States Supreme Court.

And I did that 4 days ago, when I nominated Circuit Court of Appeals Judge Ketanji Brown Jackson. One of our nation’s top legal minds, who will continue Justice Breyer’s legacy of excellence.
--------------------------------------------------------------------------------
Groups of citizens blocking tanks with their bodies. Everyone from students to retirees teachers turned soldiers defending their homeland.

In this struggle as President Zelenskyy said in his speech to the European Parliament “Light will win over darkness.” The Ukrainian Ambassador to the United States is here tonight.

Let each of us here tonight in this Chamber send an unmistakable signal to Ukraine and to the world.
*/

// Disconnect from SAP HANA after the operations
client.disconnect();
