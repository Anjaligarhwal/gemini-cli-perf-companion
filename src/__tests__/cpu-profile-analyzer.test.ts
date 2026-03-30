/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeCpuProfileData,
  formatCpuProfileForLLM,
} from '../analyze/cpu-profile-analyzer.js';
import { PerfCompanionError } from '../errors.js';

// ─── Fixtures ────────────────────────────────────────────────────────

/**
 * Build a minimal valid V8 CPU profile.
 *
 * Node tree:
 *   (root) [id=1]
 *     ├── processRequest [id=2, hitCount=50]
 *     │     └── queryDatabase [id=3, hitCount=30]
 *     ├── handleResponse [id=4, hitCount=20]
 *     └── (idle) [id=5, hitCount=100]
 *
 * Profile duration: 200_000 μs (200ms).
 * Each sample corresponds to a 1000 μs interval.
 */
function buildMinimalProfile() {
  return {
    nodes: [
      {
        id: 1,
        callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
        hitCount: 0,
        children: [2, 4, 5],
      },
      {
        id: 2,
        callFrame: { functionName: 'processRequest', scriptId: '1', url: 'file:///app/server.js', lineNumber: 42, columnNumber: 10 },
        hitCount: 50,
        children: [3],
      },
      {
        id: 3,
        callFrame: { functionName: 'queryDatabase', scriptId: '2', url: 'file:///app/db.js', lineNumber: 15, columnNumber: 4 },
        hitCount: 30,
        children: [],
      },
      {
        id: 4,
        callFrame: { functionName: 'handleResponse', scriptId: '1', url: 'file:///app/server.js', lineNumber: 88, columnNumber: 6 },
        hitCount: 20,
        children: [],
      },
      {
        id: 5,
        callFrame: { functionName: '(idle)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
        hitCount: 100,
        children: [],
      },
    ],
    startTime: 0,
    endTime: 200_000,
    samples: [
      // 50 samples for processRequest
      ...new Array(50).fill(2),
      // 30 samples for queryDatabase
      ...new Array(30).fill(3),
      // 20 samples for handleResponse
      ...new Array(20).fill(4),
      // 100 samples for idle
      ...new Array(100).fill(5),
    ],
    timeDeltas: new Array(200).fill(1000), // 1000μs per sample
  };
}

/** Profile with GC pressure. */
function buildGcHeavyProfile() {
  return {
    nodes: [
      {
        id: 1,
        callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
        hitCount: 0,
        children: [2, 3],
      },
      {
        id: 2,
        callFrame: { functionName: '(garbage collector)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
        hitCount: 40,
        children: [],
      },
      {
        id: 3,
        callFrame: { functionName: 'allocateBuffers', scriptId: '1', url: 'file:///app/alloc.js', lineNumber: 10, columnNumber: 0 },
        hitCount: 60,
        children: [],
      },
    ],
    startTime: 0,
    endTime: 100_000,
    samples: [...new Array(40).fill(2), ...new Array(60).fill(3)],
    timeDeltas: new Array(100).fill(1000),
  };
}

/** Profile with node_modules dependency. */
function buildDependencyProfile() {
  return {
    nodes: [
      {
        id: 1,
        callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
        hitCount: 0,
        children: [2, 3],
      },
      {
        id: 2,
        callFrame: { functionName: 'parse', scriptId: '1', url: 'file:///app/node_modules/json5/lib/parse.js', lineNumber: 20, columnNumber: 0 },
        hitCount: 30,
        children: [],
      },
      {
        id: 3,
        callFrame: { functionName: 'readFile', scriptId: '2', url: 'node:fs', lineNumber: 100, columnNumber: 0 },
        hitCount: 20,
        children: [],
      },
    ],
    startTime: 0,
    endTime: 50_000,
    samples: [...new Array(30).fill(2), ...new Array(20).fill(3)],
    timeDeltas: new Array(50).fill(1000),
  };
}

// ─── analyzeCpuProfileData tests ─────────────────────────────────────

describe('analyzeCpuProfileData', () => {
  it('should compute correct duration and sample count', () => {
    const result = analyzeCpuProfileData(buildMinimalProfile());

    expect(result.duration).toBe(200_000);
    expect(result.sampleCount).toBe(200);
    expect(result.startTime).toBe(0);
    expect(result.endTime).toBe(200_000);
  });

  it('should extract hot functions sorted by self-time', () => {
    const result = analyzeCpuProfileData(buildMinimalProfile());

    expect(result.hotFunctions.length).toBeGreaterThan(0);
    // processRequest has most self-time (50 × 1000μs = 50000μs)
    expect(result.hotFunctions[0].functionName).toBe('processRequest');
    expect(result.hotFunctions[0].selfTime).toBe(50_000);
  });

  it('should filter out (root) and (program) nodes', () => {
    const result = analyzeCpuProfileData(buildMinimalProfile());

    const rootFn = result.hotFunctions.find((f) => f.functionName === '(root)');
    expect(rootFn).toBeUndefined();
  });

  it('should compute self-time percentages', () => {
    const result = analyzeCpuProfileData(buildMinimalProfile());

    const processReq = result.hotFunctions.find((f) => f.functionName === 'processRequest');
    expect(processReq).toBeDefined();
    // 50000 / 200000 = 25%
    expect(processReq!.selfPercentage).toBeCloseTo(25, 0);
  });

  it('should compute total-time (self + descendants)', () => {
    const result = analyzeCpuProfileData(buildMinimalProfile());

    const processReq = result.hotFunctions.find((f) => f.functionName === 'processRequest');
    expect(processReq).toBeDefined();
    // processRequest: self=50000 + child queryDatabase=30000 = 80000
    expect(processReq!.totalTime).toBe(80_000);
  });

  it('should include script name and line number', () => {
    const result = analyzeCpuProfileData(buildMinimalProfile());

    const processReq = result.hotFunctions[0];
    expect(processReq.scriptName).toContain('server.js');
    expect(processReq.lineNumber).toBe(42);
  });

  it('should respect topN option', () => {
    const result = analyzeCpuProfileData(buildMinimalProfile(), { topN: 2 });

    expect(result.hotFunctions.length).toBeLessThanOrEqual(2);
  });

  it('should respect minSelfPercentage filter', () => {
    // Set min to 30% — only processRequest (25%) and idle (50%) qualify,
    // but idle doesn't count as a hot function name filter applies
    const result = analyzeCpuProfileData(buildMinimalProfile(), {
      minSelfPercentage: 30,
    });

    // queryDatabase (15%) and handleResponse (10%) should be filtered
    const dbFn = result.hotFunctions.find((f) => f.functionName === 'queryDatabase');
    expect(dbFn).toBeUndefined();
  });

  it('should compute category breakdown', () => {
    const result = analyzeCpuProfileData(buildMinimalProfile());

    expect(result.topLevelCategories.length).toBeGreaterThan(0);

    // Check idle category exists
    const idle = result.topLevelCategories.find((c) => c.category === 'Idle');
    expect(idle).toBeDefined();
    expect(idle!.percentage).toBeCloseTo(50, 0); // 100/200 = 50%
  });

  it('should categorize GC time correctly', () => {
    const result = analyzeCpuProfileData(buildGcHeavyProfile());

    const gc = result.topLevelCategories.find((c) => c.category === 'GC');
    expect(gc).toBeDefined();
    expect(gc!.percentage).toBeCloseTo(40, 0); // 40/100 = 40%
  });

  it('should categorize node_modules as Dependencies', () => {
    const result = analyzeCpuProfileData(buildDependencyProfile());

    const deps = result.topLevelCategories.find((c) => c.category === 'Dependencies');
    expect(deps).toBeDefined();
    expect(deps!.percentage).toBeCloseTo(60, 0); // 30/50 = 60%
  });

  it('should categorize node: URLs as Node.js Core', () => {
    const result = analyzeCpuProfileData(buildDependencyProfile());

    const core = result.topLevelCategories.find((c) => c.category === 'Node.js Core');
    expect(core).toBeDefined();
    expect(core!.percentage).toBeCloseTo(40, 0); // 20/50 = 40%
  });

  it('should handle profile without samples/timeDeltas (hitCount fallback)', () => {
    const profile = {
      nodes: [
        {
          id: 1,
          callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
          hitCount: 0,
          children: [2],
        },
        {
          id: 2,
          callFrame: { functionName: 'doWork', scriptId: '1', url: 'file:///work.js', lineNumber: 1, columnNumber: 0 },
          hitCount: 100,
          children: [],
        },
      ],
      startTime: 0,
      endTime: 100_000,
      // No samples or timeDeltas
    };

    const result = analyzeCpuProfileData(profile);

    // Should still produce hot functions via hitCount fallback
    expect(result.hotFunctions.length).toBeGreaterThan(0);
    expect(result.hotFunctions[0].functionName).toBe('doWork');
  });

  it('should throw on empty nodes array', () => {
    expect(() =>
      analyzeCpuProfileData({
        nodes: [],
        startTime: 0,
        endTime: 100_000,
      }),
    ).toThrow(PerfCompanionError);
  });

  it('should throw on missing timing fields', () => {
    expect(() =>
      analyzeCpuProfileData({
        nodes: [{
          id: 1,
          callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
          hitCount: 0,
        }],
        startTime: undefined as unknown as number,
        endTime: 100_000,
      }),
    ).toThrow(PerfCompanionError);
  });
});

// ─── formatCpuProfileForLLM tests ────────────────────────────────────

describe('formatCpuProfileForLLM', () => {
  it('should produce readable markdown output', () => {
    const profile = analyzeCpuProfileData(buildMinimalProfile());
    const output = formatCpuProfileForLLM(profile);

    expect(output).toContain('CPU Profile Analysis');
    expect(output).toContain('processRequest');
    expect(output).toContain('Hot Functions');
  });

  it('should include category breakdown', () => {
    const profile = analyzeCpuProfileData(buildMinimalProfile());
    const output = formatCpuProfileForLLM(profile);

    expect(output).toContain('Time Breakdown by Category');
    expect(output).toContain('Idle');
  });

  it('should include suggested actions', () => {
    const profile = analyzeCpuProfileData(buildMinimalProfile());
    const output = formatCpuProfileForLLM(profile);

    expect(output).toContain('Suggested Actions');
  });

  it('should show progress bars for categories', () => {
    const profile = analyzeCpuProfileData(buildMinimalProfile());
    const output = formatCpuProfileForLLM(profile);

    // Progress bar characters
    expect(output).toContain('█');
    expect(output).toContain('░');
  });

  it('should include duration in table', () => {
    const profile = analyzeCpuProfileData(buildMinimalProfile());
    const output = formatCpuProfileForLLM(profile);

    expect(output).toContain('Duration');
    expect(output).toContain('200.0 ms');
  });
});
