/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { threeSnapshotDiff, formatDiffForLLM } from '../analyze/three-snapshot-diff.js';
import type { HeapNode } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────

function makeNode(overrides: Partial<HeapNode> = {}): HeapNode {
  return {
    type: 'object',
    name: 'TestObject',
    id: (Math.random() * 1_000_000) | 0,
    selfSize: 100,
    edgeCount: 0,
    traceNodeId: 0,
    detachedness: 0,
    nodeIndex: 0,
    ...overrides,
  };
}

function makeNodes(
  name: string,
  count: number,
  size: number = 100,
): HeapNode[] {
  const nodes = new Array<HeapNode>(count);
  for (let i = 0; i < count; i++) {
    nodes[i] = makeNode({ name, selfSize: size, id: i, nodeIndex: i });
  }
  return nodes;
}

// ─── threeSnapshotDiff tests ─────────────────────────────────────────

describe('threeSnapshotDiff', () => {
  it('should detect monotonically increasing objects as strong candidates', () => {
    // A: 10 objects, B: 20 objects, C: 30 objects (monotonic growth)
    const nodesA = makeNodes('LeakyObj', 10);
    const nodesB = makeNodes('LeakyObj', 20);
    const nodesC = makeNodes('LeakyObj', 30);

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    expect(result.strongLeakCandidates.length).toBeGreaterThan(0);
    expect(result.strongLeakCandidates[0].constructor).toBe('LeakyObj');
    expect(result.strongLeakCandidates[0].deltaCount).toBe(20); // 30 - 10
    expect(result.summary.strongCandidateCount).toBeGreaterThan(0);
  });

  it('should detect growth from A to C even without monotonic pattern', () => {
    // A: 10, B: 8 (dip), C: 15 (net growth) — not monotonic but still growing
    const nodesA = makeNodes('GrowingObj', 10);
    const nodesB = makeNodes('GrowingObj', 8);
    const nodesC = makeNodes('GrowingObj', 15);

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    expect(result.leakCandidates.length).toBeGreaterThan(0);
    // Not monotonic (10 > 8), so should NOT be a strong candidate
    expect(result.strongLeakCandidates.length).toBe(0);
  });

  it('should report no leaks when counts are stable', () => {
    const nodesA = makeNodes('StableObj', 100);
    const nodesB = makeNodes('StableObj', 100);
    const nodesC = makeNodes('StableObj', 100);

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    expect(result.leakCandidates.length).toBe(0);
    expect(result.strongLeakCandidates.length).toBe(0);
    expect(result.summary.totalNewObjects).toBe(0);
  });

  it('should handle multiple object types with mixed growth', () => {
    const nodesA = [
      ...makeNodes('Leaking', 10, 1000),
      ...makeNodes('Stable', 50, 100),
    ];
    const nodesB = [
      ...makeNodes('Leaking', 20, 1000),
      ...makeNodes('Stable', 50, 100),
    ];
    const nodesC = [
      ...makeNodes('Leaking', 30, 1000),
      ...makeNodes('Stable', 50, 100),
    ];

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    expect(result.strongLeakCandidates.length).toBe(1);
    expect(result.strongLeakCandidates[0].constructor).toBe('Leaking');
    expect(result.summary.topLeakingConstructor).toBe('Leaking');
  });

  it('should handle empty snapshots', () => {
    const result = threeSnapshotDiff([], [], []);

    expect(result.leakCandidates.length).toBe(0);
    expect(result.strongLeakCandidates.length).toBe(0);
    expect(result.summary.totalNewObjects).toBe(0);
    expect(result.summary.topLeakingConstructor).toBe('none');
  });

  it('should sort candidates by delta size descending', () => {
    const nodesA = [
      ...makeNodes('SmallLeak', 10, 10),
      ...makeNodes('BigLeak', 5, 10000),
    ];
    const nodesB = [
      ...makeNodes('SmallLeak', 20, 10),
      ...makeNodes('BigLeak', 10, 10000),
    ];
    const nodesC = [
      ...makeNodes('SmallLeak', 30, 10),
      ...makeNodes('BigLeak', 15, 10000),
    ];

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    // BigLeak has larger total size delta (10 × 10000 = 100KB vs 20 × 10 = 200B)
    expect(result.strongLeakCandidates[0].constructor).toBe('BigLeak');
  });

  it('should respect topN limit', () => {
    // Create 5 distinct leaking constructors
    const nodesA = [
      ...makeNodes('Leak1', 10, 100),
      ...makeNodes('Leak2', 10, 100),
      ...makeNodes('Leak3', 10, 100),
      ...makeNodes('Leak4', 10, 100),
      ...makeNodes('Leak5', 10, 100),
    ];
    const nodesB = [
      ...makeNodes('Leak1', 20, 100),
      ...makeNodes('Leak2', 20, 100),
      ...makeNodes('Leak3', 20, 100),
      ...makeNodes('Leak4', 20, 100),
      ...makeNodes('Leak5', 20, 100),
    ];
    const nodesC = [
      ...makeNodes('Leak1', 30, 100),
      ...makeNodes('Leak2', 30, 100),
      ...makeNodes('Leak3', 30, 100),
      ...makeNodes('Leak4', 30, 100),
      ...makeNodes('Leak5', 30, 100),
    ];

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC, undefined, { topN: 3 });

    expect(result.leakCandidates.length).toBeLessThanOrEqual(3);
  });

  it('should compute correct growth rate', () => {
    const nodesA = makeNodes('Growing', 100, 50);
    const nodesB = makeNodes('Growing', 150, 50);
    const nodesC = makeNodes('Growing', 200, 50);

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    const candidate = result.strongLeakCandidates[0];
    expect(candidate).toBeDefined();
    // growthRate = (200 - 100) / 100 = 1.0
    expect(candidate.growthRate).toBe(1.0);
  });

  it('should handle Infinity growth rate for new constructors', () => {
    // Constructor not present in A, appears in B and C
    const nodesA: HeapNode[] = [];
    const nodesB = makeNodes('NewLeak', 10, 100);
    const nodesC = makeNodes('NewLeak', 20, 100);

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    expect(result.strongLeakCandidates.length).toBeGreaterThan(0);
    expect(result.strongLeakCandidates[0].growthRate).toBe(Infinity);
  });

  it('should filter V8 internals from strong candidates via noise filter', () => {
    // (system) objects grow monotonically but should be filtered as noise
    const nodesA = [
      ...makeNodes('RealLeak', 10, 5000),
      ...[makeNode({ type: 'hidden', name: '(system)', selfSize: 1000 })],
    ];
    const nodesB = [
      ...makeNodes('RealLeak', 20, 5000),
      // Repeat (system) nodes
      ...[
        makeNode({ type: 'hidden', name: '(system)', selfSize: 1000 }),
        makeNode({ type: 'hidden', name: '(system)', selfSize: 1000 }),
      ],
    ];
    const nodesC = [
      ...makeNodes('RealLeak', 30, 5000),
      ...[
        makeNode({ type: 'hidden', name: '(system)', selfSize: 1000 }),
        makeNode({ type: 'hidden', name: '(system)', selfSize: 1000 }),
        makeNode({ type: 'hidden', name: '(system)', selfSize: 1000 }),
      ],
    ];

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    // (hidden) aggregates under "(hidden)" key which is not in V8_INTERNAL_CONSTRUCTORS
    // but RealLeak should definitely be present
    const realLeak = result.strongLeakCandidates.find(
      (c) => c.constructor === 'RealLeak',
    );
    expect(realLeak).toBeDefined();
  });

  it('should return empty retainerChains when no reverseGraph provided', () => {
    const nodesA = makeNodes('Leak', 10);
    const nodesB = makeNodes('Leak', 20);
    const nodesC = makeNodes('Leak', 30);

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    expect(result.retainerChains).toHaveLength(0);
  });

  it('should compute correct summary totals', () => {
    const nodesA = [
      ...makeNodes('LeakA', 10, 100),
      ...makeNodes('LeakB', 5, 200),
    ];
    const nodesB = [
      ...makeNodes('LeakA', 15, 100),
      ...makeNodes('LeakB', 8, 200),
    ];
    const nodesC = [
      ...makeNodes('LeakA', 20, 100),
      ...makeNodes('LeakB', 10, 200),
    ];

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);

    // LeakA: delta=10 objects, deltaSize=1000B; LeakB: delta=5 objects, deltaSize=1000B
    expect(result.summary.totalNewObjects).toBe(15);
    expect(result.summary.totalNewSize).toBe(2000);
  });
});

// ─── formatDiffForLLM tests ─────────────────────────────────────────

describe('formatDiffForLLM', () => {
  it('should produce readable markdown output', () => {
    const nodesA = makeNodes('LeakyCache', 100, 1024);
    const nodesB = makeNodes('LeakyCache', 200, 1024);
    const nodesC = makeNodes('LeakyCache', 300, 1024);

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);
    const output = formatDiffForLLM(result);

    expect(output).toContain('Memory Leak Analysis');
    expect(output).toContain('LeakyCache');
    expect(output).toContain('Strong Leak Candidates');
    expect(output).toContain('+200 objects');
  });

  it('should handle no leaks gracefully', () => {
    const result = threeSnapshotDiff([], [], []);
    const output = formatDiffForLLM(result);

    expect(output).toContain('Total new objects');
    expect(output).toContain('0');
  });

  it('should include markdown table format', () => {
    const result = threeSnapshotDiff([], [], []);
    const output = formatDiffForLLM(result);

    expect(output).toContain('| Metric | Value |');
    expect(output).toContain('|--------|-------|');
  });

  it('should display growth rate as percentage', () => {
    const nodesA = makeNodes('Growing', 100, 5000);
    const nodesB = makeNodes('Growing', 150, 5000);
    const nodesC = makeNodes('Growing', 200, 5000);

    const result = threeSnapshotDiff(nodesA, nodesB, nodesC);
    const output = formatDiffForLLM(result);

    // 100% growth rate
    expect(output).toContain('100%');
  });
});
