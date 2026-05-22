import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "./src/index.ts",
    "./src/chains/index.ts",
    "./src/embeddings/index.ts",
    "./src/graphs/index.ts",
    "./src/structured_query/index.ts",
    "./src/vectorstores/index.ts",
  ],
  format: ["cjs", "esm"],
  target: "es2022",
  platform: "node",
  fixedExtension: false,
  dts: {
    parallel: true,
  },
  sourcemap: true,
  unbundle: true,
  attw: {
    profile: "node16",
    level: "error",
  },
  publint: {
    level: "error",
    strict: true,
  },
  unused: {
    level: "error",
  },
  ignoreWatch: ["dist", "node_modules"],
});
