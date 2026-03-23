/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { HeapNode, HeapSnapshotMeta } from '../types.js';
import { parseEdges, buildReverseGraph } from '../parse/edge-parser.js';
import { PerfCompanionError } from '../errors.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const META: HeapSnapshotMeta = {
  nodeFields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
  nodeTypes: [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint']],
  edgeFields: ['type', 'name_or_index', 'to_node'],
  edgeTypes: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']],
  traceFunctionInfoFields: [],
  traceNodeFields: [],
  sampleFields: [],
  locationFields: [],
};

const NODE_FIELD_COUNT = META.nodeFields.length; // 7

function makeNode(index: number, edgeCount: number): HeapNode {
  return {
    type: 'object',
    name: `Node${index}`,
    id: index * 2 + 1,
    selfSize: 64,
    edgeCount,
    traceNodeId: 0,
    detachedness: 0,
    nodeIndex: index,
  };
}

// ── parseEdges tests ──────────────────────────────────────────────────

describe('parseEdges', () => {
  it('should parse a simple edge connecting two nodes', () => {
    const nodes = [
      makeNode(0, 1), // Node 0 has 1 edge
      makeNode(1, 0), // Node 1 has 0 edges
    ];

    // Edge: type=2 (property), name_or_index=0 (strings[0]="propName"), to_node=7 (node 1 = 1*7)
    const flatEdges = [2, 0, NODE_FIELD_COUNT];
    const strings = ['propName'];

    const edges = parseEdges(flatEdges, nodes, META, strings);

    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe('property');
    expect(edges[0].nameOrIndex).toBe('propName');
    expect(edges[0].fromNodeIndex).toBe(0);
    expect(edges[0].toNodeIndex).toBe(1);
  });

  it('should associate edges with correct source nodes', () => {
    const nodes = [
      makeNode(0, 2), // Node 0 has 2 edges
      makeNode(1, 1), // Node 1 has 1 edge
      makeNode(2, 0), // Node 2 has 0 edges
    ];

    // Node 0 → Node 1 (property), Node 0 → Node 2 (property)
    // Node 1 → Node 2 (element)
    const flatEdges = [
      2, 0, 1 * NODE_FIELD_COUNT,  // Node 0 → Node 1, property, "ref1"
      2, 1, 2 * NODE_FIELD_COUNT,  // Node 0 → Node 2, property, "ref2"
      1, 42, 2 * NODE_FIELD_COUNT, // Node 1 → Node 2, element, index 42
    ];
    const strings = ['ref1', 'ref2'];

    const edges = parseEdges(flatEdges, nodes, META, strings);

    expect(edges).toHaveLength(3);
    expect(edges[0].fromNodeIndex).toBe(0);
    expect(edges[1].fromNodeIndex).toBe(0);
    expect(edges[2].fromNodeIndex).toBe(1);
  });

  it('should resolve element edges as numeric indices', () => {
    const nodes = [makeNode(0, 1), makeNode(1, 0)];
    // type=1 (element), name_or_index=5, to_node=7
    const flatEdges = [1, 5, NODE_FIELD_COUNT];
    const strings: string[] = [];

    const edges = parseEdges(flatEdges, nodes, META, strings);

    expect(edges[0].type).toBe('element');
    expect(edges[0].nameOrIndex).toBe(5); // numeric index, not a string
  });

  it('should throw on missing edge fields in meta', () => {
    const badMeta: HeapSnapshotMeta = {
      ...META,
      edgeFields: ['type', 'something_else', 'to_node'], // missing 'name_or_index'
    };

    expect(() =>
      parseEdges([0, 0, 0], [makeNode(0, 1)], badMeta, []),
    ).toThrow(PerfCompanionError);
  });

  it('should throw on empty edge fields', () => {
    const badMeta: HeapSnapshotMeta = { ...META, edgeFields: [] };

    expect(() =>
      parseEdges([], [], badMeta, []),
    ).toThrow(PerfCompanionError);
  });

  it('should handle nodes with zero edges', () => {
    const nodes = [makeNode(0, 0), makeNode(1, 0)];
    const edges = parseEdges([], nodes, META, []);
    expect(edges).toHaveLength(0);
  });
});

// ── buildReverseGraph tests ───────────────────────────────────────────

describe('buildReverseGraph', () => {
  it('should build reverse adjacency from edges', () => {
    const edges = [
      { type: 'property', nameOrIndex: 'ref', fromNodeIndex: 0, toNodeIndex: 1 },
      { type: 'property', nameOrIndex: 'cache', fromNodeIndex: 1, toNodeIndex: 2 },
    ];

    const reverse = buildReverseGraph(edges);

    // Node 1 is retained by Node 0
    expect(reverse.get(1)).toHaveLength(1);
    expect(reverse.get(1)![0].fromNodeIndex).toBe(0);

    // Node 2 is retained by Node 1
    expect(reverse.get(2)).toHaveLength(1);
    expect(reverse.get(2)![0].fromNodeIndex).toBe(1);

    // Node 0 has no retainers
    expect(reverse.get(0)).toBeUndefined();
  });

  it('should filter out weak references', () => {
    const edges = [
      { type: 'property', nameOrIndex: 'strong', fromNodeIndex: 0, toNodeIndex: 1 },
      { type: 'weak', nameOrIndex: 'weakRef', fromNodeIndex: 2, toNodeIndex: 1 },
    ];

    const reverse = buildReverseGraph(edges);

    // Node 1 should only have 1 retainer (not the weak one)
    expect(reverse.get(1)).toHaveLength(1);
    expect(reverse.get(1)![0].fromNodeIndex).toBe(0);
  });

  it('should handle multiple retainers for the same node', () => {
    const edges = [
      { type: 'property', nameOrIndex: 'ref1', fromNodeIndex: 0, toNodeIndex: 2 },
      { type: 'property', nameOrIndex: 'ref2', fromNodeIndex: 1, toNodeIndex: 2 },
    ];

    const reverse = buildReverseGraph(edges);

    expect(reverse.get(2)).toHaveLength(2);
  });

  it('should format numeric edge names as bracket notation', () => {
    const edges = [
      { type: 'element', nameOrIndex: 42 as string | number, fromNodeIndex: 0, toNodeIndex: 1 },
    ];

    const reverse = buildReverseGraph(edges);
    expect(reverse.get(1)![0].edgeName).toBe('[42]');
  });

  it('should return empty map for empty edges', () => {
    const reverse = buildReverseGraph([]);
    expect(reverse.size).toBe(0);
  });
});
