/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end demo: Detect a memory leak and generate a Perfetto trace.
 *
 * This script simulates a realistic server-side memory leak pattern:
 * a request handler that stores `RequestContext` objects in a session
 * map but never evicts expired entries.  Each context retains a payload
 * buffer through a closure, preventing garbage collection.
 *
 * Pipeline:
 *   1. Warm up with initial traffic to stabilize V8 internals.
 *   2. Capture baseline snapshot (A) after forced GC.
 *   3. Simulate traffic burst → leaked RequestContext instances.
 *   4. Capture post-action snapshot (B).
 *   5. Repeat traffic burst → more leaked instances.
 *   6. Capture final snapshot (C).
 *   7. Parse → diff → retainer chain extraction → Perfetto trace → LLM output.
 *
 * Run with: npx tsx src/demo.ts
 */

import { captureHeapSnapshot } from './capture/heap-snapshot-capture.js';
import { parseHeapSnapshotFull } from './parse/heap-snapshot-parser.js';
import { threeSnapshotDiff, formatDiffForLLM } from './analyze/three-snapshot-diff.js';
import { extractRetainerChainsForLeaks } from './analyze/retainer-chain-extractor.js';
import { diffResultToTrace, heapSummaryToTrace, mergeTraces, writeTrace } from './format/perfetto-formatter.js';
import { analyzeLeakDetection } from './bridge/llm-analysis-bridge.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Synthetic Leaky Application ───────────────────────────────────
//
// Pattern: HTTP-style request handler with a session store that
// accumulates RequestContext objects without TTL-based eviction.
// This is one of the most common memory leak patterns in Node.js
// servers (Express middleware state, socket.io rooms, etc.).

/**
 * Simulates a per-request context object.  Each instance retains a
 * response buffer through a closure — the same pattern that causes
 * leaks in Express middleware chains when `next()` captures `req`.
 *
 * V8 tracks these by constructor name, so the 3-snapshot diff will
 * report "RequestContext" growth directly.
 */
class RequestContext {
  readonly id: string;
  readonly timestamp: number;
  readonly headers: Record<string, string>;
  private responseBuffer: string;
  private onComplete: () => string;

  constructor(id: string) {
    this.id = id;
    this.timestamp = Date.now();
    this.headers = {
      'content-type': 'application/json',
      'x-request-id': id,
      'x-trace-id': `trace-${id}-${Math.random().toString(36).slice(2)}`,
    };
    // 2 KB payload per context — realistic for buffered response bodies.
    this.responseBuffer = 'x'.repeat(2048);
    // Closure captures `this`, preventing GC even if external refs are dropped.
    this.onComplete = () => this.responseBuffer;
  }

  /** Simulate reading the response (keeps the closure alive). */
  getResponse(): string {
    return this.onComplete();
  }
}

/**
 * Session store that never evicts entries — the root cause of the leak.
 * In production this would be a middleware cache, a connection pool that
 * grows without bounds, or an event listener registry.
 */
class SessionStore {
  private sessions = new Map<string, RequestContext>();

  add(ctx: RequestContext): void {
    this.sessions.set(ctx.id, ctx);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Global store — retained by the module scope, reachable from GC roots. */
const store = new SessionStore();

/**
 * Simulate a traffic burst: create N RequestContext instances and store
 * them in the session map.  None are ever removed.
 */
function simulateTraffic(count: number, startId: number): void {
  for (let i = 0; i < count; i++) {
    const ctx = new RequestContext(`req-${startId + i}`);
    store.add(ctx);
    // In a real server, `ctx.getResponse()` would be called and the
    // context should be disposed.  Here we intentionally skip cleanup.
  }
}

// ── Main Demo ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Gemini CLI Performance Companion — End-to-End Demo ===\n');

  const outputDir = join(tmpdir(), 'gemini-perf-demo');

  // ── Step 1: Warm up ─────────────────────────────────────────────
  // Pre-allocate V8 hidden classes and stabilize internal structures
  // so the diff only captures our application-level growth.
  console.log('Step 1: Warming up (50 requests to stabilize V8 internals)...');
  simulateTraffic(50, 0);
  console.log(`  → SessionStore size: ${store.size}`);

  // ── Step 2: Capture Snapshot A (baseline) ───────────────────────
  console.log('Step 2: Capturing baseline snapshot (A)...');
  const snapA = await captureHeapSnapshot({
    target: 'self',
    label: 'baseline',
    outputDir,
    forceGc: true,
  });
  console.log(`  → ${snapA.filePath}`);
  console.log(`  → Size: ${(snapA.sizeBytes / 1024).toFixed(0)} KB, Duration: ${snapA.durationMs}ms`);

  // ── Step 3: First traffic burst (leak) ──────────────────────────
  console.log('Step 3: Simulating traffic burst (200 requests, no eviction)...');
  simulateTraffic(200, 1000);
  console.log(`  → SessionStore size: ${store.size}`);

  // ── Step 4: Capture Snapshot B (post-action 1) ──────────────────
  console.log('Step 4: Capturing post-action snapshot (B)...');
  const snapB = await captureHeapSnapshot({
    target: 'self',
    label: 'post-burst-1',
    outputDir,
    forceGc: true,
  });

  // ── Step 5: Second traffic burst (leak continues) ───────────────
  console.log('Step 5: Second traffic burst (200 more requests)...');
  simulateTraffic(200, 2000);
  console.log(`  → SessionStore size: ${store.size}`);

  // ── Step 6: Capture Snapshot C (post-action 2) ──────────────────
  console.log('Step 6: Capturing final snapshot (C)...');
  const snapC = await captureHeapSnapshot({
    target: 'self',
    label: 'post-burst-2',
    outputDir,
    forceGc: true,
  });

  // ── Step 7: Parse all 3 snapshots ───────────────────────────────
  console.log('\nStep 7: Parsing all 3 snapshots...');
  const parsedA = await parseHeapSnapshotFull(snapA.filePath, { topN: 10 });
  const parsedB = await parseHeapSnapshotFull(snapB.filePath, { topN: 10 });
  const parsedC = await parseHeapSnapshotFull(snapC.filePath, { topN: 10 });

  console.log(`  A: ${parsedA.nodes.length} nodes, ${formatBytes(parsedA.summary.totalSize)}`);
  console.log(`  B: ${parsedB.nodes.length} nodes, ${formatBytes(parsedB.summary.totalSize)}`);
  console.log(`  C: ${parsedC.nodes.length} nodes, ${formatBytes(parsedC.summary.totalSize)}`);

  // ── Step 8: Three-snapshot diff ─────────────────────────────────
  console.log('\nStep 8: Running 3-snapshot diff...');
  const diff = threeSnapshotDiff(
    parsedA.nodes,
    parsedB.nodes,
    parsedC.nodes,
    parsedC.reverseGraph,
  );

  console.log(`  Leak candidates: ${diff.leakCandidates.length}`);
  console.log(`  Strong leak candidates: ${diff.strongLeakCandidates.length}`);
  console.log(`  Top leaking constructor: ${diff.summary.topLeakingConstructor}`);
  console.log(`  Retainer chains extracted: ${diff.retainerChains.length}`);

  // ── Step 9: Retainer chain extraction ───────────────────────────
  console.log('\nStep 9: Extracting detailed retainer chains...');
  const topConstructors = diff.strongLeakCandidates
    .slice(0, 5)
    .map((c) => c.constructor);

  const retainerChainsMap = extractRetainerChainsForLeaks(
    topConstructors,
    parsedC.nodes,
    parsedC.reverseGraph,
    { maxDepth: 10, maxChains: 5 },
  );

  console.log(`  Constructors with chains: ${retainerChainsMap.size}`);
  for (const [ctor, chains] of retainerChainsMap) {
    const avgDepth = Math.round(
      chains.reduce((sum, c) => sum + c.depth, 0) / chains.length,
    );
    console.log(`    ${ctor}: ${chains.length} chain(s), avg depth: ${avgDepth}`);
  }

  // ── Step 10: LLM-formatted output ──────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('LLM-FORMATTED OUTPUT (this goes into ToolResult.llmContent)');
  console.log('='.repeat(60));
  console.log(formatDiffForLLM(diff, retainerChainsMap));

  // ── Step 11: Perfetto trace generation ─────────────────────────
  console.log('\nStep 11: Generating Perfetto traces...');
  const summaryTrace = heapSummaryToTrace(
    parsedC.summary,
    'demo-final',
    snapC.timestamp * 1000,
  );
  const diffTrace = diffResultToTrace(diff, {
    a: snapA.timestamp * 1000,
    b: snapB.timestamp * 1000,
    c: snapC.timestamp * 1000,
  });
  const combinedTrace = mergeTraces(summaryTrace, diffTrace);

  const tracePath = join(outputDir, 'demo-trace.json');
  await writeTrace(combinedTrace, tracePath);
  console.log(`  → Perfetto trace: ${tracePath}`);
  console.log(`  → Events: ${combinedTrace.traceEvents.length}`);
  console.log(`  → Open at: https://ui.perfetto.dev/ (load the JSON file)`);

  // ── Step 12: Full analysis bridge output ───────────────────────
  console.log('\nStep 12: Generating complete analysis...');
  const analysis = analyzeLeakDetection(diff, retainerChainsMap, combinedTrace);
  console.log(`\n${analysis.markdownReport}`);

  if (analysis.suggestions.length > 0) {
    console.log('\n### Suggestions:');
    for (const s of analysis.suggestions) {
      console.log(`  - ${s}`);
    }
  }

  console.log(`\n### Summary (one-liner for ToolResult):`);
  console.log(`  ${analysis.summary}`);

  console.log('\n=== Demo complete ===');
  console.log(`\nOutput directory: ${outputDir}`);
}

/** Format bytes for human-readable display. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

main().catch(console.error);
