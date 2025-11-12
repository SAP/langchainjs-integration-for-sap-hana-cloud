# Developer Setup Documentation

## Overview

This document provides guidelines for setting up the development environment for working on this package. Additionally, it includes links to the LangChain repository for usage instructions.

---

## Developer Setup

### Prerequisites

To work on the package as a developer, you will need the following tools:

1. **Node**
   - This project uses Node v18+ as a Runtime Environment, as used by LangChain.
   - Refer to the [Node installation guide](https://nodejs.org/en/download) for instructions on how to install Node.

2. **Yarn**
   - This project uses Yarn as the dependency manager.
   - To install it globally run:

       ```bash
       npm install -g yarn
       ```

3. **ESLint**
   - ESLint is used for enforcing standard linting rules.
   - Install it via the IDE Extension or the [installation guide](https://eslint.org/)

4. **Prettier**
   - Prettier is used for enforcing standards for formatting code.
   - Install it via the IDE Extension or the [installation guide](https://prettier.io/)

### Setup Instructions

To set up the development environment, follow these steps:

1. Clone the repository and then cd into it
2. Run the following command to install all necessary dependencies:

    ```bash
    yarn install
    ```

3. You are now ready to work on the package!

## Additional Tips

- **Running Tests**
  - To run unit tests run
  
    ```bash
    yarn test
    ```

  - To run integration tests run

    ```bash
    yarn test:int
    ```

- **Formating and Linting**
  - To format code files, run

    ```bash
    yarn format
    ```

  - To lint code files, run

    ```bash
    yarn lint
    ```

- **Creating Distribution Artifacts**
  - To create distribution artifacts, run (output will be created in /dist):

    ```bash
    yarn build
    ```

- **Changing the Version**
  - To update the package version, use Poetry's versioning command:

    ```bash
    yarn version --new-version <new_version>
    ```

    Replace `<new_version>` with the desired version (e.g., `1.0.1`). This will update the `package.json` file automatically.

## File Structure

root/
├── src/
│   ├── chains/
|   |   │
│   |   |── graph_qa/
│   │   |   ├── hanaSparqlQaChain.ts   # HanaSparqlQAChain for Graph RAG
|   |   |   |── index.ts
│   │   └── index.ts
│   │
│   ├── embeddings/
│   │   ├── hanaInternalEmbeddings.ts  # Internal Embeddings provided by HANA
│   │   └── index.ts
│   │
│   ├── graphs/
│   │   ├── hanaRdfGraph.ts            # HanaRdfGraph for SPARQL Query Execution
│   │   └── index.ts
│   │
│   ├── vectorstores/
│   │   ├── hanaDb.ts                  # HanaDb Vectorstore
│   │   └── index.ts
│   │
│   ├── structured_query/
│   │   ├── hanaTranslator.ts          # HanaTranslator for Structured Queries
│   │   └── index.ts
│   │
|   |── index.ts                       # Export all components from the individual modules
│   └── hanaUtils.ts                   # Utility functions, constants, and types
│
├── tests/
│   ├── unit_tests/                    # Unit tests for individual components
│   └── integration_tests/             # Integration tests across modules
│
├── examples/
│   ├── chains/
│   ├── embeddings/
│   ├── graphs/
│   ├── vectorstores/
│   └── structured_query/
│                                     # Example implementations and usage for each module
│
├── .github/
│   └── workflows/                    # GitHub Actions for CI/CD
│
├── package.json                      # Project dependencies and scripts
├── yarn.lock                         # Locked dependency versions
└── README.md                         # Project documentation

## Usage Documenation

For usage instructions and examples, please refer to the [LangChain Documentation](https://docs.langchain.com/oss/javascript/langchain/overview).
