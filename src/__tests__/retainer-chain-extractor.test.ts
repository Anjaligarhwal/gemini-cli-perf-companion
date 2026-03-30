/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { HeapNode, RetainerChain } from '../types.js';
import type { RetainerEdge } from '../parse/edge-parser.js';
import {
  extractRetainerChains,
  extractRetainerChainsForLeaks,
  findNodesByConstructor,
  formatRetainerChainsForLLM,
} from '../analyze/retainer-chain-extractor.js';

// ── Test Helpers ──────────────────────────────────────────────────────

function makeNode(
  index: number,
  name: string,
  type: string = 'object',
  selfSize: number = 64,
): HeapNode {
  return {
    type,
    name,
    id: index * 2 + 1,
    selfSize,
    edgeCount: 0,
    traceNodeId: 0,
    detachedness: 0,
    nodeIndex: index,
  };
}

function buildReverse(
  entries: Array<{ from: number; to: number; edgeType: string; edgeName: string }>,
): Map<number, RetainerEdge[]> {
  const map = new Map<number, RetainerEdge[]>();
  for (const e of entries) {
    let list = map.get(e.to);
    if (!list) {
      list = [];
      map.set(e.to, list);
    }
    list.push({
      fromNodeIndex: e.from,
      edgeType: e.edgeType,
      edgeName: e.edgeName,
    });
  }
  return map;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('findNodesByConstructor', () => {
  const nodes: HeapNode[] = [
    makeNode(0, 'LeakyCache', 'object', 1024),
    makeNode(1, 'Map', 'object', 256),
    makeNode(2, 'LeakyCache', 'object', 2048),
    makeNode(3, 'LeakyCache', 'object', 512),
    makeNode(4, 'String', 'string', 32),
  ];

  it('should find nodes matching constructor name', () => {
    const indices = findNodesByConstructor(nodes, 'LeakyCache');
    expect(indices).toHaveLength(3);
  });

  it('should sort by selfSize descending', () => {
    const indices = findNodesByConstructor(nodes, 'LeakyCache');
    // Sizes: 2048 (idx 2), 1024 (idx 0), 512 (idx 3)
    expect(indices).toEqual([2, 0, 3]);
  });

  it('should respect the limit parameter', () => {
    const indices = findNodesByConstructor(nodes, 'LeakyCache', 2);
    expect(indices).toHaveLength(2);
    expect(indices).toEqual([2, 0]);
  });

  it('should return empty array for non-existent constructor', () => {
    const indices = findNodesByConstructor(nodes, 'NonExistent');
    expect(indices).toHaveLength(0);
  });

  it('should match by node type as well as name', () => {
    const indices = findNodesByConstructor(nodes, 'string');
    expect(indices).toHaveLength(1);
    expect(indices[0]).toBe(4);
  });
});

describe('extractRetainerChains', () => {
  /**
   * Graph topology for most tests:
   *
   *   [0: (GC roots)] --property: global--> [1: Window]
   *           |                                  |
   *           |                    property: emitter
   *           |                                  v
   *           |                          [2: EventEmitter]
   *           |                                  |
   *           |                      property: _cache
   *           |                                  v
   *           +---(element: [0])--------> [3: LeakyCache]  <-- target
   */

  const nodes: HeapNode[] = [
    makeNode(0, '(GC roots)', 'synthetic', 0),
    makeNode(1, 'Window', 'object', 128),
    makeNode(2, 'EventEmitter', 'object', 96),
    makeNode(3, 'LeakyCache', 'object', 2048),
  ];

  const reverseGraph = buildReverse([
    // LeakyCache (3) is retained by EventEmitter (2)
    { from: 2, to: 3, edgeType: 'property', edgeName: '_cache' },
    // LeakyCache (3) is also retained directly by GC roots (0)
    { from: 0, to: 3, edgeType: 'element', edgeName: '[0]' },
    // EventEmitter (2) is retained by Window (1)
    { from: 1, to: 2, edgeType: 'property', edgeName: 'emitter' },
    // Window (1) is retained by GC roots (0)
    { from: 0, to: 1, edgeType: 'property', edgeName: 'global' },
  ]);

  it('should find the shortest chain to a GC root', () => {
    const chains = extractRetainerChains(3, reverseGraph, nodes);

    expect(chains.length).toBeGreaterThanOrEqual(1);

    // Shortest path: LeakyCache ← (GC roots) — depth 2
    const shortest = chains[0];
    expect(shortest.depth).toBe(2);
    expect(shortest.nodes[0].name).toBe('LeakyCache');
    expect(shortest.nodes[1].name).toBe('(GC roots)');
  });

  it('should find multiple chains when multiple roots exist', () => {
    // Create a graph with two separate GC root paths
    const multiRootNodes: HeapNode[] = [
      makeNode(0, '(GC roots)', 'synthetic', 0),
      makeNode(1, '(Internalized strings)', 'synthetic', 0),
      makeNode(2, 'LeakyCache', 'object', 2048),
    ];

    const multiRootReverse = buildReverse([
      { from: 0, to: 2, edgeType: 'property', edgeName: 'ref1' },
      { from: 1, to: 2, edgeType: 'property', edgeName: 'ref2' },
    ]);

    const chains = extractRetainerChains(2, multiRootReverse, multiRootNodes, { maxChains: 5 });

    // Should find 2 chains — one to each GC root
    expect(chains.length).toBe(2);
  });

  it('should include correct edge types and names in the chain', () => {
    const chains = extractRetainerChains(3, reverseGraph, nodes, { maxChains: 5 });

    // Find the longer chain through EventEmitter
    const longChain = chains.find((c) => c.depth >= 3);
    if (longChain) {
      // Second node should be EventEmitter retained via "property: _cache"
      expect(longChain.nodes[1].edgeType).toBe('property');
      expect(longChain.nodes[1].edgeName).toBe('_cache');
    }
  });

  it('should respect maxDepth', () => {
    const chains = extractRetainerChains(3, reverseGraph, nodes, {
      maxDepth: 2,
      maxChains: 10,
    });

    // Only the direct path (depth 2) should be found
    for (const chain of chains) {
      expect(chain.depth).toBeLessThanOrEqual(2);
    }
  });

  it('should respect maxChains', () => {
    const chains = extractRetainerChains(3, reverseGraph, nodes, {
      maxChains: 1,
    });

    expect(chains.length).toBeLessThanOrEqual(1);
  });

  it('should handle target node with no retainers', () => {
    const isolatedReverse = new Map<number, RetainerEdge[]>();
    const chains = extractRetainerChains(3, isolatedReverse, nodes);

    expect(chains).toHaveLength(0);
  });

  it('should handle invalid target node index', () => {
    const chains = extractRetainerChains(999, reverseGraph, nodes);
    expect(chains).toHaveLength(0);
  });

  it('should handle cycles without infinite loop', () => {
    // Create a cycle: A → B → A
    const cyclicNodes: HeapNode[] = [
      makeNode(0, '(GC roots)', 'synthetic', 0),
      makeNode(1, 'A', 'object', 64),
      makeNode(2, 'B', 'object', 64),
    ];

    const cyclicReverse = buildReverse([
      { from: 2, to: 1, edgeType: 'property', edgeName: 'ref_b' },
      { from: 1, to: 2, edgeType: 'property', edgeName: 'ref_a' },
      { from: 0, to: 1, edgeType: 'property', edgeName: 'root_ref' },
    ]);

    // Should not hang — visited set prevents infinite loop
    const chains = extractRetainerChains(2, cyclicReverse, cyclicNodes);

    // Should find: B ← A ← (GC roots)
    expect(chains.length).toBeGreaterThanOrEqual(1);
    expect(chains[0].nodes[chains[0].nodes.length - 1].name).toBe('(GC roots)');
  });

  it('should compute totalRetainedSize correctly', () => {
    const chains = extractRetainerChains(3, reverseGraph, nodes);

    for (const chain of chains) {
      const expectedSize = chain.nodes.reduce((sum, n) => sum + n.selfSize, 0);
      expect(chain.totalRetainedSize).toBe(expectedSize);
    }
  });
});

describe('extractRetainerChainsForLeaks', () => {
  const nodes: HeapNode[] = [
    makeNode(0, '(GC roots)', 'synthetic', 0),
    makeNode(1, 'Window', 'object', 128),
    makeNode(2, 'LeakyCache', 'object', 2048),
    makeNode(3, 'LeakyBuffer', 'object', 4096),
  ];

  const reverseGraph = buildReverse([
    { from: 1, to: 2, edgeType: 'property', edgeName: 'cache' },
    { from: 1, to: 3, edgeType: 'property', edgeName: 'buffer' },
    { from: 0, to: 1, edgeType: 'property', edgeName: 'global' },
  ]);

  it('should extract chains for multiple constructors', () => {
    const result = extractRetainerChainsForLeaks(
      ['LeakyCache', 'LeakyBuffer'],
      nodes,
      reverseGraph,
    );

    expect(result.size).toBe(2);
    expect(result.has('LeakyCache')).toBe(true);
    expect(result.has('LeakyBuffer')).toBe(true);
  });

  it('should skip constructors with no matching nodes', () => {
    const result = extractRetainerChainsForLeaks(
      ['NonExistent'],
      nodes,
      reverseGraph,
    );

    expect(result.size).toBe(0);
  });
});

describe('formatRetainerChainsForLLM', () => {
  it('should produce readable markdown output', () => {
    const chainsMap = new Map<string, RetainerChain[]>();
    chainsMap.set('LeakyCache', [
      {
        depth: 3,
        totalRetainedSize: 2272,
        nodes: [
          { type: 'object', name: 'LeakyCache', edgeType: '(target)', edgeName: 'LeakyCache', selfSize: 2048 },
          { type: 'object', name: 'EventEmitter', edgeType: 'property', edgeName: '_cache', selfSize: 96 },
          { type: 'synthetic', name: '(GC roots)', edgeType: 'property', edgeName: 'global', selfSize: 128 },
        ],
      },
    ]);

    const output = formatRetainerChainsForLLM(chainsMap);

    expect(output).toContain('Retainer Chain Analysis');
    expect(output).toContain('LeakyCache');
    expect(output).toContain('EventEmitter');
    expect(output).toContain('(GC roots)');
    expect(output).toContain('property: _cache');
    expect(output).toContain('Suggested Actions');
  });

  it('should handle empty chains map', () => {
    const output = formatRetainerChainsForLLM(new Map());
    expect(output).toContain('No retainer chains found');
  });

  it('should format multiple constructors', () => {
    const chainsMap = new Map<string, RetainerChain[]>();
    chainsMap.set('CacheA', [
      {
        depth: 2,
        totalRetainedSize: 1024,
        nodes: [
          { type: 'object', name: 'CacheA', edgeType: '(target)', edgeName: 'CacheA', selfSize: 512 },
          { type: 'synthetic', name: '(GC roots)', edgeType: 'element', edgeName: '[0]', selfSize: 512 },
        ],
      },
    ]);
    chainsMap.set('CacheB', [
      {
        depth: 2,
        totalRetainedSize: 2048,
        nodes: [
          { type: 'object', name: 'CacheB', edgeType: '(target)', edgeName: 'CacheB', selfSize: 1024 },
          { type: 'synthetic', name: '(GC roots)', edgeType: 'element', edgeName: '[1]', selfSize: 1024 },
        ],
      },
    ]);

    const output = formatRetainerChainsForLLM(chainsMap);
    expect(output).toContain('CacheA');
    expect(output).toContain('CacheB');
  });
});
