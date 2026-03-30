/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests: Full pipeline from parse → diff → retainer chains →
 * Perfetto trace → LLM analysis bridge.
 *
 * Tests verify that modules compose correctly end-to-end, exercising real
 * data flows rather than mocked boundaries.  Snapshot fixtures are built
 * programmatically to simulate specific leak patterns observed in real
 * Node.js applications (event listener accumulation, closure retention,
 * cache growth, timer leaks).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseHeapSnapshotFull } from '../parse/heap-snapshot-parser.js';
import { parseHeapSnapshotStreaming } from '../parse/streaming-snapshot-parser.js';
import { threeSnapshotDiff, formatDiffForLLM } from '../analyze/three-snapshot-diff.js';
import {
  extractRetainerChainsForLeaks,
} from '../analyze/retainer-chain-extractor.js';
import {
  diffResultToTrace,
  heapSummaryToTrace,
  mergeTraces,
} from '../format/perfetto-formatter.js';
import {
  analyzeLeakDetection,
  analyzeHeapSummary,
  mergeAnalysisResults,
} from '../bridge/llm-analysis-bridge.js';
import {
  validateConnectionTarget,
  validateCdpMethod,
  validateOutputPath,
  scanForSensitiveData,
} from '../security/connection-validator.js';
import { PerfCompanionError } from '../errors.js';

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
    detachedness?: number;
  }>;
  edges: Array<{
    type: number;
    nameOrIndex: number;
    toNodeOffset: number;
  }>;
  strings: string[];
}): string {
  const flatNodes: number[] = [];
  for (const n of config.nodes) {
    flatNodes.push(n.type, n.name, n.id, n.selfSize, n.edgeCount, 0, n.detachedness ?? 0);
  }

  const flatEdges: number[] = [];
  for (const e of config.edges) {
    flatEdges.push(e.type, e.nameOrIndex, e.toNodeOffset);
  }

  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: [
          'type', 'name', 'id', 'self_size', 'edge_count',
          'trace_node_id', 'detachedness',
        ],
        node_types: [
          [
            'hidden', 'array', 'string', 'object', 'code', 'closure',
            'regexp', 'number', 'native', 'synthetic', 'concatenated string',
            'sliced string', 'symbol', 'bigint',
          ],
          'string', 'number', 'number', 'number', 'number', 'number',
        ],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [
          [
            'context', 'element', 'property', 'internal', 'hidden',
            'shortcut', 'weak',
          ],
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

// ─── Fixture Constants ──────────────────────────────────────────────

/** Node field count for offset calculation. */
const NFC = 7;

/**
 * String table shared across leak-detection fixtures.
 *
 * Index: 0="(GC roots)"  1="LeakyCache"  2="_cache"  3="EventEmitter"
 *        4="global"  5="Object"  6="(system)"  7=""  8="property"
 *        9="RequestContext"  10="sessions"  11="SessionStore"
 *        12="closureRef"  13="Timer"  14="callback"
 */
const STRINGS = [
  '(GC roots)',       // 0
  'LeakyCache',       // 1
  '_cache',           // 2
  'EventEmitter',     // 3
  'global',           // 4
  'Object',           // 5
  '(system)',          // 6
  '',                 // 7
  'property',         // 8
  'RequestContext',    // 9
  'sessions',         // 10
  'SessionStore',     // 11
  'closureRef',       // 12
  'Timer',            // 13
  'callback',         // 14
];

// ─── Temp Directory ─────────────────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `perf-integration-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeSnapshot(name: string, content: string): Promise<string> {
  const path = join(testDir, `${name}.heapsnapshot`);
  await writeFile(path, content, 'utf-8');
  return path;
}

// ─── Snapshot Factories ─────────────────────────────────────────────

/**
 * Factory: single-constructor leak pattern (LeakyCache).
 * Simulates a cache that grows without eviction.
 */
function makeLeakSnapshot(leakCount: number): string {
  const nodes = [
    { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 1 },
    { type: 3, name: 4, id: 2, selfSize: 64, edgeCount: 1 },
    { type: 3, name: 3, id: 3, selfSize: 128, edgeCount: 1 },
    ...Array.from({ length: leakCount }, (_, i) => ({
      type: 3, name: 1, id: 100 + i, selfSize: 1024, edgeCount: 0,
    })),
  ];
  const edges = [
    { type: 2, nameOrIndex: 4, toNodeOffset: 1 * NFC },
    { type: 2, nameOrIndex: 3, toNodeOffset: 2 * NFC },
    { type: 2, nameOrIndex: 2, toNodeOffset: 3 * NFC },
  ];
  return buildMinimalSnapshot({ nodes, edges, strings: STRINGS });
}

/**
 * Factory: multi-constructor leak pattern.
 * Both LeakyCache and RequestContext grow simultaneously.
 */
function makeMultiLeakSnapshot(cacheCount: number, ctxCount: number): string {
  const nodes = [
    { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 1 },
    { type: 3, name: 4, id: 2, selfSize: 64, edgeCount: 2 },
    { type: 3, name: 11, id: 3, selfSize: 256, edgeCount: 1 },
    ...Array.from({ length: cacheCount }, (_, i) => ({
      type: 3, name: 1, id: 200 + i, selfSize: 1024, edgeCount: 0,
    })),
    ...Array.from({ length: ctxCount }, (_, i) => ({
      type: 3, name: 9, id: 500 + i, selfSize: 2048, edgeCount: 0,
    })),
  ];
  const edges = [
    { type: 2, nameOrIndex: 4, toNodeOffset: 1 * NFC },
    { type: 2, nameOrIndex: 2, toNodeOffset: (3) * NFC },
    { type: 2, nameOrIndex: 10, toNodeOffset: (3 + cacheCount) * NFC },
  ];
  return buildMinimalSnapshot({ nodes, edges, strings: STRINGS });
}

/**
 * Factory: closure retention pattern.
 * Closures retain references to outer scope variables.
 */
function makeClosureLeakSnapshot(closureCount: number): string {
  const nodes = [
    { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 1 },
    { type: 3, name: 4, id: 2, selfSize: 64, edgeCount: 1 },
    ...Array.from({ length: closureCount }, (_, i) => ({
      type: 5, name: 12, id: 300 + i, selfSize: 512, edgeCount: 0,
    })),
  ];
  const edges = [
    { type: 2, nameOrIndex: 4, toNodeOffset: 1 * NFC },
    { type: 2, nameOrIndex: 12, toNodeOffset: 2 * NFC },
  ];
  return buildMinimalSnapshot({ nodes, edges, strings: STRINGS });
}

/**
 * Factory: detached DOM node pattern.
 */
function makeDetachedDomSnapshot(detachedCount: number): string {
  const nodes = [
    { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 0 },
    ...Array.from({ length: detachedCount }, (_, i) => ({
      type: 8, name: 5, id: 400 + i, selfSize: 256,
      edgeCount: 0, detachedness: 1,
    })),
  ];
  return buildMinimalSnapshot({
    nodes,
    edges: [],
    strings: STRINGS,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Integration: full analysis pipeline', () => {
  it('should parse → diff → extract chains → format for Perfetto + LLM', async () => {
    const pathA = await writeSnapshot('pipe-a', makeLeakSnapshot(5));
    const pathB = await writeSnapshot('pipe-b', makeLeakSnapshot(10));
    const pathC = await writeSnapshot('pipe-c', makeLeakSnapshot(20));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    expect(parsedA.nodes.length).toBe(8);
    expect(parsedB.nodes.length).toBe(13);
    expect(parsedC.nodes.length).toBe(23);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
      parsedC.reverseGraph,
    );

    const leaky = diff.strongLeakCandidates.find(
      (c) => c.constructor === 'LeakyCache',
    );
    expect(leaky).toBeDefined();
    expect(leaky!.countBefore).toBe(5);
    expect(leaky!.countAfter).toBe(20);
    expect(leaky!.deltaSizeBytes).toBe(15 * 1024);

    const retainerChainsMap = extractRetainerChainsForLeaks(
      ['LeakyCache'],
      parsedC.nodes,
      parsedC.reverseGraph,
      { maxDepth: 10, maxChains: 5 },
    );
    expect(retainerChainsMap.get('LeakyCache')!.length).toBeGreaterThan(0);

    const llmDiff = formatDiffForLLM(diff, retainerChainsMap);
    expect(llmDiff).toContain('LeakyCache');
    expect(llmDiff).toContain('Strong Leak Candidates');

    const now = Date.now() * 1000;
    const summaryTrace = heapSummaryToTrace(parsedC.summary, 'test', now);
    const diffTrace = diffResultToTrace(diff, {
      a: now, b: now + 1_000_000, c: now + 2_000_000,
    });

    expect(summaryTrace.traceEvents.length).toBeGreaterThan(0);
    expect(diffTrace.traceEvents.length).toBeGreaterThan(0);

    const merged = mergeTraces(summaryTrace, diffTrace);
    const analysis = analyzeLeakDetection(diff, retainerChainsMap, merged);

    expect(analysis.suggestions.length).toBeGreaterThan(0);
    expect(analysis.perfettoTrace).toBe(merged);
  });

  it('should handle empty snapshots gracefully', async () => {
    const minimal = buildMinimalSnapshot({
      nodes: [{ type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 0 }],
      edges: [],
      strings: ['(GC roots)'],
    });

    const path = await writeSnapshot('minimal', minimal);
    const parsed = await parseHeapSnapshotFull(path);

    expect(parsed.nodes.length).toBe(1);
    expect(parsed.summary.totalSize).toBe(0);

    const diff = threeSnapshotDiff(parsed.nodes, parsed.nodes, parsed.nodes);
    expect(diff.leakCandidates.length).toBe(0);
    expect(diff.strongLeakCandidates.length).toBe(0);
  });

  it('should detect non-monotonic growth as candidate but not strong', async () => {
    const pathA = await writeSnapshot('nm-a', makeLeakSnapshot(10));
    const pathB = await writeSnapshot('nm-b', makeLeakSnapshot(5));
    const pathC = await writeSnapshot('nm-c', makeLeakSnapshot(15));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
    );

    const candidate = diff.leakCandidates.find(
      (c) => c.constructor === 'LeakyCache',
    );
    expect(candidate).toBeDefined();
    expect(candidate!.deltaCount).toBe(5);

    const strong = diff.strongLeakCandidates.find(
      (c) => c.constructor === 'LeakyCache',
    );
    expect(strong).toBeUndefined();
  });
});

// ─── Streaming Parser Integration ───────────────────────────────────

describe('Integration: streaming parser to diff pipeline', () => {
  it('should produce identical diff results via streaming and batch parsers', async () => {
    const pathA = await writeSnapshot('stream-a', makeLeakSnapshot(5));
    const pathB = await writeSnapshot('stream-b', makeLeakSnapshot(10));
    const pathC = await writeSnapshot('stream-c', makeLeakSnapshot(20));

    const batchA = await parseHeapSnapshotFull(pathA);
    const batchC = await parseHeapSnapshotFull(pathC);

    const streamA = await parseHeapSnapshotStreaming(pathA);
    const streamB = await parseHeapSnapshotStreaming(pathB);
    const streamC = await parseHeapSnapshotStreaming(pathC);

    const batchDiff = threeSnapshotDiff(
      batchA.nodes, (await parseHeapSnapshotFull(pathB)).nodes, batchC.nodes,
      batchC.reverseGraph,
    );
    const streamDiff = threeSnapshotDiff(
      streamA.nodes, streamB.nodes, streamC.nodes,
      streamC.reverseGraph,
    );

    expect(streamDiff.strongLeakCandidates.length).toBe(
      batchDiff.strongLeakCandidates.length,
    );
    expect(streamDiff.summary.totalNewObjects).toBe(
      batchDiff.summary.totalNewObjects,
    );
    expect(streamDiff.summary.totalNewSize).toBe(
      batchDiff.summary.totalNewSize,
    );
  });

  it('should stream-parse with tiny chunks and still produce valid diff', async () => {
    const pathA = await writeSnapshot('tiny-a', makeLeakSnapshot(3));
    const pathB = await writeSnapshot('tiny-b', makeLeakSnapshot(6));
    const pathC = await writeSnapshot('tiny-c', makeLeakSnapshot(12));

    const parsedA = await parseHeapSnapshotStreaming(pathA, { chunkSize: 32 });
    const parsedB = await parseHeapSnapshotStreaming(pathB, { chunkSize: 32 });
    const parsedC = await parseHeapSnapshotStreaming(pathC, { chunkSize: 32 });

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
      parsedC.reverseGraph,
    );

    const leaky = diff.strongLeakCandidates.find(
      (c) => c.constructor === 'LeakyCache',
    );
    expect(leaky).toBeDefined();
    expect(leaky!.deltaCount).toBe(9);
  });
});

// ─── Multi-Constructor Leak Detection ───────────────────────────────

describe('Integration: multi-constructor leak detection', () => {
  it('should detect multiple independent leak sources', async () => {
    const pathA = await writeSnapshot('multi-a', makeMultiLeakSnapshot(2, 3));
    const pathB = await writeSnapshot('multi-b', makeMultiLeakSnapshot(5, 8));
    const pathC = await writeSnapshot('multi-c', makeMultiLeakSnapshot(10, 15));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
      parsedC.reverseGraph,
    );

    const cache = diff.strongLeakCandidates.find(
      (c) => c.constructor === 'LeakyCache',
    );
    const ctx = diff.strongLeakCandidates.find(
      (c) => c.constructor === 'RequestContext',
    );

    expect(cache).toBeDefined();
    expect(ctx).toBeDefined();
    expect(cache!.deltaCount).toBe(8);
    expect(ctx!.deltaCount).toBe(12);
  });

  it('should rank leaks by size delta in multi-constructor scenario', async () => {
    const pathA = await writeSnapshot('rank-a', makeMultiLeakSnapshot(2, 3));
    const pathB = await writeSnapshot('rank-b', makeMultiLeakSnapshot(5, 8));
    const pathC = await writeSnapshot('rank-c', makeMultiLeakSnapshot(10, 15));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
    );

    // RequestContext has 2048 bytes per instance × 12 delta = 24576
    // LeakyCache has 1024 bytes per instance × 8 delta = 8192
    // RequestContext should be ranked higher.
    const names = diff.strongLeakCandidates.map((c) => c.constructor);
    const ctxIdx = names.indexOf('RequestContext');
    const cacheIdx = names.indexOf('LeakyCache');
    expect(ctxIdx).toBeLessThan(cacheIdx);
  });
});

// ─── Closure Leak Pattern ───────────────────────────────────────────

describe('Integration: closure retention detection', () => {
  it('should detect closure leak pattern with monotonic growth', async () => {
    const pathA = await writeSnapshot('cls-a', makeClosureLeakSnapshot(4));
    const pathB = await writeSnapshot('cls-b', makeClosureLeakSnapshot(10));
    const pathC = await writeSnapshot('cls-c', makeClosureLeakSnapshot(20));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
    );

    // Closures use node type 5 = 'closure', grouped by name 'closureRef'.
    const closureLeak = diff.strongLeakCandidates.find(
      (c) => c.constructor === 'closureRef',
    );
    expect(closureLeak).toBeDefined();
    expect(closureLeak!.deltaCount).toBe(16);
  });
});

// ─── Detached DOM Detection ─────────────────────────────────────────

describe('Integration: detached DOM detection through summary', () => {
  it('should detect detached DOM nodes via heap summary', async () => {
    const path = await writeSnapshot(
      'detached',
      makeDetachedDomSnapshot(5),
    );

    const parsed = await parseHeapSnapshotFull(path);

    expect(parsed.summary.detachedDomNodes).toBe(5);

    const analysis = analyzeHeapSummary(parsed.summary);
    expect(analysis.suggestions.some(
      (s) => s.includes('detached DOM'),
    )).toBe(true);
  });
});

// ─── LLM Output Constraints ────────────────────────────────────────

describe('Integration: LLM output size and format', () => {
  it('should produce llmContext under 4KB for agent context budget', async () => {
    const pathA = await writeSnapshot('llm-a', makeLeakSnapshot(5));
    const pathB = await writeSnapshot('llm-b', makeLeakSnapshot(10));
    const pathC = await writeSnapshot('llm-c', makeLeakSnapshot(20));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
      parsedC.reverseGraph,
    );

    const analysis = analyzeLeakDetection(diff);

    // ToolResult.llmContent budget: 4KB max.
    expect(analysis.llmContext.length).toBeLessThan(4096);
    expect(analysis.summary.length).toBeLessThan(200);
  });

  it('should produce valid markdown in leak report', async () => {
    const pathA = await writeSnapshot('md-a', makeMultiLeakSnapshot(2, 3));
    const pathB = await writeSnapshot('md-b', makeMultiLeakSnapshot(5, 8));
    const pathC = await writeSnapshot('md-c', makeMultiLeakSnapshot(10, 15));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
    );

    const analysis = analyzeLeakDetection(diff);

    // Markdown structure checks.
    expect(analysis.markdownReport).toContain('## Memory Leak Detection');
    expect(analysis.markdownReport).toContain('| Constructor |');
    expect(analysis.markdownReport).toContain('Strong Leak Candidates');
  });
});

// ─── Perfetto Trace Correctness ─────────────────────────────────────

describe('Integration: Perfetto trace generation', () => {
  it('should generate valid Chrome Trace Event JSON with all required phases', async () => {
    const pathA = await writeSnapshot('pf-a', makeLeakSnapshot(5));
    const pathB = await writeSnapshot('pf-b', makeLeakSnapshot(10));
    const pathC = await writeSnapshot('pf-c', makeLeakSnapshot(20));

    const parsedC = await parseHeapSnapshotFull(pathC);
    const diff = threeSnapshotDiff(
      (await parseHeapSnapshotFull(pathA)).nodes,
      (await parseHeapSnapshotFull(pathB)).nodes,
      parsedC.nodes,
      parsedC.reverseGraph,
    );

    const now = Date.now() * 1000;
    const summaryTrace = heapSummaryToTrace(parsedC.summary, 'snapshot-c', now);
    const diffTrace = diffResultToTrace(diff, {
      a: now, b: now + 1_000_000, c: now + 2_000_000,
    });
    const merged = mergeTraces(summaryTrace, diffTrace);

    // Validate structure.
    expect(merged.traceEvents.length).toBeGreaterThan(0);

    // Every event must have required fields.
    for (const event of merged.traceEvents) {
      expect(event).toHaveProperty('name');
      expect(event).toHaveProperty('ph');
      expect(event).toHaveProperty('ts');
      expect(event).toHaveProperty('pid');
      expect(event).toHaveProperty('tid');
    }

    // Must have metadata, counter, and instant events.
    const phases = new Set(merged.traceEvents.map((e) => e.ph));
    expect(phases.has('M')).toBe(true);
    expect(phases.has('C')).toBe(true);
    expect(phases.has('i')).toBe(true);

    // Counter events must have numeric args.
    const counterEvents = merged.traceEvents.filter((e) => e.ph === 'C');
    for (const ce of counterEvents) {
      expect(ce.args).toBeDefined();
      const values = Object.values(ce.args!);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) {
        expect(typeof v).toBe('number');
      }
    }
  });

  it('should produce serializable JSON (no circular references)', async () => {
    const path = await writeSnapshot('json-safe', makeLeakSnapshot(5));
    const parsed = await parseHeapSnapshotFull(path);

    const trace = heapSummaryToTrace(parsed.summary, 'test', Date.now() * 1000);

    // Must roundtrip through JSON.stringify/parse without error.
    const serialized = JSON.stringify(trace);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.traceEvents.length).toBe(trace.traceEvents.length);
  });
});

// ─── Merged Analysis ────────────────────────────────────────────────

describe('Integration: merged analysis results', () => {
  it('should merge heap summary and leak detection into combined report', async () => {
    const pathA = await writeSnapshot('merge-a', makeLeakSnapshot(5));
    const pathB = await writeSnapshot('merge-b', makeLeakSnapshot(10));
    const pathC = await writeSnapshot('merge-c', makeLeakSnapshot(20));

    const parsedC = await parseHeapSnapshotFull(pathC);
    const diff = threeSnapshotDiff(
      (await parseHeapSnapshotFull(pathA)).nodes,
      (await parseHeapSnapshotFull(pathB)).nodes,
      parsedC.nodes,
    );

    const heapResult = analyzeHeapSummary(parsedC.summary);
    const leakResult = analyzeLeakDetection(diff);
    const combined = mergeAnalysisResults(heapResult, leakResult);

    // Combined summary should contain both parts.
    expect(combined.summary).toContain('Heap snapshot');
    expect(combined.summary).toContain('Leak detection');

    // Combined suggestions include both.
    expect(combined.suggestions.length).toBeGreaterThanOrEqual(
      leakResult.suggestions.length,
    );

    // Markdown report separated by divider.
    expect(combined.markdownReport).toContain('---');
  });
});

// ─── Security Integration ───────────────────────────────────────────

describe('Integration: security model with pipeline', () => {
  it('should validate output paths before writing snapshots', async () => {
    // Safe path in test temp directory.
    const safePath = join(testDir, 'safe-output.heapsnapshot');
    expect(() => validateOutputPath(safePath, [testDir])).not.toThrow();

    // Traversal attempt.
    const unsafePath = join(testDir, '..', '..', 'etc', 'passwd');
    expect(() => validateOutputPath(unsafePath, [testDir])).toThrow(
      PerfCompanionError,
    );
  });

  it('should validate CDP methods before profiling calls', () => {
    // Normal profiling workflow methods.
    expect(() => validateCdpMethod('HeapProfiler.enable')).not.toThrow();
    expect(() => validateCdpMethod('HeapProfiler.takeHeapSnapshot')).not.toThrow();
    expect(() => validateCdpMethod('HeapProfiler.collectGarbage')).not.toThrow();
    expect(() => validateCdpMethod('HeapProfiler.disable')).not.toThrow();

    // Blocked: code execution.
    expect(() => validateCdpMethod('Runtime.evaluate')).toThrow();
  });

  it('should validate connection targets before CDP connections', () => {
    expect(() => validateConnectionTarget('127.0.0.1', 9229)).not.toThrow();
    expect(() => validateConnectionTarget('192.168.1.1', 9229)).toThrow();
    expect(() => validateConnectionTarget('127.0.0.1', 22)).toThrow();
  });

  it('should scan parsed snapshot strings for sensitive data', async () => {
    // Build snapshot with sensitive data in string table.
    const sensitiveSnapshot = buildMinimalSnapshot({
      nodes: [
        { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 0 },
      ],
      edges: [],
      strings: [
        '(GC roots)',
        'api_key=sk-1234567890abcdef',
        'Bearer eyJhbGciOiJIUzI1NiJ9.test',
        'normal_string_without_secrets',
      ],
    });

    const path = await writeSnapshot('sensitive', sensitiveSnapshot);
    const parsed = await parseHeapSnapshotFull(path);

    const report = scanForSensitiveData(parsed.strings);
    expect(report.hasSensitiveData).toBe(true);
    expect(report.flaggedCount).toBe(2);
  });
});

// ─── Growth Rate Edge Cases ─────────────────────────────────────────

describe('Integration: growth rate edge cases', () => {
  it('should handle objects appearing in B and C but not in A (Infinity growth)', async () => {
    // A: no LeakyCache, B: 5, C: 10 → growth rate = Infinity.
    const snapshotNoLeak = buildMinimalSnapshot({
      nodes: [
        { type: 9, name: 0, id: 1, selfSize: 0, edgeCount: 0 },
        { type: 3, name: 4, id: 2, selfSize: 64, edgeCount: 0 },
      ],
      edges: [],
      strings: STRINGS,
    });

    const pathA = await writeSnapshot('inf-a', snapshotNoLeak);
    const pathB = await writeSnapshot('inf-b', makeLeakSnapshot(5));
    const pathC = await writeSnapshot('inf-c', makeLeakSnapshot(10));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
    );

    const leaky = diff.strongLeakCandidates.find(
      (c) => c.constructor === 'LeakyCache',
    );
    expect(leaky).toBeDefined();
    expect(leaky!.growthRate).toBe(Infinity);
    expect(leaky!.countBefore).toBe(0);
    expect(leaky!.countAfter).toBe(10);
  });

  it('should exclude shrinking constructors from leak candidates', async () => {
    // A: 20, B: 15, C: 10 → shrinking, not a leak.
    const pathA = await writeSnapshot('shrink-a', makeLeakSnapshot(20));
    const pathB = await writeSnapshot('shrink-b', makeLeakSnapshot(15));
    const pathC = await writeSnapshot('shrink-c', makeLeakSnapshot(10));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
    );

    const leaky = diff.leakCandidates.find(
      (c) => c.constructor === 'LeakyCache',
    );
    expect(leaky).toBeUndefined();
  });

  it('should handle stable allocation (no growth) as non-leak', async () => {
    const pathA = await writeSnapshot('stable-a', makeLeakSnapshot(10));
    const pathB = await writeSnapshot('stable-b', makeLeakSnapshot(10));
    const pathC = await writeSnapshot('stable-c', makeLeakSnapshot(10));

    const parsedA = await parseHeapSnapshotFull(pathA);
    const parsedB = await parseHeapSnapshotFull(pathB);
    const parsedC = await parseHeapSnapshotFull(pathC);

    const diff = threeSnapshotDiff(
      parsedA.nodes, parsedB.nodes, parsedC.nodes,
    );

    const leaky = diff.leakCandidates.find(
      (c) => c.constructor === 'LeakyCache',
    );
    expect(leaky).toBeUndefined();
    expect(diff.strongLeakCandidates.length).toBe(0);
  });
});
