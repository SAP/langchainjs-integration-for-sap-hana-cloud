import { jest } from '@jest/globals';
import { Store, NamedNode } from 'n3';
import { Connection } from '@sap/hana-client';
import { HanaRdfGraph } from '../../src/index.js';


describe('test getSchema return value', () => {
  it('should return a N3 Store instance not a string', async() => {
    // Mock the database connection
    const mockConnection = {} as Connection;

    // Create a minimal schema graph for testing
    const testSchema = new Store();
    testSchema.addQuad(
      new NamedNode('http://example.org/Person'),
      new NamedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      new NamedNode('http://www.w3.org/2000/01/rdf-schema#Class')
    );

    // Mock the methods on HanaRdfGraph to avoid DB calls
    const loadOntologyMock = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(HanaRdfGraph.prototype as any, 'loadOntologySchemaGraphFromQuery')
      .mockReturnValue(testSchema);

    const validateConstructQueryMock = jest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(HanaRdfGraph as any, 'validateConstructQuery')
      .mockImplementation(() => {});

    const graphOptions = {
      connection: mockConnection,
      autoExtractOntology: true,
    }

    // Create HanaRdfGraph instance
    const graph = new HanaRdfGraph(graphOptions);
    await graph.initialize(graphOptions);

    const schemaGraph = graph.getSchema();
    expect(schemaGraph).toBeInstanceOf(Store);

    // Restore mocks
    loadOntologyMock.mockRestore();
    validateConstructQueryMock.mockRestore();
  });
});
