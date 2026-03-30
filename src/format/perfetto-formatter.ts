/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Perfetto trace formatter.
 *
 * Converts analysis results into Chrome Trace Event Format JSON,
 * natively supported by ui.perfetto.dev for visualization.
 *
 * Supported trace types:
 *   - **Heap summary**: Counter tracks for heap metrics, constructor markers.
 *   - **3-snapshot diff**: Growth counters, leak markers, retainer chain slices.
 *   - **CPU profile**: Flame chart from hot functions, category counters.
 *   - **Combined**: All of the above merged into a single trace file.
 *
 * Thread ID allocation:
 *   TID 1 — Heap metrics
 *   TID 2 — CPU profiling
 *   TID 3 — Analysis phases
 *   TID 4 — Retainer chains
 *
 * Trace format spec:
 * @see https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
 */

import { writeFile } from 'node:fs/promises';

import type {
  CpuProfileData,
  HeapSnapshotSummary,
  PerfettoTrace,
  PerfettoTraceEvent,
  RetainerChain,
  ThreeSnapshotDiffResult,
} from '../types.js';

// ─── Constants ───────────────────────────────────────────────────────

/** Single-process trace ID. */
const PID = 1;

/** Thread ID: heap metrics and counters. */
const TID_HEAP = 1;

/** Thread ID: CPU profiling flame chart. */
const TID_CPU = 2;

/** Thread ID: analysis phase markers. */
const TID_ANALYSIS = 3;

/** Thread ID: retainer chain visualization. */
const TID_RETAINER = 4;

/** Maximum constructors to emit as instant events. */
const MAX_CONSTRUCTOR_EVENTS = 10;

/** Maximum leak candidates to emit as markers. */
const MAX_LEAK_MARKERS = 10;

/** Maximum hot functions to emit in flame chart. */
const MAX_FLAME_CHART_ENTRIES = 20;

// ─── Heap Summary Trace ──────────────────────────────────────────────

/**
 * Create a Perfetto trace from a heap snapshot summary.
 *
 * Generates:
 *   - Metadata events for process/thread names.
 *   - Counter events for heap size, node count, and detached DOM nodes.
 *   - Instant events for top constructors.
 *   - Complete event for the parse operation timing.
 *
 * @param summary     - Parsed heap snapshot summary.
 * @param label       - Human-readable label for the trace.
 * @param timestampUs - Base timestamp in microseconds. @defaultValue 0
 */
export function heapSummaryToTrace(
  summary: HeapSnapshotSummary,
  label: string,
  timestampUs: number = 0,
): PerfettoTrace {
  const events: PerfettoTraceEvent[] = [];

  // ── Metadata ───────────────────────────────────────────────────────
  events.push(
    makeMetaEvent('process_name', 0, { name: 'Heap Analysis' }),
    makeMetaEvent('thread_name', TID_HEAP, { name: 'Heap Metrics' }),
  );

  // ── Counters ───────────────────────────────────────────────────────
  events.push(
    makeCounterEvent('heap.total_size', 'memory', timestampUs, TID_HEAP, summary.totalSize),
    makeCounterEvent('heap.node_count', 'memory', timestampUs, TID_HEAP, summary.nodeCount),
    makeCounterEvent('heap.detached_dom', 'memory', timestampUs, TID_HEAP, summary.detachedDomNodes),
  );

  // ── Constructor markers ────────────────────────────────────────────
  const ctorLimit = Math.min(summary.topConstructors.length, MAX_CONSTRUCTOR_EVENTS);
  for (let i = 0; i < ctorLimit; i++) {
    const ctor = summary.topConstructors[i];
    events.push({
      name: ctor.constructor,
      cat: 'heap.constructors',
      ph: 'i',
      ts: timestampUs,
      pid: PID,
      tid: TID_HEAP,
      args: {
        count: ctor.count,
        totalSize: ctor.totalSize,
        averageSize: ctor.averageSize,
        sizePercentage: Math.round(ctor.sizePercentage * 100) / 100,
      },
    });
  }

  // ── Parse timing ───────────────────────────────────────────────────
  events.push({
    name: `HeapSnapshot.parse(${label})`,
    cat: 'profiling',
    ph: 'X',
    ts: timestampUs,
    dur: summary.parseTimeMs * 1000, // ms → μs
    pid: PID,
    tid: TID_ANALYSIS,
    args: {
      snapshotSize: summary.totalSize,
      nodeCount: summary.nodeCount,
      parsingMemoryUsed: summary.parsingMemoryUsed,
    },
  });

  return buildTrace(`Heap Analysis: ${label}`, events);
}

// ─── 3-Snapshot Diff Trace ───────────────────────────────────────────

/**
 * Create a Perfetto trace from a 3-snapshot diff result.
 *
 * Generates:
 *   - Growth counter tracks for top strong candidates.
 *   - Overall memory growth counter.
 *   - Snapshot phase markers (A, B, C).
 *   - Leak candidate instant markers.
 *   - Retainer chain slice events (if chains are present).
 *
 * @param result     - Three-snapshot diff result.
 * @param timestamps - Capture timestamps in microseconds for A, B, C.
 */
export function diffResultToTrace(
  result: ThreeSnapshotDiffResult,
  timestamps: { readonly a: number; readonly b: number; readonly c: number },
): PerfettoTrace {
  const events: PerfettoTraceEvent[] = [];

  // ── Metadata ───────────────────────────────────────────────────────
  events.push(
    makeMetaEvent('process_name', 0, { name: '3-Snapshot Leak Detection' }),
    makeMetaEvent('thread_name', TID_HEAP, { name: 'Memory Growth' }),
    makeMetaEvent('thread_name', TID_ANALYSIS, { name: 'Analysis' }),
    makeMetaEvent('thread_name', TID_RETAINER, { name: 'Retainer Chains' }),
  );

  // ── Per-candidate growth counters ──────────────────────────────────
  const candidateLimit = Math.min(result.strongLeakCandidates.length, 5);
  for (let i = 0; i < candidateLimit; i++) {
    const candidate = result.strongLeakCandidates[i];
    const trackName = `objects.${candidate.constructor}`;
    events.push(
      makeCounterEvent(trackName, 'memory.growth', timestamps.a, TID_HEAP, candidate.countBefore),
      makeCounterEvent(trackName, 'memory.growth', timestamps.c, TID_HEAP, candidate.countAfter),
    );
  }

  // ── Overall memory growth ──────────────────────────────────────────
  events.push(
    makeCounterEvent('total_leak_size', 'memory', timestamps.a, TID_HEAP, 0),
    makeCounterEvent('total_leak_size', 'memory', timestamps.c, TID_HEAP, result.summary.totalNewSize),
  );

  // ── Snapshot phase markers ─────────────────────────────────────────
  events.push(
    makeInstantEvent('Snapshot A (Baseline)', 'capture', timestamps.a, TID_ANALYSIS),
    makeInstantEvent('Snapshot B (Post-Action 1)', 'capture', timestamps.b, TID_ANALYSIS),
    makeInstantEvent('Snapshot C (Post-Action 2)', 'capture', timestamps.c, TID_ANALYSIS),
  );

  // ── Leak candidate markers ─────────────────────────────────────────
  const leakLimit = Math.min(result.leakCandidates.length, MAX_LEAK_MARKERS);
  for (let i = 0; i < leakLimit; i++) {
    const candidate = result.leakCandidates[i];
    events.push({
      name: `LEAK: ${candidate.constructor}`,
      cat: 'leak_candidates',
      ph: 'i',
      ts: timestamps.c,
      pid: PID,
      tid: TID_ANALYSIS,
      args: {
        deltaCount: candidate.deltaCount,
        deltaSizeBytes: candidate.deltaSizeBytes,
        growthRate: candidate.growthRate,
      },
    });
  }

  // ── Retainer chain slice events ────────────────────────────────────
  emitRetainerChainEvents(events, result.retainerChains, timestamps.c);

  return buildTrace('3-Snapshot Memory Leak Detection', events, {
    totalLeakCandidates: result.leakCandidates.length,
    strongCandidates: result.strongLeakCandidates.length,
  });
}

// ─── CPU Profile Trace ───────────────────────────────────────────────

/**
 * Create a Perfetto trace from CPU profile analysis data.
 *
 * Generates:
 *   - Flame chart (nested complete events) for top hot functions.
 *   - Counter tracks for category breakdown.
 *   - Summary metadata.
 *
 * @param profile     - Analyzed CPU profile data.
 * @param timestampUs - Base timestamp offset. @defaultValue 0
 */
export function cpuProfileToTrace(
  profile: CpuProfileData,
  timestampUs: number = 0,
): PerfettoTrace {
  const events: PerfettoTraceEvent[] = [];

  // ── Metadata ───────────────────────────────────────────────────────
  events.push(
    makeMetaEvent('process_name', 0, { name: 'CPU Profile Analysis' }),
    makeMetaEvent('thread_name', TID_CPU, { name: 'CPU Flame Chart' }),
    makeMetaEvent('thread_name', TID_ANALYSIS, { name: 'Categories' }),
  );

  // ── Flame chart: complete events for hot functions ─────────────────
  // Layout hot functions as stacked slices. Each function's self-time
  // determines its width; we place them sequentially along the timeline.
  let currentTs = timestampUs;
  const fnLimit = Math.min(profile.hotFunctions.length, MAX_FLAME_CHART_ENTRIES);

  for (let i = 0; i < fnLimit; i++) {
    const fn = profile.hotFunctions[i];
    events.push({
      name: fn.functionName || '(anonymous)',
      cat: 'cpu',
      ph: 'X',
      ts: currentTs,
      dur: fn.selfTime,
      pid: PID,
      tid: TID_CPU,
      args: {
        script: fn.scriptName,
        line: fn.lineNumber,
        column: fn.columnNumber,
        selfPercentage: fn.selfPercentage,
        hitCount: fn.hitCount,
      },
    });
    currentTs += fn.selfTime;
  }

  // ── Category counters ──────────────────────────────────────────────
  for (let i = 0; i < profile.topLevelCategories.length; i++) {
    const cat = profile.topLevelCategories[i];
    events.push(
      makeCounterEvent(`cpu.${cat.category}`, 'cpu.categories', timestampUs, TID_ANALYSIS, cat.totalTime),
    );
  }

  return buildTrace('CPU Profile Analysis', events, {
    duration: profile.duration,
    sampleCount: profile.sampleCount,
  });
}

// ─── Combined Trace ──────────────────────────────────────────────────

/**
 * Merge multiple trace sources into a single Perfetto trace file.
 *
 * Deduplicates metadata events and merges all traceEvents arrays.
 *
 * @param traces - One or more trace objects to merge.
 * @returns Combined trace suitable for writing to a single file.
 */
export function mergeTraces(
  ...traces: readonly PerfettoTrace[]
): PerfettoTrace {
  const allEvents: PerfettoTraceEvent[] = [];
  const seenMeta = new Set<string>();

  for (const trace of traces) {
    for (const event of trace.traceEvents) {
      // Deduplicate metadata events by name+tid.
      if (event.ph === 'M') {
        const key = `${event.name}:${event.tid}`;
        if (seenMeta.has(key)) continue;
        seenMeta.add(key);
      }
      allEvents.push(event);
    }
  }

  return buildTrace('Combined Performance Analysis', allEvents);
}

// ─── File I/O ────────────────────────────────────────────────────────

/**
 * Write a Perfetto trace to a JSON file.
 *
 * @param trace      - The trace to serialize.
 * @param outputPath - Absolute file path for the output.
 */
export async function writeTrace(
  trace: PerfettoTrace,
  outputPath: string,
): Promise<void> {
  const json = JSON.stringify(trace, null, 2);
  await writeFile(outputPath, json, 'utf-8');
}

// ─── Private: Retainer Chain Events ──────────────────────────────────

/**
 * Emit retainer chain nodes as nested complete events.
 *
 * Each chain becomes a stack of slices on the retainer thread,
 * visually showing the retention path from target to GC root.
 */
function emitRetainerChainEvents(
  events: PerfettoTraceEvent[],
  chains: readonly RetainerChain[],
  baseTs: number,
): void {
  if (chains.length === 0) return;

  // Space chains along the timeline with a fixed interval.
  const chainSpacing = 100_000; // 100ms per chain in μs
  const nodeWidth = 10_000;     // 10ms per node in μs

  for (let c = 0; c < chains.length; c++) {
    const chain = chains[c];
    const chainBaseTs = baseTs + c * chainSpacing;

    for (let n = 0; n < chain.nodes.length; n++) {
      const node = chain.nodes[n];
      events.push({
        name: `${node.name} (${node.edgeType}: ${node.edgeName})`,
        cat: 'retainer_chain',
        ph: 'X',
        ts: chainBaseTs,
        // Each deeper node has a shorter duration, creating a nested view.
        dur: (chain.nodes.length - n) * nodeWidth,
        pid: PID,
        tid: TID_RETAINER,
        args: {
          type: node.type,
          selfSize: node.selfSize,
          chainIndex: c,
          depth: n,
        },
      });
    }
  }
}

// ─── Private: Event Factory Helpers ──────────────────────────────────

/** Create a metadata event (ph='M'). */
function makeMetaEvent(
  name: string,
  tid: number,
  args: Record<string, unknown>,
): PerfettoTraceEvent {
  return { name, cat: '', ph: 'M', ts: 0, pid: PID, tid, args };
}

/** Create a counter event (ph='C'). */
function makeCounterEvent(
  name: string,
  cat: string,
  ts: number,
  tid: number,
  value: number,
): PerfettoTraceEvent {
  return { name, cat, ph: 'C', ts, pid: PID, tid, args: { value } };
}

/** Create an instant event (ph='i'). */
function makeInstantEvent(
  name: string,
  cat: string,
  ts: number,
  tid: number,
  args?: Record<string, unknown>,
): PerfettoTraceEvent {
  return { name, cat, ph: 'i', ts, pid: PID, tid, args };
}

/** Build the final trace envelope with metadata. */
function buildTrace(
  title: string,
  events: PerfettoTraceEvent[],
  extraMeta?: Record<string, unknown>,
): PerfettoTrace {
  return {
    traceEvents: events,
    metadata: {
      title,
      generatedBy: 'gemini-cli-perf-companion',
      timestamp: new Date().toISOString(),
      ...extraMeta,
    },
  };
}
