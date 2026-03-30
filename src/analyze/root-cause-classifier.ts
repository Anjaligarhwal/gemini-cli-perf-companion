/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Automatic root cause classification for memory leaks.
 *
 * Given retainer chains from the 3-snapshot diff pipeline, classifies
 * each leak into one of five categories:
 *
 *   1. **EVENT_LISTENER** — Object retained via `_events` / `_listeners`
 *      on an EventEmitter.  Fix: remove listener in teardown.
 *   2. **UNBOUNDED_CACHE** — Object retained in a Map/Set that grows
 *      monotonically without eviction.  Fix: add TTL or LRU policy.
 *   3. **CLOSURE_CAPTURE** — Closure retains outer scope variables
 *      beyond their useful lifetime.  Fix: null captured refs or
 *      restructure scope.
 *   4. **GLOBAL_REFERENCE** — Object reachable from `global` or
 *      module-scope bindings.  Fix: move to instance scope with
 *      lifecycle management.
 *   5. **TIMER_INTERVAL** — Object retained via `setTimeout` /
 *      `setInterval` callback that was never cleared.  Fix: call
 *      `clearInterval()` / `clearTimeout()` in dispose.
 *
 * Each classification includes:
 *   - A confidence score (0–1) based on signal strength.
 *   - The specific chain evidence that triggered the classification.
 *   - A human-readable explanation for the LLM agent.
 *   - A suggested fix pattern.
 *
 * Design rationale:
 *   The classifier uses pattern matching on retainer chain node names,
 *   edge types, and node types — NOT heuristics on allocation counts.
 *   This makes it robust across V8 versions where internal naming
 *   conventions change, because the structural patterns (e.g., an
 *   EventEmitter always has `_events` as a property edge) are stable
 *   across Node.js 18–22+.
 *
 * @module
 */

import type { RetainerChain, RetainerNode, ObjectGrowthRecord } from '../types.js';

// ─── Classification Types ───────────────────────────────────────────

/**
 * Root cause category for a detected memory leak.
 */
export const enum LeakCategory {
  EVENT_LISTENER = 'EVENT_LISTENER',
  UNBOUNDED_CACHE = 'UNBOUNDED_CACHE',
  CLOSURE_CAPTURE = 'CLOSURE_CAPTURE',
  GLOBAL_REFERENCE = 'GLOBAL_REFERENCE',
  TIMER_INTERVAL = 'TIMER_INTERVAL',
  UNKNOWN = 'UNKNOWN',
}

/** String union matching the enum values, for use in non-const-enum contexts. */
export type LeakCategoryString =
  | 'EVENT_LISTENER'
  | 'UNBOUNDED_CACHE'
  | 'CLOSURE_CAPTURE'
  | 'GLOBAL_REFERENCE'
  | 'TIMER_INTERVAL'
  | 'UNKNOWN';

/**
 * Classification result for a single leak candidate.
 */
export interface LeakClassification {
  /** Constructor name of the leaking object. */
  readonly constructor: string;
  /** Detected root cause category. */
  readonly category: LeakCategoryString;
  /** Confidence score: 0 = no signal, 1 = strong match. */
  readonly confidence: number;
  /** Human-readable explanation of the classification reasoning. */
  readonly explanation: string;
  /** Suggested fix pattern for the LLM agent to propose. */
  readonly suggestedFix: string;
  /** Retainer chain evidence that triggered this classification. */
  readonly evidence: readonly string[];
}

/**
 * Complete classification report for all analyzed leak candidates.
 */
export interface ClassificationReport {
  /** Per-constructor classification results. */
  readonly classifications: readonly LeakClassification[];
  /** Summary counts by category. */
  readonly categoryCounts: Readonly<Record<LeakCategoryString, number>>;
  /** Total constructors analyzed. */
  readonly totalAnalyzed: number;
  /** Constructors that could not be classified (UNKNOWN). */
  readonly unclassifiedCount: number;
}

// ─── Pattern Signals ────────────────────────────────────────────────

/**
 * Patterns that indicate an event listener leak.
 *
 * V8 stores EventEmitter listeners in `_events` (a plain object) or
 * `_listeners` (used by some libraries).  The edge connecting the
 * leaked object to the emitter is typically a `property` edge named
 * after the event (e.g., `request`, `data`, `connection`).
 */
const EVENT_LISTENER_SIGNALS: ReadonlyArray<{
  readonly test: (node: RetainerNode) => boolean;
  readonly weight: number;
}> = [
  { test: (n) => n.edgeName === '_events', weight: 0.5 },
  { test: (n) => n.edgeName === '_listeners', weight: 0.4 },
  { test: (n) => n.name === 'EventEmitter', weight: 0.3 },
  { test: (n) => n.name === 'Server' && n.edgeType === 'property', weight: 0.2 },
  { test: (n) => n.edgeName === 'onconnection' || n.edgeName === 'onStreamRead', weight: 0.3 },
  { test: (n) => n.name === 'Socket' || n.name === 'IncomingMessage', weight: 0.15 },
];

/**
 * Patterns that indicate an unbounded cache.
 *
 * Maps and Sets in V8 appear as `Map` or `Set` constructor names.
 * The edge from the map to the cached entry is typically `element`
 * (for Set) or `internal` (for Map table entries).
 */
const CACHE_SIGNALS: ReadonlyArray<{
  readonly test: (node: RetainerNode) => boolean;
  readonly weight: number;
}> = [
  { test: (n) => n.name === 'Map' && n.type === 'object', weight: 0.5 },
  { test: (n) => n.name === 'Set' && n.type === 'object', weight: 0.45 },
  { test: (n) => n.edgeName === 'table' && n.edgeType === 'internal', weight: 0.3 },
  { test: (n) => n.edgeName === '_cache' || n.edgeName === 'cache', weight: 0.4 },
  { test: (n) => n.edgeName === 'sessions' || n.edgeName === '_sessions', weight: 0.35 },
  { test: (n) => n.edgeName === '_store' || n.edgeName === 'store', weight: 0.3 },
];

/**
 * Patterns that indicate closure-based retention.
 *
 * V8 closures appear with type `closure` and retain outer scope
 * variables through `context` edges to `system / Context` nodes.
 */
const CLOSURE_SIGNALS: ReadonlyArray<{
  readonly test: (node: RetainerNode) => boolean;
  readonly weight: number;
}> = [
  { test: (n) => n.type === 'closure', weight: 0.5 },
  { test: (n) => n.name === 'system / Context', weight: 0.35 },
  { test: (n) => n.edgeType === 'context', weight: 0.3 },
  { test: (n) => n.edgeName === 'context' && n.edgeType === 'internal', weight: 0.25 },
];

/**
 * Patterns that indicate a global or module-scope reference.
 *
 * Objects reachable from `global` (window in browser, `globalThis` in
 * Node.js) or from module `exports` are retained indefinitely.
 */
const GLOBAL_SIGNALS: ReadonlyArray<{
  readonly test: (node: RetainerNode) => boolean;
  readonly weight: number;
}> = [
  { test: (n) => n.name.startsWith('global') || n.name === 'global / ', weight: 0.5 },
  { test: (n) => n.name === '(Global handles)', weight: 0.4 },
  { test: (n) => n.edgeName === 'global', weight: 0.35 },
  { test: (n) => n.edgeName === 'exports' && n.edgeType === 'property', weight: 0.3 },
  { test: (n) => n.name === 'process' && n.edgeType === 'property', weight: 0.2 },
];

/**
 * Patterns that indicate timer/interval retention.
 *
 * `setTimeout` and `setInterval` create `Timeout` objects in Node.js
 * that retain their callback closures until cleared.
 */
const TIMER_SIGNALS: ReadonlyArray<{
  readonly test: (node: RetainerNode) => boolean;
  readonly weight: number;
}> = [
  { test: (n) => n.name === 'Timeout', weight: 0.6 },
  { test: (n) => n.name === 'Timer', weight: 0.5 },
  { test: (n) => n.edgeName === '_onTimeout' || n.edgeName === 'callback', weight: 0.3 },
  { test: (n) => n.edgeName === '_timer' || n.edgeName === 'timer', weight: 0.25 },
  { test: (n) => n.name === 'TimersList', weight: 0.35 },
];

// ─── Classifier ─────────────────────────────────────────────────────

/**
 * Classify a set of leak candidates based on their retainer chains.
 *
 * For each candidate constructor, examines all available retainer chains
 * and scores them against the five category signal patterns.  The
 * category with the highest aggregate score wins.
 *
 * @param candidates     - Strong leak candidates from the 3-snapshot diff.
 * @param retainerChains - Map from constructor name to retainer chains.
 * @returns Complete classification report.
 */
export function classifyLeaks(
  candidates: readonly ObjectGrowthRecord[],
  retainerChains: ReadonlyMap<string, readonly RetainerChain[]>,
): ClassificationReport {
  const classifications: LeakClassification[] = [];
  const categoryCounts: Record<LeakCategoryString, number> = {
    EVENT_LISTENER: 0,
    UNBOUNDED_CACHE: 0,
    CLOSURE_CAPTURE: 0,
    GLOBAL_REFERENCE: 0,
    TIMER_INTERVAL: 0,
    UNKNOWN: 0,
  };

  for (const candidate of candidates) {
    const chains = retainerChains.get(candidate.constructor);
    const classification = classifySingleLeak(candidate.constructor, chains);
    classifications.push(classification);
    categoryCounts[classification.category]++;
  }

  const unclassifiedCount = categoryCounts['UNKNOWN'];

  return {
    classifications,
    categoryCounts,
    totalAnalyzed: candidates.length,
    unclassifiedCount,
  };
}

/**
 * Classify a single leak candidate.
 */
function classifySingleLeak(
  constructor: string,
  chains: readonly RetainerChain[] | undefined,
): LeakClassification {
  if (chains === undefined || chains.length === 0) {
    return {
      constructor,
      category: 'UNKNOWN',
      confidence: 0,
      explanation:
        `No retainer chains available for ${constructor}. ` +
        'Cannot determine root cause without retention path data.',
      suggestedFix:
        'Run the 3-snapshot capture with a reverse graph to extract retainer chains.',
      evidence: [],
    };
  }

  // Score each category across all chains.
  const scores = {
    EVENT_LISTENER: 0,
    UNBOUNDED_CACHE: 0,
    CLOSURE_CAPTURE: 0,
    GLOBAL_REFERENCE: 0,
    TIMER_INTERVAL: 0,
  };
  const evidenceMap: Record<string, string[]> = {
    EVENT_LISTENER: [],
    UNBOUNDED_CACHE: [],
    CLOSURE_CAPTURE: [],
    GLOBAL_REFERENCE: [],
    TIMER_INTERVAL: [],
  };

  for (const chain of chains) {
    scoreChain(chain, EVENT_LISTENER_SIGNALS, 'EVENT_LISTENER', scores, evidenceMap);
    scoreChain(chain, CACHE_SIGNALS, 'UNBOUNDED_CACHE', scores, evidenceMap);
    scoreChain(chain, CLOSURE_SIGNALS, 'CLOSURE_CAPTURE', scores, evidenceMap);
    scoreChain(chain, GLOBAL_SIGNALS, 'GLOBAL_REFERENCE', scores, evidenceMap);
    scoreChain(chain, TIMER_SIGNALS, 'TIMER_INTERVAL', scores, evidenceMap);
  }

  // Normalize scores by chain count to avoid bias toward constructors
  // with more chains.
  const chainCount = chains.length;
  for (const key of Object.keys(scores) as Array<keyof typeof scores>) {
    scores[key] /= chainCount;
  }

  // Find the winning category.
  let bestCategory: LeakCategoryString = 'UNKNOWN';
  let bestScore = 0;

  for (const [category, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category as LeakCategoryString;
    }
  }

  // Require a minimum confidence threshold to avoid false positives.
  const MIN_CONFIDENCE = 0.15;
  if (bestScore < MIN_CONFIDENCE) {
    return {
      constructor,
      category: 'UNKNOWN',
      confidence: bestScore,
      explanation:
        `Retainer chains for ${constructor} do not strongly match any known leak pattern. ` +
        'Manual inspection of the retention paths is recommended.',
      suggestedFix:
        'Examine the retainer chains manually. Look for unexpected references ' +
        'keeping the object alive beyond its intended lifecycle.',
      evidence: [],
    };
  }

  // Clamp confidence to [0, 1].
  const confidence = Math.min(bestScore, 1);
  const evidence = deduplicateEvidence(evidenceMap[bestCategory] ?? []);

  return {
    constructor,
    category: bestCategory,
    confidence,
    explanation: buildExplanation(constructor, bestCategory, evidence),
    suggestedFix: buildSuggestedFix(constructor, bestCategory),
    evidence,
  };
}

/**
 * Score a single retainer chain against a set of signal patterns.
 */
function scoreChain(
  chain: RetainerChain,
  signals: ReadonlyArray<{
    readonly test: (node: RetainerNode) => boolean;
    readonly weight: number;
  }>,
  category: string,
  scores: Record<string, number>,
  evidenceMap: Record<string, string[]>,
): void {
  for (const node of chain.nodes) {
    for (const signal of signals) {
      if (signal.test(node)) {
        scores[category] += signal.weight;
        evidenceMap[category].push(
          `${node.name} (edge: ${node.edgeType}/${node.edgeName})`,
        );
      }
    }
  }
}

// ─── Explanation Generation ─────────────────────────────────────────

function buildExplanation(
  constructor: string,
  category: LeakCategoryString,
  evidence: readonly string[],
): string {
  const evidenceStr = evidence.length > 0
    ? ` Evidence: ${evidence.slice(0, 3).join(', ')}.`
    : '';

  switch (category) {
    case 'EVENT_LISTENER':
      return (
        `${constructor} is retained via an event listener chain. ` +
        'An EventEmitter holds a reference to this object through its ' +
        '_events registry, preventing garbage collection even after the ' +
        `listener\'s purpose has ended.${evidenceStr}`
      );
    case 'UNBOUNDED_CACHE':
      return (
        `${constructor} is retained in a Map or Set that grows without eviction. ` +
        'Entries are added but never removed, causing monotonic memory growth ' +
        `proportional to the number of operations.${evidenceStr}`
      );
    case 'CLOSURE_CAPTURE':
      return (
        `${constructor} is retained by a closure that captures variables from ` +
        'an outer scope. The closure keeps the entire scope context alive, ' +
        `preventing GC of all captured variables.${evidenceStr}`
      );
    case 'GLOBAL_REFERENCE':
      return (
        `${constructor} is reachable from global scope or module-level bindings. ` +
        'Objects retained at module scope persist for the lifetime of the process ' +
        `and are never garbage collected.${evidenceStr}`
      );
    case 'TIMER_INTERVAL':
      return (
        `${constructor} is retained by a timer (setTimeout/setInterval) callback ` +
        'that was never cleared. The timer keeps its callback closure alive, ' +
        `which in turn retains ${constructor}.${evidenceStr}`
      );
    default:
      return `${constructor} could not be classified into a known leak pattern.`;
  }
}

function buildSuggestedFix(
  constructor: string,
  category: LeakCategoryString,
): string {
  switch (category) {
    case 'EVENT_LISTENER':
      return (
        `Add removeListener() or removeAllListeners() for ${constructor} ` +
        'in the connection/request teardown path. If using EventEmitter, ' +
        'ensure listeners are removed when the emitting object is destroyed.'
      );
    case 'UNBOUNDED_CACHE':
      return (
        `Add eviction to the collection holding ${constructor} instances. ` +
        'Options: TTL-based expiry, LRU cache with a max size, or WeakRef/WeakMap ' +
        'to allow GC when no other references exist.'
      );
    case 'CLOSURE_CAPTURE':
      return (
        `Null out references to ${constructor} in the closure scope after use, ` +
        'or restructure the code to avoid capturing large objects. Consider ' +
        'extracting the closure body into a named function with explicit parameters.'
      );
    case 'GLOBAL_REFERENCE':
      return (
        `Move ${constructor} from module/global scope to instance scope with ` +
        'explicit lifecycle management. If the global reference is intentional, ' +
        'add a cleanup method that nulls the reference when the object is no longer needed.'
      );
    case 'TIMER_INTERVAL':
      return (
        `Store the timer ID returned by setInterval/setTimeout and call ` +
        'clearInterval()/clearTimeout() when the owning object is disposed. ' +
        `Ensure the timer callback does not capture ${constructor} unnecessarily.`
      );
    default:
      return (
        `Examine the retainer chains for ${constructor} manually to identify ` +
        'the retention path and determine the appropriate cleanup strategy.'
      );
  }
}

// ─── Formatting ─────────────────────────────────────────────────────

/**
 * Format a classification report as structured text for the LLM agent.
 *
 * Designed to be appended to `ToolResult.llmContent` alongside the
 * retainer chain analysis.
 */
export function formatClassificationForLLM(
  report: ClassificationReport,
): string {
  const lines: string[] = [
    '## Root Cause Classification\n',
    `Analyzed ${report.totalAnalyzed} leak candidates. ` +
      `${report.totalAnalyzed - report.unclassifiedCount} classified, ` +
      `${report.unclassifiedCount} unclassified.\n`,
  ];

  for (const c of report.classifications) {
    if (c.category === 'UNKNOWN') continue;

    lines.push(`### ${c.constructor} — ${formatCategory(c.category)} (${(c.confidence * 100).toFixed(0)}% confidence)\n`);
    lines.push(c.explanation);
    lines.push('');
    lines.push(`**Suggested fix:** ${c.suggestedFix}`);
    lines.push('');
  }

  // Summary table.
  lines.push('### Category Summary\n');
  lines.push('| Category | Count |');
  lines.push('|----------|-------|');
  for (const [cat, count] of Object.entries(report.categoryCounts)) {
    if (count > 0) {
      lines.push(`| ${formatCategory(cat as LeakCategoryString)} | ${count} |`);
    }
  }

  return lines.join('\n');
}

function formatCategory(category: LeakCategoryString): string {
  switch (category) {
    case 'EVENT_LISTENER':
      return 'Event Listener Leak';
    case 'UNBOUNDED_CACHE':
      return 'Unbounded Cache';
    case 'CLOSURE_CAPTURE':
      return 'Closure Capture';
    case 'GLOBAL_REFERENCE':
      return 'Global Reference';
    case 'TIMER_INTERVAL':
      return 'Timer/Interval Leak';
    case 'UNKNOWN':
      return 'Unknown';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function deduplicateEvidence(evidence: string[]): string[] {
  return [...new Set(evidence)];
}
