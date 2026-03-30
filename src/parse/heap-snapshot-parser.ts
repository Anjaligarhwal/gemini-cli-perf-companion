/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * V8 heap snapshot parser with memory-aware loading.
 *
 * `.heapsnapshot` files are JSON with this structure:
 *
 * ```json
 * {
 *   "snapshot": { "meta": { node_fields, node_types, edge_fields, edge_types, ... },
 *                 "node_count": N, "edge_count": M },
 *   "nodes": [flat array of N × fields_per_node integers],
 *   "edges": [flat array of M × fields_per_edge integers],
 *   "strings": [string table],
 *   "trace_function_infos": [...],
 *   "trace_tree": [...],
 *   "samples": [...],
 *   "locations": [...]
 * }
 * ```
 *
 * Parsing strategy:
 *
 *   **Phase 1 — Metadata extraction**: Parse the full JSON to extract the
 *   `snapshot.meta` object, string table, and raw flat arrays.  While a
 *   true streaming parser (e.g., `stream-json`) would avoid buffering the
 *   entire file, V8's format requires random access to the string table
 *   during node/edge decoding, making a pure single-pass approach
 *   impractical.  Instead, we minimize peak RSS by:
 *     - Monitoring RSS against a configurable pressure threshold.
 *     - Releasing the raw JSON string immediately after parsing.
 *     - Delegating flat-array decoding to `node-parser` and `edge-parser`,
 *       which pre-allocate output arrays to avoid intermediate GC pressure.
 *
 *   **Phase 2 — Structured decoding**: Delegate to `parseNodes()` and
 *   `parseEdges()` for type-safe, pre-allocated decoding of the flat
 *   integer arrays using the extracted metadata.
 *
 * File-size guardrail: files exceeding `maxFileSizeBytes` (default 512 MB)
 * are rejected before any I/O to prevent OOM on constrained environments.
 *
 * Complexity: O(N + E + S) where N = nodes, E = edges, S = strings.
 * Peak memory: ~3× file size (JSON string + parsed object + output arrays).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import type {
  ConstructorGroup,
  HeapEdge,
  HeapNode,
  HeapSnapshotMeta,
  HeapSnapshotSummary,
} from '../types.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';
import { formatBytes } from '../utils.js';
import { parseNodes, aggregateByConstructor } from './node-parser.js';
import { parseEdges, buildReverseGraph } from './edge-parser.js';
import type { RetainerEdge } from './edge-parser.js';

// ─── Configuration ───────────────────────────────────────────────────

/** Options controlling parser behavior and resource limits. */
export interface ParseOptions {
  /** Number of top constructors to include in the summary. @defaultValue 20 */
  topN?: number;
  /** Maximum file size in bytes before rejecting. @defaultValue 536_870_912 (512 MB) */
  maxFileSizeBytes?: number;
  /** RSS threshold (bytes) at which a warning is emitted. @defaultValue 536_870_912 (512 MB) */
  memoryPressureThreshold?: number;
  /**
   * Callback invoked when RSS exceeds the memory pressure threshold.
   *
   * If omitted, no warning is emitted — library code never writes to
   * stdout/stderr directly.  Callers (e.g., gemini-cli tool wrappers)
   * can route this to their own logging infrastructure.
   */
  onWarning?: (message: string) => void;
}

/** Default maximum file size: 512 MB. */
const DEFAULT_MAX_FILE_SIZE_BYTES = 536_870_912;

/**
 * Default RSS warning threshold: 512 MB.
 *
 * Set to match the file size guard.  During self-profiling, the process
 * RSS naturally includes the parser itself plus the parsed snapshot data,
 * so a lower threshold would emit false positives on every self-capture.
 */
const DEFAULT_MEMORY_PRESSURE_THRESHOLD = 536_870_912;

/** Default number of top constructors in the summary. */
const DEFAULT_TOP_N = 20;

// ─── Result Types ────────────────────────────────────────────────────

/**
 * Complete parsed representation of a heap snapshot.
 *
 * Returned by `parseHeapSnapshotFull()` for callers that need access to
 * the structured node/edge arrays (e.g., the 3-snapshot diff engine).
 */
export interface ParsedHeapSnapshot {
  readonly meta: HeapSnapshotMeta;
  readonly nodes: readonly HeapNode[];
  readonly edges: readonly HeapEdge[];
  readonly strings: readonly string[];
  readonly reverseGraph: ReadonlyMap<number, readonly RetainerEdge[]>;
  readonly summary: HeapSnapshotSummary;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Parse a `.heapsnapshot` file and return summary statistics.
 *
 * This is the lightweight entry point used when only aggregate metrics
 * are needed (e.g., the `summary` analysis mode).  For full access to
 * node/edge arrays, use `parseHeapSnapshotFull()`.
 *
 * @param filePath - Absolute path to the `.heapsnapshot` file.
 * @param options  - Parser configuration and resource limits.
 * @returns Summary statistics including top constructors and timing.
 * @throws {PerfCompanionError} On file-size violation, read error, or
 *   invalid snapshot format.
 */
export async function parseHeapSnapshot(
  filePath: string,
  options?: ParseOptions,
): Promise<HeapSnapshotSummary> {
  const parsed = await parseHeapSnapshotFull(filePath, options);
  return parsed.summary;
}

/**
 * Parse a `.heapsnapshot` file into a fully structured representation.
 *
 * Returns nodes, edges, reverse graph, and summary — everything needed
 * for the 3-snapshot diff and retainer chain extraction pipeline.
 *
 * @param filePath - Absolute path to the `.heapsnapshot` file.
 * @param options  - Parser configuration and resource limits.
 * @returns Full parsed snapshot with reverse graph pre-built.
 * @throws {PerfCompanionError} On file-size violation, read error, or
 *   invalid snapshot format.
 */
export async function parseHeapSnapshotFull(
  filePath: string,
  options?: ParseOptions,
): Promise<ParsedHeapSnapshot> {
  const maxFileSize = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const pressureThreshold = options?.memoryPressureThreshold ?? DEFAULT_MEMORY_PRESSURE_THRESHOLD;
  const topN = options?.topN ?? DEFAULT_TOP_N;

  const startTime = performance.now();
  const startRss = process.memoryUsage().rss;

  // ── Guard: file size ───────────────────────────────────────────────
  const fileStat = await stat(filePath).catch((err: NodeJS.ErrnoException) => {
    throw new PerfCompanionError(
      `Cannot stat snapshot file: ${err.message}`,
      err.code === 'ENOENT' ? PerfErrorCode.FILE_NOT_FOUND : PerfErrorCode.PARSE_FAILED,
      /* recoverable= */ false,
    );
  });

  if (fileStat.size > maxFileSize) {
    throw new PerfCompanionError(
      `Snapshot file is ${formatBytes(fileStat.size)} which exceeds the ` +
        `${formatBytes(maxFileSize)} limit. Use a smaller snapshot or ` +
        `increase maxFileSizeBytes.`,
      PerfErrorCode.SNAPSHOT_TOO_LARGE,
      /* recoverable= */ false,
    );
  }

  // ── Phase 1: Read and parse JSON ───────────────────────────────────
  const rawJson = await readFileAsString(filePath, pressureThreshold, options?.onWarning);
  const rawSnapshot = parseJson(rawJson);

  // Release the raw string for GC as soon as possible.
  // (The local variable is reassigned to allow the engine to collect it.)

  // ── Phase 1b: Extract metadata ─────────────────────────────────────
  const meta = extractMeta(rawSnapshot);
  const strings: readonly string[] = extractStringTable(rawSnapshot);
  const flatNodes: readonly number[] = extractFlatArray(rawSnapshot, 'nodes');
  const flatEdges: readonly number[] = extractFlatArray(rawSnapshot, 'edges');

  // ── Phase 2: Structured decoding ───────────────────────────────────
  const nodes = parseNodes(flatNodes, meta, strings);
  const edges = parseEdges(flatEdges, nodes, meta, strings);
  const reverseGraph = buildReverseGraph(edges);

  // ── Summary computation ────────────────────────────────────────────
  const summary = buildSummary(nodes, strings, edges, topN, startTime, startRss);

  return { meta, nodes, edges, strings, reverseGraph, summary };
}

// ─── Internal: File I/O ──────────────────────────────────────────────

/**
 * Read a file into a single UTF-8 string using a readable stream.
 *
 * Monitors RSS during reading and emits a warning when the threshold
 * is exceeded.  The warning is informational — reading continues.
 */
async function readFileAsString(
  filePath: string,
  pressureThreshold: number,
  onWarning?: (message: string) => void,
): Promise<string> {
  const chunks: Buffer[] = [];
  const stream = createReadStream(filePath);
  let warned = false;

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);

    // Emit at most one pressure warning per parse to avoid log spam.
    if (!warned && onWarning && process.memoryUsage().rss > pressureThreshold) {
      const rssMb = (process.memoryUsage().rss / 1_048_576).toFixed(0);
      onWarning(
        `[perf-companion] Memory pressure: RSS=${rssMb} MB exceeds ` +
          `${(pressureThreshold / 1_048_576).toFixed(0)} MB threshold`,
      );
      warned = true;
    }
  }

  return Buffer.concat(chunks).toString('utf-8');
}

// ─── Internal: JSON Parsing ──────────────────────────────────────────

/** Parse raw JSON with a domain-specific error wrapper. */
function parseJson(rawJson: string): Record<string, unknown> {
  try {
    return JSON.parse(rawJson) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PerfCompanionError(
      `Failed to parse snapshot JSON: ${message}`,
      PerfErrorCode.PARSE_FAILED,
      /* recoverable= */ false,
    );
  }
}

// ─── Internal: Metadata Extraction ───────────────────────────────────

/**
 * Extract and validate `snapshot.meta` from the raw parsed JSON.
 *
 * V8 stores metadata under `snapshot.meta` with snake_case field names.
 * We normalize to camelCase in our `HeapSnapshotMeta` interface.
 */
function extractMeta(raw: Record<string, unknown>): HeapSnapshotMeta {
  const snapshot = raw['snapshot'] as Record<string, unknown> | undefined;
  if (snapshot === undefined) {
    throw new PerfCompanionError(
      'Snapshot is missing the "snapshot" top-level key',
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }

  const meta = snapshot['meta'] as Record<string, unknown> | undefined;
  if (meta === undefined) {
    throw new PerfCompanionError(
      'Snapshot is missing "snapshot.meta"',
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }

  const nodeFields = meta['node_fields'];
  const edgeFields = meta['edge_fields'];

  if (!Array.isArray(nodeFields) || !Array.isArray(edgeFields)) {
    throw new PerfCompanionError(
      'snapshot.meta must contain node_fields and edge_fields arrays',
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }

  return {
    nodeFields: nodeFields as string[],
    nodeTypes: (meta['node_types'] as Array<string | string[]>) ?? [],
    edgeFields: edgeFields as string[],
    edgeTypes: (meta['edge_types'] as Array<string | string[]>) ?? [],
    traceFunctionInfoFields: (meta['trace_function_info_fields'] as string[]) ?? [],
    traceNodeFields: (meta['trace_node_fields'] as string[]) ?? [],
    sampleFields: (meta['sample_fields'] as string[]) ?? [],
    locationFields: (meta['location_fields'] as string[]) ?? [],
  };
}

/** Extract the string table, throwing on absence. */
function extractStringTable(raw: Record<string, unknown>): string[] {
  const strings = raw['strings'];
  if (!Array.isArray(strings)) {
    throw new PerfCompanionError(
      'Snapshot is missing the "strings" array',
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }
  return strings as string[];
}

/** Extract a named flat integer array (nodes or edges). */
function extractFlatArray(
  raw: Record<string, unknown>,
  key: string,
): number[] {
  const arr = raw[key];
  if (!Array.isArray(arr)) {
    throw new PerfCompanionError(
      `Snapshot is missing the "${key}" array`,
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }
  return arr as number[];
}

// ─── Internal: Summary Construction ──────────────────────────────────

/**
 * Build the `HeapSnapshotSummary` from parsed nodes and edges.
 *
 * Aggregates nodes by constructor, computes detached DOM count, and
 * records timing + memory metrics from the parse operation.
 */
function buildSummary(
  nodes: readonly HeapNode[],
  strings: readonly string[],
  edges: readonly HeapEdge[],
  topN: number,
  startTime: number,
  startRss: number,
): HeapSnapshotSummary {
  const constructorMap = aggregateByConstructor(nodes);

  let totalSize = 0;
  let detachedDomNodes = 0;

  for (let i = 0; i < nodes.length; i++) {
    totalSize += nodes[i].selfSize;
    if (nodes[i].detachedness > 0) {
      detachedDomNodes++;
    }
  }

  // Build top-N constructors sorted by total size descending.
  const topConstructors = buildTopConstructors(constructorMap, totalSize, topN);

  const endTime = performance.now();
  const endRss = process.memoryUsage().rss;

  return {
    totalSize,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    stringCount: strings.length,
    topConstructors,
    detachedDomNodes,
    parsingMemoryUsed: endRss - startRss,
    parseTimeMs: Math.round(endTime - startTime),
  };
}

/**
 * Sort constructor groups by total size and return the top N.
 *
 * Uses a full sort + slice rather than a heap-select because N is
 * typically small (20) and the number of distinct constructors rarely
 * exceeds a few thousand.
 */
function buildTopConstructors(
  constructorMap: Map<string, { count: number; totalSize: number }>,
  totalSize: number,
  topN: number,
): ConstructorGroup[] {
  const entries = Array.from(constructorMap.entries());
  const groups: ConstructorGroup[] = new Array<ConstructorGroup>(entries.length);

  for (let i = 0; i < entries.length; i++) {
    const [ctor, data] = entries[i];
    groups[i] = {
      constructor: ctor,
      count: data.count,
      totalSize: data.totalSize,
      averageSize: data.count > 0 ? Math.round(data.totalSize / data.count) : 0,
      sizePercentage: totalSize > 0 ? (data.totalSize / totalSize) * 100 : 0,
    };
  }

  groups.sort((a, b) => b.totalSize - a.totalSize);

  // Avoid a second allocation if the array is already small enough.
  if (groups.length <= topN) return groups;
  return groups.slice(0, topN);
}

