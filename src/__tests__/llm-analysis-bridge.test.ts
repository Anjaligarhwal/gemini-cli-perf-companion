/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeHeapSummary,
  analyzeLeakDetection,
  analyzeCpuProfile,
  mergeAnalysisResults,
} from '../bridge/llm-analysis-bridge.js';
import type {
  CpuProfileData,
  HeapSnapshotSummary,
  RetainerChain,
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
    { constructor: 'LeakyCache', countBefore: 100, countAfter: 300, deltaCount: 200, sizeBefore: 10000, sizeAfter: 30000, deltaSizeBytes: 20000, growthRate: 2.0 },
  ],
  strongLeakCandidates: [
    { constructor: 'LeakyCache', countBefore: 100, countAfter: 300, deltaCount: 200, sizeBefore: 10000, sizeAfter: 30000, deltaSizeBytes: 20000, growthRate: 2.0 },
  ],
  retainerChains: [
    {
      depth: 2,
      totalRetainedSize: 3000,
      nodes: [
        { type: 'object', name: 'LeakyCache', edgeType: '(target)', edgeName: 'LeakyCache', selfSize: 2000 },
        { type: 'synthetic', name: '(GC roots)', edgeType: 'property', edgeName: 'global', selfSize: 0 },
      ],
    },
  ],
  summary: { totalNewObjects: 200, totalNewSize: 20000, strongCandidateCount: 1, topLeakingConstructor: 'LeakyCache' },
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
  ],
  topLevelCategories: [
    { category: 'User Code', totalTime: 300_000, percentage: 60 },
    { category: 'GC', totalTime: 100_000, percentage: 20 },
    { category: 'Idle', totalTime: 100_000, percentage: 20 },
  ],
};

// ─── analyzeHeapSummary tests ────────────────────────────────────────

describe('analyzeHeapSummary', () => {
  it('should produce all required result fields', () => {
    const result = analyzeHeapSummary(MOCK_SUMMARY);

    expect(result.summary).toBeDefined();
    expect(result.markdownReport).toBeDefined();
    expect(result.llmContext).toBeDefined();
    expect(result.suggestions).toBeDefined();
    expect(Array.isArray(result.suggestions)).toBe(true);
  });

  it('should include heap size in summary', () => {
    const result = analyzeHeapSummary(MOCK_SUMMARY);

    expect(result.summary).toContain('50.0 MB');
  });

  it('should generate markdown with tables', () => {
    const result = analyzeHeapSummary(MOCK_SUMMARY);

    expect(result.markdownReport).toContain('| Metric | Value |');
    expect(result.markdownReport).toContain('Array');
  });

  it('should suggest investigating detached DOM nodes', () => {
    const result = analyzeHeapSummary(MOCK_SUMMARY);

    const detachedSuggestion = result.suggestions.find((s) => s.includes('detached DOM'));
    expect(detachedSuggestion).toBeDefined();
  });

  it('should suggest investigating dominant constructors', () => {
    const result = analyzeHeapSummary(MOCK_SUMMARY);

    // Array is 38.1% > 30% threshold
    const ctorSuggestion = result.suggestions.find((s) => s.includes('Array'));
    expect(ctorSuggestion).toBeDefined();
  });

  it('should attach Perfetto trace when provided', () => {
    const trace = { traceEvents: [], metadata: {} };
    const result = analyzeHeapSummary(MOCK_SUMMARY, trace);

    expect(result.perfettoTrace).toBe(trace);
  });
});

// ─── analyzeLeakDetection tests ──────────────────────────────────────

describe('analyzeLeakDetection', () => {
  it('should produce all required result fields', () => {
    const result = analyzeLeakDetection(MOCK_DIFF_RESULT);

    expect(result.summary).toContain('LeakyCache');
    expect(result.markdownReport).toBeDefined();
    expect(result.llmContext).toBeDefined();
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('should include retainer chains in LLM context when provided', () => {
    const chainsMap = new Map<string, RetainerChain[]>();
    chainsMap.set('LeakyCache', MOCK_DIFF_RESULT.retainerChains as RetainerChain[]);

    const result = analyzeLeakDetection(MOCK_DIFF_RESULT, chainsMap);

    expect(result.llmContext).toContain('Retainer Chain');
  });

  it('should include retainer chains in markdown when provided', () => {
    const chainsMap = new Map<string, RetainerChain[]>();
    chainsMap.set('LeakyCache', MOCK_DIFF_RESULT.retainerChains as RetainerChain[]);

    const result = analyzeLeakDetection(MOCK_DIFF_RESULT, chainsMap);

    expect(result.markdownReport).toContain('Retainer Chain');
  });

  it('should suggest investigating top leaker', () => {
    const result = analyzeLeakDetection(MOCK_DIFF_RESULT);

    const leakSuggestion = result.suggestions.find((s) => s.includes('LeakyCache'));
    expect(leakSuggestion).toBeDefined();
  });

  it('should handle no-leak results gracefully', () => {
    const noLeaks: ThreeSnapshotDiffResult = {
      leakCandidates: [],
      strongLeakCandidates: [],
      retainerChains: [],
      summary: { totalNewObjects: 0, totalNewSize: 0, strongCandidateCount: 0, topLeakingConstructor: 'none' },
    };

    const result = analyzeLeakDetection(noLeaks);

    expect(result.suggestions).toContain('No memory leaks detected. The heap appears stable across all three snapshots.');
  });

  it('should mention retainer chain availability in suggestions', () => {
    const result = analyzeLeakDetection(MOCK_DIFF_RESULT);

    const chainSuggestion = result.suggestions.find((s) => s.includes('Retainer chains'));
    expect(chainSuggestion).toBeDefined();
  });
});

// ─── analyzeCpuProfile tests ─────────────────────────────────────────

describe('analyzeCpuProfile', () => {
  it('should produce all required result fields', () => {
    const result = analyzeCpuProfile(MOCK_CPU_PROFILE);

    expect(result.summary).toContain('processRequest');
    expect(result.markdownReport).toBeDefined();
    expect(result.llmContext).toBeDefined();
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('should include duration in summary', () => {
    const result = analyzeCpuProfile(MOCK_CPU_PROFILE);

    expect(result.summary).toContain('500');
  });

  it('should generate markdown with function table', () => {
    const result = analyzeCpuProfile(MOCK_CPU_PROFILE);

    expect(result.markdownReport).toContain('processRequest');
    expect(result.markdownReport).toContain('Hot Functions');
  });

  it('should suggest optimizing dominant function', () => {
    const result = analyzeCpuProfile(MOCK_CPU_PROFILE);

    // processRequest is 30% > 20% threshold
    const fnSuggestion = result.suggestions.find((s) => s.includes('processRequest'));
    expect(fnSuggestion).toBeDefined();
  });

  it('should warn about GC pressure', () => {
    const result = analyzeCpuProfile(MOCK_CPU_PROFILE);

    // GC is 20% > 10% threshold
    const gcSuggestion = result.suggestions.find((s) => s.includes('Garbage collection'));
    expect(gcSuggestion).toBeDefined();
  });

  it('should handle empty hot functions', () => {
    const emptyProfile: CpuProfileData = {
      ...MOCK_CPU_PROFILE,
      hotFunctions: [],
    };

    const result = analyzeCpuProfile(emptyProfile);

    expect(result.summary).toContain('none');
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});

// ─── mergeAnalysisResults tests ──────────────────────────────────────

describe('mergeAnalysisResults', () => {
  it('should merge summaries with separator', () => {
    const heap = analyzeHeapSummary(MOCK_SUMMARY);
    const cpu = analyzeCpuProfile(MOCK_CPU_PROFILE);

    const merged = mergeAnalysisResults(heap, cpu);

    expect(merged.summary).toContain('|');
    expect(merged.summary).toContain('Heap snapshot');
    expect(merged.summary).toContain('CPU profile');
  });

  it('should merge markdown reports with divider', () => {
    const heap = analyzeHeapSummary(MOCK_SUMMARY);
    const cpu = analyzeCpuProfile(MOCK_CPU_PROFILE);

    const merged = mergeAnalysisResults(heap, cpu);

    expect(merged.markdownReport).toContain('---');
  });

  it('should combine all suggestions', () => {
    const heap = analyzeHeapSummary(MOCK_SUMMARY);
    const cpu = analyzeCpuProfile(MOCK_CPU_PROFILE);

    const merged = mergeAnalysisResults(heap, cpu);

    expect(merged.suggestions.length).toBeGreaterThanOrEqual(
      heap.suggestions.length + cpu.suggestions.length,
    );
  });

  it('should preserve Perfetto trace from first source that has one', () => {
    const trace = { traceEvents: [], metadata: {} };
    const heap = analyzeHeapSummary(MOCK_SUMMARY, trace);
    const cpu = analyzeCpuProfile(MOCK_CPU_PROFILE);

    const merged = mergeAnalysisResults(heap, cpu);

    expect(merged.perfettoTrace).toBe(trace);
  });
});
