/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';

import {
  classifyLeaks,
  formatClassificationForLLM,
} from '../analyze/root-cause-classifier.js';
import type { RetainerChain, ObjectGrowthRecord } from '../types.js';

// ─── Test Helpers ───────────────────────────────────────────────────

function makeGrowthRecord(constructor: string): ObjectGrowthRecord {
  return {
    constructor,
    countBefore: 10,
    countAfter: 50,
    deltaCount: 40,
    sizeBefore: 10240,
    sizeAfter: 51200,
    deltaSizeBytes: 40960,
    growthRate: 4,
  };
}

function makeChain(nodes: Array<{
  type?: string;
  name: string;
  edgeType?: string;
  edgeName?: string;
  selfSize?: number;
}>): RetainerChain {
  return {
    depth: nodes.length,
    totalRetainedSize: nodes.reduce((sum, n) => sum + (n.selfSize ?? 64), 0),
    nodes: nodes.map((n) => ({
      type: n.type ?? 'object',
      name: n.name,
      edgeType: n.edgeType ?? 'property',
      edgeName: n.edgeName ?? '',
      selfSize: n.selfSize ?? 64,
    })),
  };
}

// ─── Event Listener Classification ──────────────────────────────────

describe('classifyLeaks — EVENT_LISTENER', () => {
  it('should classify a leak with _events in the retainer chain', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('RequestHandler', [
      makeChain([
        { name: 'RequestHandler', edgeName: 'handler' },
        { name: 'Object', edgeName: '_events', edgeType: 'property' },
        { name: 'Server', edgeType: 'property' },
        { name: '(Global handles)' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('RequestHandler')], chains);

    expect(report.classifications[0].category).toBe('EVENT_LISTENER');
    expect(report.classifications[0].confidence).toBeGreaterThan(0.3);
    expect(report.classifications[0].suggestedFix).toContain('removeListener');
    expect(report.categoryCounts['EVENT_LISTENER']).toBe(1);
  });

  it('should classify EventEmitter in chain as event listener leak', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('Socket', [
      makeChain([
        { name: 'Socket' },
        { name: 'EventEmitter', edgeName: 'emitter' },
        { name: '(Global handles)' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('Socket')], chains);
    expect(report.classifications[0].category).toBe('EVENT_LISTENER');
  });

  it('should detect onconnection pattern as event listener', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('Handler', [
      makeChain([
        { name: 'Handler' },
        { name: 'Object', edgeName: '_events', edgeType: 'property' },
        { name: 'Server', edgeType: 'property' },
        { name: 'TCP', edgeName: 'onconnection', edgeType: 'property' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('Handler')], chains);
    expect(report.classifications[0].category).toBe('EVENT_LISTENER');
  });
});

// ─── Unbounded Cache Classification ─────────────────────────────────

describe('classifyLeaks — UNBOUNDED_CACHE', () => {
  it('should classify a leak with Map in the retainer chain', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('SessionData', [
      makeChain([
        { name: 'SessionData' },
        { name: '', edgeName: 'table', edgeType: 'internal' },
        { name: 'Map', type: 'object' },
        { name: 'SessionStore', edgeName: 'sessions' },
        { name: '(Global handles)' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('SessionData')], chains);
    expect(report.classifications[0].category).toBe('UNBOUNDED_CACHE');
    expect(report.classifications[0].confidence).toBeGreaterThan(0.4);
    expect(report.classifications[0].suggestedFix).toContain('eviction');
  });

  it('should classify Set-based retention as unbounded cache', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('ConnectionId', [
      makeChain([
        { name: 'ConnectionId' },
        { name: 'Set', type: 'object' },
        { name: 'ConnectionPool', edgeName: '_cache' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('ConnectionId')], chains);
    expect(report.classifications[0].category).toBe('UNBOUNDED_CACHE');
  });

  it('should detect _cache edge name as cache signal', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('CachedResponse', [
      makeChain([
        { name: 'CachedResponse' },
        { name: 'Object', edgeName: '_cache', edgeType: 'property' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('CachedResponse')], chains);
    expect(report.classifications[0].category).toBe('UNBOUNDED_CACHE');
  });
});

// ─── Closure Capture Classification ─────────────────────────────────

describe('classifyLeaks — CLOSURE_CAPTURE', () => {
  it('should classify closure type nodes as closure capture', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('LargeBuffer', [
      makeChain([
        { name: 'LargeBuffer' },
        { name: 'system / Context', edgeType: 'context' },
        { name: 'onComplete', type: 'closure', edgeName: 'context', edgeType: 'internal' },
        { name: '(Global handles)' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('LargeBuffer')], chains);
    expect(report.classifications[0].category).toBe('CLOSURE_CAPTURE');
    expect(report.classifications[0].confidence).toBeGreaterThan(0.3);
    expect(report.classifications[0].suggestedFix).toContain('closure');
  });

  it('should detect system / Context as closure signal', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('RequestContext', [
      makeChain([
        { name: 'RequestContext' },
        { name: 'system / Context', edgeType: 'context' },
        { name: 'system / Context', edgeName: 'context', edgeType: 'internal' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('RequestContext')], chains);
    expect(report.classifications[0].category).toBe('CLOSURE_CAPTURE');
  });
});

// ─── Global Reference Classification ────────────────────────────────

describe('classifyLeaks — GLOBAL_REFERENCE', () => {
  it('should classify objects reachable from global scope', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('Config', [
      makeChain([
        { name: 'Config' },
        { name: 'Object', edgeName: 'global', edgeType: 'property' },
        { name: 'global / ', edgeName: '' },
        { name: '(Global handles)' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('Config')], chains);
    expect(report.classifications[0].category).toBe('GLOBAL_REFERENCE');
    expect(report.classifications[0].confidence).toBeGreaterThan(0.3);
    expect(report.classifications[0].suggestedFix).toContain('instance scope');
  });

  it('should detect module exports as global reference', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('ModuleState', [
      makeChain([
        { name: 'ModuleState' },
        { name: 'Object', edgeName: 'exports', edgeType: 'property' },
        { name: 'process', edgeType: 'property' },
        { name: '(Global handles)' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('ModuleState')], chains);
    expect(report.classifications[0].category).toBe('GLOBAL_REFERENCE');
  });
});

// ─── Timer/Interval Classification ──────────────────────────────────

describe('classifyLeaks — TIMER_INTERVAL', () => {
  it('should classify Timeout in retainer chain as timer leak', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('PollData', [
      makeChain([
        { name: 'PollData' },
        { name: 'system / Context', edgeName: '_onTimeout', edgeType: 'property' },
        { name: 'Timeout' },
        { name: '(Global handles)' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('PollData')], chains);
    expect(report.classifications[0].category).toBe('TIMER_INTERVAL');
    expect(report.classifications[0].confidence).toBeGreaterThan(0.3);
    expect(report.classifications[0].suggestedFix).toContain('clearInterval');
  });

  it('should detect TimersList as timer signal', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('Callback', [
      makeChain([
        { name: 'Callback' },
        { name: 'TimersList', edgeName: 'timer' },
        { name: 'Timer' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('Callback')], chains);
    expect(report.classifications[0].category).toBe('TIMER_INTERVAL');
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────

describe('classifyLeaks — edge cases', () => {
  it('should return UNKNOWN when no retainer chains exist', () => {
    const chains = new Map<string, RetainerChain[]>();
    // No chains for LeakyCache.

    const report = classifyLeaks([makeGrowthRecord('LeakyCache')], chains);
    expect(report.classifications[0].category).toBe('UNKNOWN');
    expect(report.classifications[0].confidence).toBe(0);
    expect(report.unclassifiedCount).toBe(1);
  });

  it('should return UNKNOWN for empty chains array', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('LeakyCache', []);

    const report = classifyLeaks([makeGrowthRecord('LeakyCache')], chains);
    expect(report.classifications[0].category).toBe('UNKNOWN');
  });

  it('should return UNKNOWN when no signals match above threshold', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('Mystery', [
      makeChain([
        { name: 'Mystery' },
        { name: 'InternalThing', edgeName: 'obscure', edgeType: 'hidden' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('Mystery')], chains);
    expect(report.classifications[0].category).toBe('UNKNOWN');
  });

  it('should classify multiple candidates independently', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('ListenerLeak', [
      makeChain([
        { name: 'ListenerLeak' },
        { name: 'Object', edgeName: '_events', edgeType: 'property' },
        { name: 'EventEmitter' },
      ]),
    ]);
    chains.set('CacheLeak', [
      makeChain([
        { name: 'CacheLeak' },
        { name: 'Map', type: 'object' },
        { name: 'Object', edgeName: '_cache' },
      ]),
    ]);

    const report = classifyLeaks(
      [makeGrowthRecord('ListenerLeak'), makeGrowthRecord('CacheLeak')],
      chains,
    );

    expect(report.classifications[0].category).toBe('EVENT_LISTENER');
    expect(report.classifications[1].category).toBe('UNBOUNDED_CACHE');
    expect(report.totalAnalyzed).toBe(2);
    expect(report.unclassifiedCount).toBe(0);
  });

  it('should handle candidate with no matching chains key', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('OtherThing', [makeChain([{ name: 'OtherThing' }])]);

    const report = classifyLeaks([makeGrowthRecord('MissingKey')], chains);
    expect(report.classifications[0].category).toBe('UNKNOWN');
  });
});

// ─── Report Formatting ──────────────────────────────────────────────

describe('formatClassificationForLLM', () => {
  it('should format a classification report as structured markdown', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('SessionCache', [
      makeChain([
        { name: 'SessionCache' },
        { name: 'Map', type: 'object' },
        { name: 'Object', edgeName: 'sessions' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('SessionCache')], chains);
    const output = formatClassificationForLLM(report);

    expect(output).toContain('Root Cause Classification');
    expect(output).toContain('SessionCache');
    expect(output).toContain('Unbounded Cache');
    expect(output).toContain('Suggested fix');
    expect(output).toContain('Category Summary');
  });

  it('should omit UNKNOWN classifications from the formatted output', () => {
    const chains = new Map<string, RetainerChain[]>();

    const report = classifyLeaks([makeGrowthRecord('Unknown')], chains);
    const output = formatClassificationForLLM(report);

    // Should still have the header but no detailed section for UNKNOWN.
    expect(output).toContain('Root Cause Classification');
    expect(output).not.toContain('### Unknown —');
  });

  it('should include confidence percentage', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('Timer', [
      makeChain([
        { name: 'Timer' },
        { name: 'Timeout' },
        { name: '(Global handles)' },
      ]),
    ]);

    const report = classifyLeaks([makeGrowthRecord('Timer')], chains);
    const output = formatClassificationForLLM(report);

    expect(output).toMatch(/\d+% confidence/);
  });

  it('should produce category summary table', () => {
    const chains = new Map<string, RetainerChain[]>();
    chains.set('A', [
      makeChain([{ name: 'A' }, { name: 'Object', edgeName: '_events', edgeType: 'property' }, { name: 'EventEmitter' }]),
    ]);
    chains.set('B', [
      makeChain([{ name: 'B' }, { name: 'Map', type: 'object' }, { name: 'Object', edgeName: '_cache' }]),
    ]);

    const report = classifyLeaks(
      [makeGrowthRecord('A'), makeGrowthRecord('B')],
      chains,
    );
    const output = formatClassificationForLLM(report);

    expect(output).toContain('| Event Listener Leak | 1 |');
    expect(output).toContain('| Unbounded Cache | 1 |');
  });
});
