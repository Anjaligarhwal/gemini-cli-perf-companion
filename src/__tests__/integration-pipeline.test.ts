/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: Full pipeline from parse → diff → retainer chains →
 * Perfetto trace → LLM analysis bridge.
 *
 * Uses in-memory V8-format snapshot data to test the entire pipeline
 * without requiring actual heap captures.
 */

import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseHeapSnapshotFull } from '../parse/heap-snapshot-parser.js';
import { threeSnapshotDiff, formatDiffForLLM } from '../analyze/three-snapshot-diff.js';
import { extractRetainerChainsForLeaks, formatRetainerChainsForLLM } from '../analyze/retainer-chain-extractor.js';
import { diffResultToTrace, heapSummaryToTrace, mergeTraces } from '../format/perfetto-formatter.js';
import { analyzeLeakDetection, analyzeHeapSummary } from '../bridge/llm-analysis-bridge.js';

// ─── Minimal V8 Snapshot Builder ─────────────────────────────────────

/**
 * Build a minimal valid V8 heap snapshot JSON string.
 *
 * V8 snapshot format: flat integer arrays indexed by meta field counts.
 * Node fields: [type, name, id, self_size, edge_count, trace_node_id, detachedness]
 * Edge fields: [type, name_or_index, to_node]
 */
function buildMinimalSnapshot(config: {
  nodes: Array<{
    type: number;
    name: number;
    id: number;
    selfSize: number;
    edgeCount: number;
  }>;
  edges: Array<{
    type: number;
    nameOrIndex: number;
    toNodeOffset: number; // offset into flat nodes array (nodeIndex * 7)
  }>;
  strings: string[];
}): string {
  const nodeFieldCount = 7;
  const flatNodes: number[] = [];
  for (const n of config.nodes) {
    flatNodes.push(n.type, n.name, n.id, n.selfSize, n.edgeCount, 0, 0);
  }

  const flatEdges: number[] = [];
  for (const e of config.edges) {
    flatEdges.push(e.type, e.nameOrIndex, e.toNodeOffset);
  }

  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
        node_types: [
          ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint'],
          'string', 'number', 'number', 'number', 'number', 'number',
        ],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [
          ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'],
          'string_or_number', 'node',
        ],
        trace_function_info_fields: [],
        trace_node_fields: [],
        sample_fields: [],
        location_fields: [],
      },
      node_count: config.nodes.length,
      edge_count: config.edges.length,
    },
    nodes: flatNodes,
    edges: flatEdges,
    strings: config.strings,
    trace_function_infos: [],
    trace_tree: [],
    samples: [],
    locations: [],
  });
}

// ─── Fixture Snapshots ───────────────────────────────────────────────

/**
 * String table shared across snapshots.
 *
 * Index:  0="(GC roots)"  1="LeakyCache"  2="_cache"  3="EventEmitter"
 *         4="global"  5="Object"  6="(system)"  7=""  8="property"
 */
const STRINGS = [
  '(GC roots)',     // 0
  'LeakyCache',     // 1
  '_cache',         // 2
  'EventEmitter',   // 3
  'global',         // 4
  'Object',         // 5
  '(system)',        // 6
  '',               // 7
  'property',       // 8
];

/** Node field count for offset calculation. */
const NFC = 7;

// Snapshot A: 5 LeakyCache, 1 synthetic root, 1 EventEmitter, 1 global object
function makeSnapshotA(): string {
  const nodes = [
    // Node 0: synthetic root "(GC roots)"
    { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 1 },
    // Node 1: object "global"
    { type: 3, name: 4, id: 2, selfSize: 64, edgeCount: 1 },
    // Node 2: object "EventEmitter"
    { type: 3, name: 3, id: 3, selfSize: 128, edgeCount: 1 },
    // Nodes 3-7: 5 × LeakyCache
    { type: 3, name: 1, id: 10, selfSize: 1024, edgeCount: 0 },
    { type: 3, name: 1, id: 11, selfSize: 1024, edgeCount: 0 },
    { type: 3, name: 1, id: 12, selfSize: 1024, edgeCount: 0 },
    { type: 3, name: 1, id: 13, selfSize: 1024, edgeCount: 0 },
    { type: 3, name: 1, id: 14, selfSize: 1024, edgeCount: 0 },
  ];
  const edges = [
    // root → global (property "global")
    { type: 2, nameOrIndex: 4, toNodeOffset: 1 * NFC },
    // global → EventEmitter (property "EventEmitter")
    { type: 2, nameOrIndex: 3, toNodeOffset: 2 * NFC },
    // EventEmitter → LeakyCache[0] (property "_cache")
    { type: 2, nameOrIndex: 2, toNodeOffset: 3 * NFC },
  ];
  return buildMinimalSnapshot({ nodes, edges, strings: STRINGS });
}

// Snapshot B: 10 LeakyCache (growth)
function makeSnapshotB(): string {
  const nodes = [
    { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 1 },
    { type: 3, name: 4, id: 2, selfSize: 64, edgeCount: 1 },
    { type: 3, name: 3, id: 3, selfSize: 128, edgeCount: 1 },
    // 10 × LeakyCache
    ...Array.from({ length: 10 }, (_, i) => ({
      type: 3, name: 1, id: 20 + i, selfSize: 1024, edgeCount: 0,
    })),
  ];
  const edges = [
    { type: 2, nameOrIndex: 4, toNodeOffset: 1 * NFC },
    { type: 2, nameOrIndex: 3, toNodeOffset: 2 * NFC },
    { type: 2, nameOrIndex: 2, toNodeOffset: 3 * NFC },
  ];
  return buildMinimalSnapshot({ nodes, edges, strings: STRINGS });
}

// Snapshot C: 20 LeakyCache (monotonic growth: 5 → 10 → 20)
function makeSnapshotC(): string {
  const nodes = [
    { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 1 },
    { type: 3, name: 4, id: 2, selfSize: 64, edgeCount: 1 },
    { type: 3, name: 3, id: 3, selfSize: 128, edgeCount: 1 },
    // 20 × LeakyCache
    ...Array.from({ length: 20 }, (_, i) => ({
      type: 3, name: 1, id: 30 + i, selfSize: 1024, edgeCount: 0,
    })),
  ];
  const edges = [
    { type: 2, nameOrIndex: 4, toNodeOffset: 1 * NFC },
    { type: 2, nameOrIndex: 3, toNodeOffset: 2 * NFC },
    { type: 2, nameOrIndex: 2, toNodeOffset: 3 * NFC },
  ];
  return buildMinimalSnapshot({ nodes, edges, strings: STRINGS });
}

// ─── Test Helpers ────────────────────────────────────────────────────

let testDir: string;

async function writeSnapshot(name: string, content: string): Promise<string> {
  const path = join(testDir, `${name}.heapsnapshot`);
  await writeFile(path, content, 'utf-8');
  return path;
}

// ─── Integration Tests ──────────────────────────────────────────────

describe('Integration: full analysis pipeline', () => {
  // Create and clean up temp directory per test suite.
  const setupDir = async () => {
    testDir = join(tmpdir(), `perf-companion-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  };

  const cleanDir = async () => {
    await rm(testDir, { recursive: true, force: true });
  };

  it('should parse → diff → extract chains → format for Perfetto + LLM', async () => {
    await setupDir();
    try {
      // ── Write fixture snapshots to disk ───────────────────────────
      const pathA = await writeSnapshot('snap-a', makeSnapshotA());
      const pathB = await writeSnapshot('snap-b', makeSnapshotB());
      const pathC = await writeSnapshot('snap-c', makeSnapshotC());

      // ── Phase 1: Parse all three snapshots ────────────────────────
      const parsedA = await parseHeapSnapshotFull(pathA);
      const parsedB = await parseHeapSnapshotFull(pathB);
      const parsedC = await parseHeapSnapshotFull(pathC);

      // Verify node counts match expectations.
      expect(parsedA.nodes.length).toBe(8);   // root + global + emitter + 5 LeakyCache
      expect(parsedB.nodes.length).toBe(13);  // root + global + emitter + 10 LeakyCache
      expect(parsedC.nodes.length).toBe(23);  // root + global + emitter + 20 LeakyCache

      // Verify summary computed correctly.
      expect(parsedC.summary.nodeCount).toBe(23);
      expect(parsedC.summary.edgeCount).toBe(3);
      expect(parsedC.summary.topConstructors.length).toBeGreaterThan(0);

      // ── Phase 2: 3-snapshot diff ──────────────────────────────────
      const diff = threeSnapshotDiff(
        parsedA.nodes,
        parsedB.nodes,
        parsedC.nodes,
        parsedC.reverseGraph,
      );

      // LeakyCache should be detected: 5 → 10 → 20 (monotonic growth).
      const leakyCandidate = diff.strongLeakCandidates.find(
        (c) => c.constructor === 'LeakyCache',
      );
      expect(leakyCandidate).toBeDefined();
      expect(leakyCandidate!.countBefore).toBe(5);
      expect(leakyCandidate!.countAfter).toBe(20);
      expect(leakyCandidate!.deltaCount).toBe(15);
      expect(leakyCandidate!.deltaSizeBytes).toBe(15 * 1024);

      // Summary should reflect the leak.
      expect(diff.summary.strongCandidateCount).toBeGreaterThan(0);
      expect(diff.summary.totalNewObjects).toBeGreaterThan(0);

      // ── Phase 3: Retainer chain extraction ────────────────────────
      const retainerChainsMap = extractRetainerChainsForLeaks(
        ['LeakyCache'],
        parsedC.nodes,
        parsedC.reverseGraph,
        { maxDepth: 10, maxChains: 5 },
      );

      expect(retainerChainsMap.size).toBeGreaterThan(0);

      const chains = retainerChainsMap.get('LeakyCache');
      expect(chains).toBeDefined();
      expect(chains!.length).toBeGreaterThan(0);

      // Chain should traverse: LeakyCache ← EventEmitter ← global ← (GC roots)
      const chain = chains![0];
      expect(chain.depth).toBeGreaterThanOrEqual(2);
      expect(chain.totalRetainedSize).toBeGreaterThan(0);

      // ── Phase 4: LLM formatting ──────────────────────────────────
      const llmDiff = formatDiffForLLM(diff, retainerChainsMap);
      expect(llmDiff).toContain('LeakyCache');
      expect(llmDiff).toContain('Memory Leak Analysis');
      expect(llmDiff).toContain('Strong Leak Candidates');

      const llmChains = formatRetainerChainsForLLM(retainerChainsMap);
      expect(llmChains).toContain('LeakyCache');
      expect(llmChains).toContain('Retainer Chain Analysis');

      // ── Phase 5: Perfetto trace generation ────────────────────────
      const now = Date.now() * 1000;
      const summaryTrace = heapSummaryToTrace(parsedC.summary, 'test', now);
      const diffTrace = diffResultToTrace(diff, {
        a: now,
        b: now + 1_000_000,
        c: now + 2_000_000,
      });

      expect(summaryTrace.traceEvents.length).toBeGreaterThan(0);
      expect(diffTrace.traceEvents.length).toBeGreaterThan(0);

      // Verify trace contains expected event types.
      const phases = new Set(diffTrace.traceEvents.map((e) => e.ph));
      expect(phases.has('M')).toBe(true);  // Metadata
      expect(phases.has('C')).toBe(true);  // Counter
      expect(phases.has('i')).toBe(true);  // Instant markers

      // Merge traces should deduplicate metadata.
      const merged = mergeTraces(summaryTrace, diffTrace);
      expect(merged.traceEvents.length).toBeLessThanOrEqual(
        summaryTrace.traceEvents.length + diffTrace.traceEvents.length,
      );

      // ── Phase 6: LLM analysis bridge ──────────────────────────────
      const analysis = analyzeLeakDetection(diff, retainerChainsMap, merged);
      expect(analysis.summary).toContain('strong candidates');
      expect(analysis.markdownReport).toContain('Memory Leak Detection');
      expect(analysis.llmContext).toContain('LeakyCache');
      expect(analysis.suggestions.length).toBeGreaterThan(0);
      expect(analysis.perfettoTrace).toBe(merged);

      // ── Phase 7: Heap summary analysis ────────────────────────────
      const heapAnalysis = analyzeHeapSummary(parsedC.summary, summaryTrace);
      expect(heapAnalysis.summary).toContain('nodes');
      expect(heapAnalysis.markdownReport).toContain('Heap Snapshot Summary');
      expect(heapAnalysis.llmContext).toContain('Heap Snapshot Analysis');
    } finally {
      await cleanDir();
    }
  });

  it('should handle empty snapshots gracefully', async () => {
    await setupDir();
    try {
      // Minimal snapshot: just a root node, no objects.
      const minimal = buildMinimalSnapshot({
        nodes: [{ type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 0 }],
        edges: [],
        strings: ['(GC roots)'],
      });

      const path = await writeSnapshot('minimal', minimal);
      const parsed = await parseHeapSnapshotFull(path);

      expect(parsed.nodes.length).toBe(1);
      expect(parsed.edges.length).toBe(0);
      expect(parsed.summary.totalSize).toBe(0);

      // Diff of identical empty snapshots should produce no candidates.
      const diff = threeSnapshotDiff(parsed.nodes, parsed.nodes, parsed.nodes);
      expect(diff.leakCandidates.length).toBe(0);
      expect(diff.strongLeakCandidates.length).toBe(0);
    } finally {
      await cleanDir();
    }
  });

  it('should detect non-monotonic growth as leak candidate but not strong', async () => {
    await setupDir();
    try {
      // A: 10 objects, B: 5 objects (decreased), C: 15 objects
      // This is NOT monotonic (A < B < C fails because B < A).
      const makeSnap = (count: number) => buildMinimalSnapshot({
        nodes: [
          { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 0 },
          ...Array.from({ length: count }, (_, i) => ({
            type: 3, name: 1, id: 100 + i, selfSize: 512, edgeCount: 0,
          })),
        ],
        edges: [],
        strings: STRINGS,
      });

      const pathA = await writeSnapshot('non-mono-a', makeSnap(10));
      const pathB = await writeSnapshot('non-mono-b', makeSnap(5));
      const pathC = await writeSnapshot('non-mono-c', makeSnap(15));

      const parsedA = await parseHeapSnapshotFull(pathA);
      const parsedB = await parseHeapSnapshotFull(pathB);
      const parsedC = await parseHeapSnapshotFull(pathC);

      const diff = threeSnapshotDiff(
        parsedA.nodes,
        parsedB.nodes,
        parsedC.nodes,
      );

      // C > A, so it should appear as a leak candidate.
      const candidate = diff.leakCandidates.find(
        (c) => c.constructor === 'LeakyCache',
      );
      expect(candidate).toBeDefined();
      expect(candidate!.deltaCount).toBe(5); // 15 - 10

      // But NOT monotonic (B=5 < A=10), so not a strong candidate.
      const strong = diff.strongLeakCandidates.find(
        (c) => c.constructor === 'LeakyCache',
      );
      expect(strong).toBeUndefined();
    } finally {
      await cleanDir();
    }
  });
});
