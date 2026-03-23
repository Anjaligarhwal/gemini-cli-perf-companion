/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Noise filter for heap snapshot diff results.
 *
 * V8 heap snapshots contain many internal objects that grow as part of
 * normal GC behavior (compiled code, sliced strings, system objects).
 * Without filtering, these dominate the diff and obscure real leaks.
 *
 * Filtering strategy (applied in order):
 *   1. Exact-match exclusion: known V8 internal constructor names.
 *   2. Prefix exclusion: names starting with `%`, `__`, or `system /`.
 *   3. Size threshold: absolute delta below `minDeltaSizeBytes`.
 *   4. Count threshold: fewer than `minDeltaCount` new instances.
 *   5. Single-instance filter: one extra small object is likely noise.
 *   6. Negative growth: freed objects are not leaks.
 *
 * Complexity: O(N) where N = number of candidates.  Each candidate is
 * tested against O(1) set lookups and O(P) prefix checks where P is
 * constant (currently 3 prefixes).
 */

import type { ObjectGrowthRecord } from '../types.js';

// ─── Configuration ───────────────────────────────────────────────────

/** Tuning knobs for the noise filter. */
export interface NoiseFilterConfig {
  /**
   * Minimum absolute size delta to be considered a candidate.
   * @defaultValue 1024 (1 KB)
   */
  minDeltaSizeBytes?: number;
  /**
   * Minimum number of new object instances to be considered.
   * @defaultValue 2
   */
  minDeltaCount?: number;
  /**
   * Maximum single-object size below which single-instance growth
   * is treated as noise.
   * @defaultValue 10240 (10 KB)
   */
  singleInstanceMaxSize?: number;
  /** Additional constructor names to exclude (merged with built-in set). */
  additionalExclusions?: readonly string[];
}

// ─── Constants ───────────────────────────────────────────────────────

/** Default minimum absolute size delta (1 KB). */
const DEFAULT_MIN_DELTA_SIZE_BYTES = 1024;

/** Default minimum instance count delta. */
const DEFAULT_MIN_DELTA_COUNT = 2;

/** Default ceiling for single-instance noise filtering (10 KB). */
const DEFAULT_SINGLE_INSTANCE_MAX_SIZE = 10_240;

/**
 * V8 internal constructor names excluded from leak analysis.
 *
 * These objects are part of normal V8 operation and grow/shrink with
 * GC cycles.  The set is derived from Chrome DevTools' built-in
 * exclusion list and empirical observation of typical snapshots.
 */
const V8_INTERNAL_CONSTRUCTORS: ReadonlySet<string> = new Set([
  '(system)',
  '(code)',
  '(compiled code)',
  '(code relocation info)',
  '(compiled code relocation info)',
  '(concatenated string)',
  '(sliced string)',
  '(array)',
  '(object shape)',
  '(closure)',
  '(regexp)',
  '(number)',
  '(symbol)',
  '(bigint)',
  '(hidden)',
  '(native)',
  '(string)',
  'system / Context',
  'system / AllocationSite',
  'system / Map',
  'system / SharedFunctionInfo',
  'system / ScopeInfo',
  'system / FeedbackVector',
  'system / DescriptorArray',
  'system / BytecodeArray',
  'system / CodeWrapper',
]);

/**
 * Prefix patterns for V8-internal names.
 *
 * `%`  — V8 runtime functions (e.g. `%SharedFunctionInfo`).
 * `__` — Node.js internal bindings (e.g. `__internal_timer`).
 * `system /` — V8 system-space allocations.
 */
const INTERNAL_PREFIXES: readonly string[] = ['%', '__', 'system /'];

// ─── Core Filter ─────────────────────────────────────────────────────

/**
 * Remove false positives from a list of object growth records.
 *
 * @param candidates - Raw growth records from a snapshot diff.
 * @param config     - Optional filter tuning parameters.
 * @returns Filtered list with noise removed, preserving original order.
 */
export function filterNoise(
  candidates: readonly ObjectGrowthRecord[],
  config?: NoiseFilterConfig,
): ObjectGrowthRecord[] {
  const minSize = config?.minDeltaSizeBytes ?? DEFAULT_MIN_DELTA_SIZE_BYTES;
  const minCount = config?.minDeltaCount ?? DEFAULT_MIN_DELTA_COUNT;
  const singleMax = config?.singleInstanceMaxSize ?? DEFAULT_SINGLE_INSTANCE_MAX_SIZE;

  // Merge built-in and user-supplied exclusions into a single lookup set.
  const exclusions = buildExclusionSet(config?.additionalExclusions);

  const result: ObjectGrowthRecord[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const record = candidates[i];

    // 1. Exact-match V8 internal constructor names.
    if (exclusions.has(record.constructor)) continue;

    // 2. Prefix-based internal name detection.
    if (hasInternalPrefix(record.constructor)) continue;

    // 3. Absolute size delta below threshold.
    if (record.deltaSizeBytes < minSize) continue;

    // 4. Single-instance growth for small objects (likely transient).
    if (record.deltaCount === 1 && record.deltaSizeBytes < singleMax) continue;

    // 5. Negative or zero growth — objects were freed, not leaked.
    if (record.deltaCount <= 0) continue;

    // 6. Instance count below minimum threshold.
    if (record.deltaCount < minCount) continue;

    result.push(record);
  }

  return result;
}

// ─── Public Utilities ────────────────────────────────────────────────

/**
 * Check whether a constructor name appears to be a V8 internal.
 *
 * Useful for display purposes (e.g., dimming internal objects in reports)
 * without running the full filter pipeline.
 *
 * @param constructorName - The constructor or type name to test.
 * @returns `true` if the name matches a known V8 internal pattern.
 */
export function isV8Internal(constructorName: string): boolean {
  if (V8_INTERNAL_CONSTRUCTORS.has(constructorName)) return true;
  return hasInternalPrefix(constructorName);
}

// ─── Private Helpers ─────────────────────────────────────────────────

/**
 * Build the merged exclusion set from built-in names and optional
 * user-supplied additions.
 */
function buildExclusionSet(
  additional?: readonly string[],
): ReadonlySet<string> {
  if (additional === undefined || additional.length === 0) {
    return V8_INTERNAL_CONSTRUCTORS;
  }

  const merged = new Set(V8_INTERNAL_CONSTRUCTORS);
  for (let i = 0; i < additional.length; i++) {
    merged.add(additional[i]);
  }
  return merged;
}

/** Test whether a name starts with any known internal prefix. */
function hasInternalPrefix(name: string): boolean {
  for (let i = 0; i < INTERNAL_PREFIXES.length; i++) {
    if (name.startsWith(INTERNAL_PREFIXES[i])) return true;
  }
  return false;
}
