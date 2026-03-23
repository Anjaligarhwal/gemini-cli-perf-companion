/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  heapSummaryToTrace,
  diffResultToTrace,
  cpuProfileToTrace,
  mergeTraces,
} from '../format/perfetto-formatter.js';
import type {
  CpuProfileData,
  HeapSnapshotSummary,
  ThreeSnapshotDiffResult,
} from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────

const MOCK_SUMMARY: HeapSnapshotSummary = {
  totalSize: 52_428_800,
  nodeCount: 150_000,
  edgeCount: 300_000,
  stringCount: 50_000,
  topConstructors: [
    { constructor: 'Array', count: 5000, totalSize: 20_000_000, averageSize: 4000, sizePercentage: 38.1 },
    { constructor: 'Object', count: 10000, totalSize: 15_000_000, averageSize: 1500, sizePercentage: 28.6 },
  ],
  detachedDomNodes: 3,
  parsingMemoryUsed: 10_000_000,
  parseTimeMs: 450,
};

const MOCK_DIFF_RESULT: ThreeSnapshotDiffResult = {
  leakCandidates: [
    { constructor: 'LeakyObj', countBefore: 100, countAfter: 300, deltaCount: 200, sizeBefore: 10000, sizeAfter: 30000, deltaSizeBytes: 20000, growthRate: 2.0 },
  ],
  strongLeakCandidates: [
    { constructor: 'LeakyObj', countBefore: 100, countAfter: 300, deltaCount: 200, sizeBefore: 10000, sizeAfter: 30000, deltaSizeBytes: 20000, growthRate: 2.0 },
  ],
  retainerChains: [
    {
      depth: 3,
      totalRetainedSize: 5000,
      nodes: [
        { type: 'object', name: 'LeakyObj', edgeType: '(target)', edgeName: 'LeakyObj', selfSize: 2000 },
        { type: 'object', name: 'Map', edgeType: 'property', edgeName: '_cache', selfSize: 1000 },
        { type: 'synthetic', name: '(GC roots)', edgeType: 'property', edgeName: 'global', selfSize: 0 },
      ],
    },
  ],
  summary: { totalNewObjects: 200, totalNewSize: 20000, strongCandidateCount: 1, topLeakingConstructor: 'LeakyObj' },
};

const MOCK_CPU_PROFILE: CpuProfileData = {
  startTime: 0,
  endTime: 500_000,
  duration: 500_000,
  sampleCount: 500,
  hotFunctions: [
    {
      functionName: 'processRequest',
      scriptName: 'file:///app/server.js',
      lineNumber: 42,
      columnNumber: 10,
      selfTime: 150_000,
      totalTime: 250_000,
      selfPercentage: 30,
      hitCount: 150,
    },
    {
      functionName: 'queryDatabase',
      scriptName: 'file:///app/db.js',
      lineNumber: 15,
      columnNumber: 4,
      selfTime: 100_000,
      totalTime: 100_000,
      selfPercentage: 20,
      hitCount: 100,
    },
  ],
  topLevelCategories: [
    { category: 'User Code', totalTime: 300_000, percentage: 60 },
    { category: 'Idle', totalTime: 200_000, percentage: 40 },
  ],
};

// ─── heapSummaryToTrace tests ────────────────────────────────────────

describe('heapSummaryToTrace', () => {
  it('should generate valid trace events', () => {
    const trace = heapSummaryToTrace(MOCK_SUMMARY, 'test-snapshot');

    expect(trace.traceEvents).toBeDefined();
    expect(trace.traceEvents.length).toBeGreaterThan(0);
    expect(trace.metadata?.generatedBy).toBe('gemini-cli-perf-companion');
  });

  it('should include metadata events', () => {
    const trace = heapSummaryToTrace(MOCK_SUMMARY, 'test');
    const metaEvents = trace.traceEvents.filter((e) => e.ph === 'M');

    expect(metaEvents.length).toBeGreaterThan(0);
  });

  it('should include counter events for heap metrics', () => {
    const trace = heapSummaryToTrace(MOCK_SUMMARY, 'test');
    const counters = trace.traceEvents.filter((e) => e.ph === 'C');

    expect(counters.length).toBeGreaterThanOrEqual(3);
    const sizeCounter = counters.find((e) => e.name === 'heap.total_size');
    expect(sizeCounter?.args?.value).toBe(52_428_800);
  });

  it('should include instant events for top constructors', () => {
    const trace = heapSummaryToTrace(MOCK_SUMMARY, 'test');
    const instants = trace.traceEvents.filter((e) => e.cat === 'heap.constructors');

    expect(instants.length).toBe(2);
    expect(instants[0].name).toBe('Array');
  });

  it('should include complete event for parse operation', () => {
    const trace = heapSummaryToTrace(MOCK_SUMMARY, 'test');
    const completeEvents = trace.traceEvents.filter((e) => e.ph === 'X');

    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0].dur).toBe(450_000); // ms → μs
  });

  it('should generate Perfetto-compatible JSON', () => {
    const trace = heapSummaryToTrace(MOCK_SUMMARY, 'test');
    const json = JSON.stringify(trace);
    const parsed = JSON.parse(json);

    expect(Array.isArray(parsed.traceEvents)).toBe(true);
    for (const event of parsed.traceEvents) {
      expect(event.name).toBeDefined();
      expect(event.ph).toBeDefined();
      expect(typeof event.ts).toBe('number');
      expect(typeof event.pid).toBe('number');
      expect(typeof event.tid).toBe('number');
    }
  });
});

// ─── diffResultToTrace tests ─────────────────────────────────────────

describe('diffResultToTrace', () => {
  const timestamps = { a: 1_000_000, b: 2_000_000, c: 3_000_000 };

  it('should generate trace with leak markers', () => {
    const trace = diffResultToTrace(MOCK_DIFF_RESULT, timestamps);
    const leakMarkers = trace.traceEvents.filter((e) => e.cat === 'leak_candidates');

    expect(leakMarkers.length).toBe(1);
    expect(leakMarkers[0].name).toContain('LeakyObj');
  });

  it('should include snapshot phase markers', () => {
    const trace = diffResultToTrace(MOCK_DIFF_RESULT, timestamps);
    const markers = trace.traceEvents.filter((e) => e.cat === 'capture');

    expect(markers.length).toBe(3);
  });

  it('should include growth counter tracks', () => {
    const trace = diffResultToTrace(MOCK_DIFF_RESULT, timestamps);
    const counters = trace.traceEvents.filter((e) => e.ph === 'C');

    expect(counters.length).toBeGreaterThanOrEqual(2);
  });

  it('should emit retainer chain slice events', () => {
    const trace = diffResultToTrace(MOCK_DIFF_RESULT, timestamps);
    const chainEvents = trace.traceEvents.filter((e) => e.cat === 'retainer_chain');

    // 1 chain × 3 nodes = 3 slice events
    expect(chainEvents.length).toBe(3);
    expect(chainEvents[0].name).toContain('LeakyObj');
  });

  it('should include retainer thread metadata', () => {
    const trace = diffResultToTrace(MOCK_DIFF_RESULT, timestamps);
    const threadMeta = trace.traceEvents.filter(
      (e) => e.ph === 'M' && e.name === 'thread_name',
    );
    const retainerThread = threadMeta.find(
      (e) => (e.args as Record<string, string>)?.name === 'Retainer Chains',
    );

    expect(retainerThread).toBeDefined();
  });

  it('should handle diff result with no retainer chains', () => {
    const noChains: ThreeSnapshotDiffResult = {
      ...MOCK_DIFF_RESULT,
      retainerChains: [],
    };
    const trace = diffResultToTrace(noChains, timestamps);
    const chainEvents = trace.traceEvents.filter((e) => e.cat === 'retainer_chain');

    expect(chainEvents.length).toBe(0);
  });
});

// ─── cpuProfileToTrace tests ─────────────────────────────────────────

describe('cpuProfileToTrace', () => {
  it('should generate flame chart complete events', () => {
    const trace = cpuProfileToTrace(MOCK_CPU_PROFILE);
    const slices = trace.traceEvents.filter((e) => e.ph === 'X' && e.cat === 'cpu');

    expect(slices.length).toBe(2);
    expect(slices[0].name).toBe('processRequest');
    expect(slices[0].dur).toBe(150_000);
  });

  it('should sequence flame chart events along the timeline', () => {
    const trace = cpuProfileToTrace(MOCK_CPU_PROFILE, 0);
    const slices = trace.traceEvents.filter((e) => e.ph === 'X' && e.cat === 'cpu');

    // Second slice should start after first ends
    expect(slices[1].ts).toBe(slices[0].ts + slices[0].dur!);
  });

  it('should include category counter events', () => {
    const trace = cpuProfileToTrace(MOCK_CPU_PROFILE);
    const counters = trace.traceEvents.filter(
      (e) => e.ph === 'C' && e.cat === 'cpu.categories',
    );

    expect(counters.length).toBe(2);
  });

  it('should include CPU thread metadata', () => {
    const trace = cpuProfileToTrace(MOCK_CPU_PROFILE);
    const threadMeta = trace.traceEvents.filter(
      (e) => e.ph === 'M' && e.name === 'thread_name',
    );
    const cpuThread = threadMeta.find(
      (e) => (e.args as Record<string, string>)?.name === 'CPU Flame Chart',
    );

    expect(cpuThread).toBeDefined();
  });

  it('should include function metadata in args', () => {
    const trace = cpuProfileToTrace(MOCK_CPU_PROFILE);
    const slice = trace.traceEvents.find(
      (e) => e.ph === 'X' && e.name === 'processRequest',
    );

    expect(slice?.args?.script).toContain('server.js');
    expect(slice?.args?.line).toBe(42);
    expect(slice?.args?.selfPercentage).toBe(30);
  });
});

// ─── mergeTraces tests ───────────────────────────────────────────────

describe('mergeTraces', () => {
  it('should merge events from multiple traces', () => {
    const trace1 = heapSummaryToTrace(MOCK_SUMMARY, 'test');
    const trace2 = cpuProfileToTrace(MOCK_CPU_PROFILE);

    const merged = mergeTraces(trace1, trace2);

    expect(merged.traceEvents.length).toBeGreaterThan(trace1.traceEvents.length);
    expect(merged.traceEvents.length).toBeGreaterThan(trace2.traceEvents.length);
  });

  it('should deduplicate metadata events', () => {
    const trace1 = heapSummaryToTrace(MOCK_SUMMARY, 'test');
    const trace2 = heapSummaryToTrace(MOCK_SUMMARY, 'test2');

    const merged = mergeTraces(trace1, trace2);
    const processNameEvents = merged.traceEvents.filter(
      (e) => e.ph === 'M' && e.name === 'process_name',
    );

    // Should deduplicate process_name:0 (same name + tid)
    expect(processNameEvents.length).toBe(1);
  });

  it('should preserve non-metadata events from all sources', () => {
    const trace1 = heapSummaryToTrace(MOCK_SUMMARY, 'test');
    const trace2 = cpuProfileToTrace(MOCK_CPU_PROFILE);

    const merged = mergeTraces(trace1, trace2);

    // Should have heap counters AND cpu slices
    const heapCounters = merged.traceEvents.filter((e) => e.name === 'heap.total_size');
    const cpuSlices = merged.traceEvents.filter((e) => e.cat === 'cpu');

    expect(heapCounters.length).toBe(1);
    expect(cpuSlices.length).toBeGreaterThan(0);
  });
});
