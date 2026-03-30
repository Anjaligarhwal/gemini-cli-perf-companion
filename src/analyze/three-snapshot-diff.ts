/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Three-snapshot technique for memory leak detection.
 *
 * Classic approach:
 *   1. Snapshot A — baseline after warm-up.
 *   2. User performs the suspected leaking operation.
 *   3. Snapshot B — capture post-action.
 *   4. User repeats the operation.
 *   5. Snapshot C — final capture.
 *
 * Analysis pipeline:
 *   - Objects in C but not in A → **leak candidates**.
 *   - Constructor groups with monotonically increasing counts
 *     (A < B < C) → **strong leak candidates** (survived 2 GC cycles).
 *   - Strong candidates pass through the noise filter to remove
 *     V8 internal growth artifacts.
 *   - Retainer chains are extracted for the top-N filtered candidates
 *     to answer "WHY is this alive?" rather than just "WHAT is leaking?".
 *
 * Complexity:
 *   - Aggregation: O(N_A + N_B + N_C) where N_x = node count per snapshot.
 *   - Diff + sort: O(C log C) where C = distinct constructor count.
 *   - Retainer chain extraction: O(V + E) per candidate, bounded by
 *     `maxDepth × maxChains` (see `retainer-chain-extractor.ts`).
 */

import type {
  HeapNode,
  ObjectGrowthRecord,
  RetainerChain,
  ThreeSnapshotDiffResult,
} from '../types.js';
import type { RetainerEdge } from '../parse/edge-parser.js';
import { aggregateByConstructor } from '../parse/node-parser.js';
import { filterNoise } from './noise-filter.js';
import type { NoiseFilterConfig } from './noise-filter.js';
import {
  extractRetainerChainsForLeaks,
  formatRetainerChainsForLLM,
} from './retainer-chain-extractor.js';
import type { RetainerChainOptions } from './retainer-chain-extractor.js';
import { formatBytes } from '../utils.js';

// ─── Configuration ───────────────────────────────────────────────────

/** Options controlling the 3-snapshot diff pipeline. */
export interface ThreeSnapshotDiffOptions {
  /** Number of top leak candidates to return. @defaultValue 20 */
  topN?: number;
  /** Noise filter configuration. */
  noiseFilter?: NoiseFilterConfig;
  /** Retainer chain extraction limits. */
  retainerChains?: RetainerChainOptions;
}

/** Default number of top candidates. */
const DEFAULT_TOP_N = 20;

// ─── Internal Types ──────────────────────────────────────────────────

/** Aggregate statistics for a constructor group across all three snapshots. */
interface ConstructorStats {
  readonly constructor: string;
  readonly countA: number;
  readonly sizeA: number;
  readonly countB: number;
  readonly sizeB: number;
  readonly countC: number;
  readonly sizeC: number;
}

// ─── Core Algorithm ──────────────────────────────────────────────────

/**
 * Run the 3-snapshot diff algorithm with retainer chain extraction.
 *
 * @param nodesA       - Nodes from snapshot A (baseline).
 * @param nodesB       - Nodes from snapshot B (post-action 1).
 * @param nodesC       - Nodes from snapshot C (post-action 2).
 * @param reverseGraph - Reverse adjacency map from snapshot C's edges.
 *                       Pass `undefined` to skip retainer chain extraction.
 * @param options      - Pipeline configuration.
 * @returns Diff result with leak candidates, strong candidates, and
 *   retainer chains for the strongest leaks.
 */
export function threeSnapshotDiff(
  nodesA: readonly HeapNode[],
  nodesB: readonly HeapNode[],
  nodesC: readonly HeapNode[],
  reverseGraph?: ReadonlyMap<number, readonly RetainerEdge[]>,
  options?: ThreeSnapshotDiffOptions,
): ThreeSnapshotDiffResult {
  const topN = options?.topN ?? DEFAULT_TOP_N;

  // ── Step 1: Aggregate by constructor for each snapshot ─────────────
  const statsA = aggregateByConstructor(nodesA);
  const statsB = aggregateByConstructor(nodesB);
  const statsC = aggregateByConstructor(nodesC);

  // ── Step 2: Merge into unified per-constructor stats ───────────────
  const mergedStats = mergeConstructorStats(statsA, statsB, statsC);

  // ── Step 3: Identify leak candidates (C grew relative to A) ────────
  const rawLeakCandidates = extractLeakCandidates(mergedStats);
  rawLeakCandidates.sort(compareBySizeDeltaDesc);

  const leakCandidates = rawLeakCandidates.length > topN
    ? rawLeakCandidates.slice(0, topN)
    : rawLeakCandidates;

  // ── Step 4: Identify strong candidates (monotonic: A < B < C) ──────
  const rawStrongCandidates = extractStrongCandidates(mergedStats);
  rawStrongCandidates.sort(compareBySizeDeltaDesc);

  const strongCandidatesUnfiltered = rawStrongCandidates.length > topN
    ? rawStrongCandidates.slice(0, topN)
    : rawStrongCandidates;

  // ── Step 5: Apply noise filter to strong candidates ────────────────
  const strongLeakCandidates = filterNoise(
    strongCandidatesUnfiltered,
    options?.noiseFilter,
  );

  // ── Step 6: Extract retainer chains for filtered strong candidates ─
  const retainerChains = extractChains(
    strongLeakCandidates,
    nodesC,
    reverseGraph,
    options?.retainerChains,
  );

  // ── Step 7: Compute summary statistics ─────────────────────────────
  const totalNewObjects = sumField(leakCandidates, 'deltaCount');
  const totalNewSize = sumField(leakCandidates, 'deltaSizeBytes');
  const topLeaking = strongLeakCandidates[0]?.constructor
    ?? leakCandidates[0]?.constructor
    ?? 'none';

  return {
    leakCandidates,
    strongLeakCandidates,
    retainerChains,
    summary: {
      totalNewObjects,
      totalNewSize,
      strongCandidateCount: strongLeakCandidates.length,
      topLeakingConstructor: topLeaking,
    },
  };
}

// ─── LLM Output Formatting ──────────────────────────────────────────

/**
 * Format the diff result as structured text for LLM consumption.
 *
 * Designed to be injected into `ToolResult.llmContent` so the Gemini
 * agent can reason about the leak with full context.
 *
 * @param result           - The 3-snapshot diff result.
 * @param retainerChainsMap - Optional retainer chains map for inline display.
 * @returns Multi-line markdown string.
 */
export function formatDiffForLLM(
  result: ThreeSnapshotDiffResult,
  retainerChainsMap?: ReadonlyMap<string, readonly RetainerChain[]>,
): string {
  const lines: string[] = [
    '## Memory Leak Analysis (3-Snapshot Technique)\n',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total new objects | ${result.summary.totalNewObjects} |`,
    `| Total new memory | ${formatBytes(result.summary.totalNewSize)} |`,
    `| Strong leak candidates | ${result.summary.strongCandidateCount} |`,
    `| Top leaking constructor | \`${result.summary.topLeakingConstructor}\` |`,
    '',
  ];

  if (result.strongLeakCandidates.length > 0) {
    lines.push('### Strong Leak Candidates (monotonic growth: A → B → C)\n');
    for (let i = 0; i < result.strongLeakCandidates.length && i < 10; i++) {
      const c = result.strongLeakCandidates[i];
      const rate = c.growthRate === Infinity
        ? '∞'
        : `${(c.growthRate * 100).toFixed(0)}%`;
      lines.push(
        `- **${c.constructor}**: +${c.deltaCount} objects ` +
          `(+${formatBytes(c.deltaSizeBytes)}) | ` +
          `${c.countBefore} → ${c.countAfter} | growth: ${rate}`,
      );
    }
    lines.push('');
  }

  if (result.leakCandidates.length > 0) {
    lines.push('### All Leak Candidates (growing from A to C)\n');
    for (let i = 0; i < result.leakCandidates.length && i < 10; i++) {
      const c = result.leakCandidates[i];
      lines.push(
        `- **${c.constructor}**: +${c.deltaCount} objects ` +
          `(+${formatBytes(c.deltaSizeBytes)})`,
      );
    }
    lines.push('');
  }

  // Append retainer chain analysis if available.
  if (retainerChainsMap !== undefined && retainerChainsMap.size > 0) {
    lines.push(formatRetainerChainsForLLM(retainerChainsMap));
  }

  return lines.join('\n');
}

// ─── Private Helpers ─────────────────────────────────────────────────

/** Merge per-snapshot constructor maps into unified stats. */
function mergeConstructorStats(
  statsA: Map<string, { count: number; totalSize: number }>,
  statsB: Map<string, { count: number; totalSize: number }>,
  statsC: Map<string, { count: number; totalSize: number }>,
): ConstructorStats[] {
  // Collect all unique constructor names across all three snapshots.
  const allConstructors = new Set<string>();
  for (const key of statsA.keys()) allConstructors.add(key);
  for (const key of statsB.keys()) allConstructors.add(key);
  for (const key of statsC.keys()) allConstructors.add(key);

  const result: ConstructorStats[] = new Array<ConstructorStats>(allConstructors.size);
  let idx = 0;

  for (const ctor of allConstructors) {
    const a = statsA.get(ctor);
    const b = statsB.get(ctor);
    const c = statsC.get(ctor);

    result[idx++] = {
      constructor: ctor,
      countA: a?.count ?? 0,
      sizeA: a?.totalSize ?? 0,
      countB: b?.count ?? 0,
      sizeB: b?.totalSize ?? 0,
      countC: c?.count ?? 0,
      sizeC: c?.totalSize ?? 0,
    };
  }

  return result;
}

/** Extract candidates where count grew from A to C. */
function extractLeakCandidates(
  stats: readonly ConstructorStats[],
): ObjectGrowthRecord[] {
  const result: ObjectGrowthRecord[] = [];

  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    if (s.countC <= s.countA) continue;

    result.push(buildGrowthRecord(s));
  }

  return result;
}

/** Extract candidates with strict monotonic growth: A < B < C. */
function extractStrongCandidates(
  stats: readonly ConstructorStats[],
): ObjectGrowthRecord[] {
  const result: ObjectGrowthRecord[] = [];

  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    if (!(s.countA < s.countB && s.countB < s.countC)) continue;

    result.push(buildGrowthRecord(s));
  }

  return result;
}

/** Build a growth record from merged constructor stats. */
function buildGrowthRecord(s: ConstructorStats): ObjectGrowthRecord {
  return {
    constructor: s.constructor,
    countBefore: s.countA,
    countAfter: s.countC,
    deltaCount: s.countC - s.countA,
    sizeBefore: s.sizeA,
    sizeAfter: s.sizeC,
    deltaSizeBytes: s.sizeC - s.sizeA,
    growthRate: s.countA > 0 ? (s.countC - s.countA) / s.countA : Infinity,
  };
}

/**
 * Extract retainer chains for the strong leak candidates.
 *
 * If no reverse graph is provided (e.g., when running in summary-only
 * mode), returns an empty array.
 */
function extractChains(
  candidates: readonly ObjectGrowthRecord[],
  nodesC: readonly HeapNode[],
  reverseGraph?: ReadonlyMap<number, readonly RetainerEdge[]>,
  options?: RetainerChainOptions,
): RetainerChain[] {
  if (reverseGraph === undefined || candidates.length === 0) {
    return [];
  }

  const constructorNames = new Array<string>(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    constructorNames[i] = candidates[i].constructor;
  }

  const chainsMap = extractRetainerChainsForLeaks(
    constructorNames,
    nodesC,
    reverseGraph,
    options,
  );

  // Flatten all chains into a single array for the result.
  const allChains: RetainerChain[] = [];
  for (const chains of chainsMap.values()) {
    for (let i = 0; i < chains.length; i++) {
      allChains.push(chains[i]);
    }
  }

  return allChains;
}

/** Sort comparator: descending by deltaSizeBytes. */
function compareBySizeDeltaDesc(
  a: ObjectGrowthRecord,
  b: ObjectGrowthRecord,
): number {
  return b.deltaSizeBytes - a.deltaSizeBytes;
}

/** Sum a numeric field across an array of growth records. */
function sumField(
  records: readonly ObjectGrowthRecord[],
  field: 'deltaCount' | 'deltaSizeBytes',
): number {
  let total = 0;
  for (let i = 0; i < records.length; i++) {
    total += records[i][field];
  }
  return total;
}

