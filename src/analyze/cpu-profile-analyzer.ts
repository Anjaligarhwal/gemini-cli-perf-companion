/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * V8 CPU profile analyzer.
 *
 * Parses `.cpuprofile` files (V8 sampling profiler output) and extracts
 * hot functions, call-tree statistics, and per-category time breakdowns.
 *
 * V8 `.cpuprofile` format:
 * ```json
 * {
 *   "nodes": [{ "id": 1, "callFrame": { functionName, scriptId, url, lineNumber, columnNumber },
 *               "hitCount": N, "children": [ids...] }],
 *   "startTime": microseconds,
 *   "endTime": microseconds,
 *   "samples": [nodeId, ...],
 *   "timeDeltas": [deltaUs, ...]
 * }
 * ```
 *
 * Analysis strategy:
 *   1. Walk the node tree, accumulating `hitCount` into self-time.
 *   2. Propagate total-time (self + all descendants) bottom-up.
 *   3. Categorize functions into buckets (user, node-core, native, GC, etc.).
 *   4. Sort by self-time to find hot functions.
 *
 * Complexity: O(N) where N = number of profile nodes.
 */

import { readFile } from 'node:fs/promises';
import type { CpuProfileData, HotFunction, CategoryBreakdown } from '../types.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';

// ─── Configuration ───────────────────────────────────────────────────

/** Options controlling CPU profile analysis. */
export interface CpuProfileAnalysisOptions {
  /** Number of top hot functions to return. @defaultValue 20 */
  topN?: number;
  /** Minimum self-time percentage to include. @defaultValue 0.1 */
  minSelfPercentage?: number;
}

/** Default number of hot functions. */
const DEFAULT_TOP_N = 20;

/** Default minimum self-time percentage threshold. */
const DEFAULT_MIN_SELF_PERCENTAGE = 0.1;

// ─── Raw V8 Profile Types ───────────────────────────────────────────

/** Raw V8 CPU profile call frame. */
interface RawCallFrame {
  readonly functionName: string;
  readonly scriptId: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

/** Raw V8 CPU profile node. */
interface RawProfileNode {
  readonly id: number;
  readonly callFrame: RawCallFrame;
  readonly hitCount: number;
  readonly children?: readonly number[];
}

/** Raw V8 CPU profile top-level structure. */
interface RawCpuProfile {
  readonly nodes: readonly RawProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples?: readonly number[];
  readonly timeDeltas?: readonly number[];
}

// ─── Internal Types ──────────────────────────────────────────────────

/** Mutable accumulator during tree walk. */
interface NodeAccumulator {
  selfTime: number;
  totalTime: number;
  readonly callFrame: RawCallFrame;
  readonly hitCount: number;
  readonly childIds: readonly number[];
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Analyze a V8 CPU profile file.
 *
 * @param filePath - Path to the `.cpuprofile` file.
 * @param options  - Analysis configuration.
 * @returns Structured profile data with hot functions and category breakdown.
 * @throws {PerfCompanionError} On file read failure or invalid format.
 */
export async function analyzeCpuProfile(
  filePath: string,
  options?: CpuProfileAnalysisOptions,
): Promise<CpuProfileData> {
  const raw = await readProfileFile(filePath);
  return analyzeCpuProfileData(raw, options);
}

/**
 * Analyze a pre-parsed V8 CPU profile object.
 *
 * Useful when the profile has already been loaded (e.g., from the
 * Inspector API's `Profiler.stop()` result).
 *
 * @param raw     - Raw V8 CPU profile data.
 * @param options - Analysis configuration.
 * @returns Structured profile data.
 */
export function analyzeCpuProfileData(
  raw: RawCpuProfile,
  options?: CpuProfileAnalysisOptions,
): CpuProfileData {
  const topN = options?.topN ?? DEFAULT_TOP_N;
  const minSelfPct = options?.minSelfPercentage ?? DEFAULT_MIN_SELF_PERCENTAGE;

  validateProfile(raw);

  const duration = raw.endTime - raw.startTime;
  const sampleCount = raw.samples?.length ?? 0;

  // ── Step 1: Build node lookup and compute self-time ────────────────
  const nodeMap = buildNodeMap(raw.nodes);
  computeSelfTimeFromSamples(nodeMap, raw.samples, raw.timeDeltas);

  // ── Step 2: Compute total-time (self + descendant) bottom-up ───────
  computeTotalTimeBottomUp(nodeMap, raw.nodes);

  // ── Step 3: Extract hot functions ──────────────────────────────────
  const hotFunctions = extractHotFunctions(nodeMap, duration, topN, minSelfPct);

  // ── Step 4: Compute category breakdown ─────────────────────────────
  const topLevelCategories = computeCategoryBreakdown(nodeMap, duration);

  return {
    startTime: raw.startTime,
    endTime: raw.endTime,
    duration,
    sampleCount,
    hotFunctions,
    topLevelCategories,
  };
}

/**
 * Format CPU profile analysis as LLM-readable markdown.
 *
 * @param profile - Analyzed CPU profile data.
 * @returns Multi-line markdown string.
 */
export function formatCpuProfileForLLM(profile: CpuProfileData): string {
  const lines: string[] = [
    '## CPU Profile Analysis\n',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Duration | ${formatMicroseconds(profile.duration)} |`,
    `| Samples | ${profile.sampleCount.toLocaleString()} |`,
    '',
  ];

  if (profile.topLevelCategories.length > 0) {
    lines.push('### Time Breakdown by Category\n');
    for (const cat of profile.topLevelCategories) {
      const bar = progressBar(cat.percentage);
      lines.push(`- **${cat.category}**: ${cat.percentage.toFixed(1)}% ${bar}`);
    }
    lines.push('');
  }

  if (profile.hotFunctions.length > 0) {
    lines.push('### Hot Functions (by self-time)\n');
    lines.push('| Function | Script | Self Time | Self % | Hits |');
    lines.push('|----------|--------|-----------|--------|------|');

    for (let i = 0; i < profile.hotFunctions.length && i < 15; i++) {
      const fn = profile.hotFunctions[i];
      const name = fn.functionName || '(anonymous)';
      const script = abbreviateScript(fn.scriptName);
      lines.push(
        `| \`${name}\` | ${script}:${fn.lineNumber} | ` +
          `${formatMicroseconds(fn.selfTime)} | ${fn.selfPercentage.toFixed(1)}% | ${fn.hitCount} |`,
      );
    }
    lines.push('');
  }

  lines.push('### Suggested Actions\n');
  if (profile.hotFunctions.length > 0) {
    const top = profile.hotFunctions[0];
    lines.push(
      `- Investigate \`${top.functionName || '(anonymous)'}\` in ` +
        `\`${abbreviateScript(top.scriptName)}:${top.lineNumber}\` — ` +
        `accounts for ${top.selfPercentage.toFixed(1)}% of CPU time`,
    );
  }
  lines.push('- Consider sampling with higher frequency for more granular results');
  lines.push('- Check for hot loops or repeated string operations in top functions');

  return lines.join('\n');
}

// ─── Private: File I/O ───────────────────────────────────────────────

/** Read and parse a `.cpuprofile` JSON file. */
async function readProfileFile(filePath: string): Promise<RawCpuProfile> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    throw new PerfCompanionError(
      `Cannot read CPU profile: ${nodeErr.message}`,
      nodeErr.code === 'ENOENT' ? PerfErrorCode.FILE_NOT_FOUND : PerfErrorCode.PARSE_FAILED,
      /* recoverable= */ false,
    );
  }

  try {
    return JSON.parse(content) as RawCpuProfile;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PerfCompanionError(
      `Failed to parse CPU profile JSON: ${message}`,
      PerfErrorCode.PARSE_FAILED,
      /* recoverable= */ false,
    );
  }
}

// ─── Private: Validation ─────────────────────────────────────────────

/** Validate minimum required structure of a V8 CPU profile. */
function validateProfile(raw: RawCpuProfile): void {
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new PerfCompanionError(
      'CPU profile has no nodes',
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }
  if (typeof raw.startTime !== 'number' || typeof raw.endTime !== 'number') {
    throw new PerfCompanionError(
      'CPU profile missing startTime or endTime',
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }
}

// ─── Private: Node Map Construction ──────────────────────────────────

/** Build a lookup map from node ID to mutable accumulator. */
function buildNodeMap(
  nodes: readonly RawProfileNode[],
): Map<number, NodeAccumulator> {
  const map = new Map<number, NodeAccumulator>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    map.set(node.id, {
      selfTime: 0,
      totalTime: 0,
      callFrame: node.callFrame,
      hitCount: node.hitCount,
      childIds: node.children ?? [],
    });
  }

  return map;
}

// ─── Private: Self-Time Computation ──────────────────────────────────

/**
 * Compute self-time from sample/timeDelta arrays.
 *
 * Each sample records which node was on top of the stack at that
 * moment.  The corresponding timeDelta is the interval since the
 * previous sample (in microseconds).  Self-time = sum of deltas
 * where a node was the active sample.
 *
 * If samples/timeDeltas are missing (older format), fall back to
 * hitCount-based estimation.
 */
function computeSelfTimeFromSamples(
  nodeMap: Map<number, NodeAccumulator>,
  samples?: readonly number[],
  timeDeltas?: readonly number[],
): void {
  if (samples !== undefined && timeDeltas !== undefined && samples.length > 0) {
    // Precise: use actual time deltas per sample.
    for (let i = 0; i < samples.length; i++) {
      const acc = nodeMap.get(samples[i]);
      if (acc !== undefined) {
        // timeDeltas[0] is relative to profile start; all others are inter-sample.
        const delta = i < timeDeltas.length ? Math.max(0, timeDeltas[i]) : 0;
        acc.selfTime += delta;
      }
    }
  } else {
    // Fallback: distribute total time proportionally by hitCount.
    let totalHits = 0;
    for (const acc of nodeMap.values()) {
      totalHits += acc.hitCount;
    }
    if (totalHits === 0) return;

    // Estimate ~1000μs per hit as a rough approximation.
    const usPerHit = 1000;
    for (const acc of nodeMap.values()) {
      acc.selfTime = acc.hitCount * usPerHit;
    }
  }
}

// ─── Private: Total-Time (Bottom-Up) ─────────────────────────────────

/**
 * Propagate total-time bottom-up through the call tree.
 *
 * Total time = self-time + sum of children's total-time.
 * Uses post-order DFS from the root (node[0]).
 */
function computeTotalTimeBottomUp(
  nodeMap: Map<number, NodeAccumulator>,
  nodes: readonly RawProfileNode[],
): void {
  // Post-order traversal: compute children first, then parent.
  const visited = new Set<number>();

  function dfs(nodeId: number): number {
    if (visited.has(nodeId)) return 0;
    visited.add(nodeId);

    const acc = nodeMap.get(nodeId);
    if (acc === undefined) return 0;

    let childrenTotal = 0;
    for (let i = 0; i < acc.childIds.length; i++) {
      childrenTotal += dfs(acc.childIds[i]);
    }

    acc.totalTime = acc.selfTime + childrenTotal;
    return acc.totalTime;
  }

  // Root is always nodes[0] in V8 profiles.
  if (nodes.length > 0) {
    dfs(nodes[0].id);
  }
}

// ─── Private: Hot Function Extraction ────────────────────────────────

/** Extract and rank functions by self-time. */
function extractHotFunctions(
  nodeMap: Map<number, NodeAccumulator>,
  totalDuration: number,
  topN: number,
  minSelfPct: number,
): HotFunction[] {
  const candidates: HotFunction[] = [];

  for (const acc of nodeMap.values()) {
    if (acc.selfTime === 0) continue;

    const selfPct = totalDuration > 0
      ? (acc.selfTime / totalDuration) * 100
      : 0;

    if (selfPct < minSelfPct) continue;

    // Skip V8 synthetic nodes — these are not real user functions.
    const name = acc.callFrame.functionName;
    if (name === '(root)' || name === '(program)' ||
        name === '(idle)' || name === '(garbage collector)') continue;

    candidates.push({
      functionName: name || '(anonymous)',
      scriptName: acc.callFrame.url || '(native)',
      lineNumber: acc.callFrame.lineNumber,
      columnNumber: acc.callFrame.columnNumber,
      selfTime: acc.selfTime,
      totalTime: acc.totalTime,
      selfPercentage: selfPct,
      hitCount: acc.hitCount,
    });
  }

  // Sort by self-time descending.
  candidates.sort((a, b) => b.selfTime - a.selfTime);

  return candidates.length > topN ? candidates.slice(0, topN) : candidates;
}

// ─── Private: Category Breakdown ─────────────────────────────────────

/** Well-known function categories for V8 profiles. */
const CATEGORY_MATCHERS: ReadonlyArray<{
  readonly category: string;
  readonly test: (cf: RawCallFrame) => boolean;
}> = [
  { category: 'GC', test: (cf) => cf.functionName === '(garbage collector)' },
  { category: 'Idle', test: (cf) => cf.functionName === '(idle)' },
  { category: 'Program', test: (cf) => cf.functionName === '(program)' },
  { category: 'V8 Runtime', test: (cf) => cf.url === '' && cf.functionName.startsWith('(') },
  { category: 'Node.js Core', test: (cf) => cf.url.startsWith('node:') },
  { category: 'Dependencies', test: (cf) => cf.url.includes('node_modules') },
  // Default: user code (tested last).
];

/** Aggregate self-time into high-level categories. */
function computeCategoryBreakdown(
  nodeMap: Map<number, NodeAccumulator>,
  totalDuration: number,
): CategoryBreakdown[] {
  const buckets = new Map<string, number>();

  for (const acc of nodeMap.values()) {
    if (acc.selfTime === 0) continue;

    let category = 'User Code';
    for (let i = 0; i < CATEGORY_MATCHERS.length; i++) {
      if (CATEGORY_MATCHERS[i].test(acc.callFrame)) {
        category = CATEGORY_MATCHERS[i].category;
        break;
      }
    }

    buckets.set(category, (buckets.get(category) ?? 0) + acc.selfTime);
  }

  const result: CategoryBreakdown[] = [];
  for (const [category, time] of buckets) {
    result.push({
      category,
      totalTime: time,
      percentage: totalDuration > 0 ? (time / totalDuration) * 100 : 0,
    });
  }

  // Sort by time descending.
  result.sort((a, b) => b.totalTime - a.totalTime);
  return result;
}

// ─── Private: Formatting Helpers ─────────────────────────────────────

/** Format microseconds to a human-readable string. */
function formatMicroseconds(us: number): string {
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

/** Abbreviate a script URL to just the filename. */
function abbreviateScript(url: string): string {
  if (!url || url === '(native)') return url;
  const lastSlash = url.lastIndexOf('/');
  return lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
}

/** Render a text progress bar for category display. */
function progressBar(percentage: number): string {
  const filled = Math.round(percentage / 5);
  const empty = 20 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, empty))}]`;
}
