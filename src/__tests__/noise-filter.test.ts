/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { ObjectGrowthRecord } from '../types.js';
import { filterNoise, isV8Internal } from '../analyze/noise-filter.js';

function makeGrowth(
  constructor: string,
  deltaCount: number,
  deltaSizeBytes: number,
): ObjectGrowthRecord {
  return {
    constructor,
    countBefore: 100,
    countAfter: 100 + deltaCount,
    deltaCount,
    sizeBefore: 10000,
    sizeAfter: 10000 + deltaSizeBytes,
    deltaSizeBytes,
    growthRate: deltaCount / 100,
  };
}

describe('filterNoise', () => {
  it('should keep genuine leak candidates', () => {
    const candidates = [
      makeGrowth('LeakyCache', 50, 51200),  // 50 objects, 50KB — real leak
    ];

    const filtered = filterNoise(candidates);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].constructor).toBe('LeakyCache');
  });

  it('should filter V8 internal constructors', () => {
    const candidates = [
      makeGrowth('(system)', 100, 102400),
      makeGrowth('(compiled code)', 50, 51200),
      makeGrowth('(concatenated string)', 200, 204800),
      makeGrowth('LeakyCache', 50, 51200),
    ];

    const filtered = filterNoise(candidates);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].constructor).toBe('LeakyCache');
  });

  it('should filter names starting with internal prefixes', () => {
    const candidates = [
      makeGrowth('%SharedFunctionInfo', 10, 10240),
      makeGrowth('__internal_timer', 10, 10240),
      makeGrowth('system / Map', 10, 10240),
      makeGrowth('UserTimer', 10, 10240),
    ];

    const filtered = filterNoise(candidates);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].constructor).toBe('UserTimer');
  });

  it('should filter small size deltas below threshold', () => {
    const candidates = [
      makeGrowth('SmallLeak', 5, 500),   // 500 bytes — below 1KB default
      makeGrowth('BigLeak', 5, 5120),     // 5KB — above threshold
    ];

    const filtered = filterNoise(candidates);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].constructor).toBe('BigLeak');
  });

  it('should filter single-instance growth for small objects', () => {
    const candidates = [
      makeGrowth('SmallObj', 1, 5000),     // 1 object, 5KB — single instance, small
      makeGrowth('BigObj', 1, 20000),      // 1 object, 20KB — single instance, large (kept)
      makeGrowth('ManySmall', 10, 5000),   // 10 objects, 5KB — not single instance (kept)
    ];

    // Note: SmallObj has deltaCount=1 which is < minDeltaCount(2), so it's filtered
    // BigObj also has deltaCount=1 < minDeltaCount(2), so it's also filtered by count
    const filtered = filterNoise(candidates);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].constructor).toBe('ManySmall');
  });

  it('should filter negative growth (freed objects)', () => {
    const candidates = [
      makeGrowth('Freed', -10, -10240),
      makeGrowth('Growing', 10, 10240),
    ];

    const filtered = filterNoise(candidates);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].constructor).toBe('Growing');
  });

  it('should respect custom configuration', () => {
    const candidates = [
      makeGrowth('TinyLeak', 5, 256),  // Below default 1KB, but above custom 100
    ];

    const filtered = filterNoise(candidates, {
      minDeltaSizeBytes: 100,
      minDeltaCount: 1,
    });
    expect(filtered).toHaveLength(1);
  });

  it('should support additional exclusions', () => {
    const candidates = [
      makeGrowth('CustomCache', 50, 51200),
      makeGrowth('LeakyCache', 50, 51200),
    ];

    const filtered = filterNoise(candidates, {
      additionalExclusions: ['CustomCache'],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].constructor).toBe('LeakyCache');
  });

  it('should return empty array when all candidates are noise', () => {
    const candidates = [
      makeGrowth('(system)', 100, 102400),
      makeGrowth('TinyThing', 1, 32),
    ];

    const filtered = filterNoise(candidates);
    expect(filtered).toHaveLength(0);
  });

  it('should handle empty input', () => {
    expect(filterNoise([])).toHaveLength(0);
  });
});

describe('isV8Internal', () => {
  it('should identify known V8 internals', () => {
    expect(isV8Internal('(system)')).toBe(true);
    expect(isV8Internal('(compiled code)')).toBe(true);
    expect(isV8Internal('system / Map')).toBe(true);
  });

  it('should identify internal prefix patterns', () => {
    expect(isV8Internal('%SharedFunctionInfo')).toBe(true);
    expect(isV8Internal('__v8_internal')).toBe(true);
  });

  it('should not flag user constructors', () => {
    expect(isV8Internal('MyClass')).toBe(false);
    expect(isV8Internal('EventEmitter')).toBe(false);
    expect(isV8Internal('Buffer')).toBe(false);
  });
});
