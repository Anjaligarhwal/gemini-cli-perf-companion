/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end demo: Detect a memory leak and generate a Perfetto trace.
 *
 * This script:
 *   1. Creates a synthetic leaky app (closure-based cache leak)
 *   2. Captures 3 heap snapshots using the Node.js Inspector API
 *   3. Parses all 3 with the streaming two-phase parser
 *   4. Runs 3-snapshot diff with noise filtering
 *   5. Extracts retainer chains via reverse-graph BFS
 *   6. Generates a Perfetto-compatible JSON trace
 *   7. Outputs LLM-formatted analysis
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

// ── Synthetic Leaky App ─────────────────────────────────────────────

/** Simulates a closure-based memory leak (common pattern in real apps). */
class LeakyCache {
  private cache: Map<number, { data: string; callback: () => string }> = new Map();
  private counter = 0;

  /** Each add creates a closure that captures `largePayload`, preventing GC. */
  add(): void {
    const largePayload = 'x'.repeat(1024); // 1 KB per entry
    const id = this.counter++;
    this.cache.set(id, {
      data: largePayload,
      callback: () => largePayload, // Closure retains the string
    });
  }

  get size(): number {
    return this.cache.size;
  }
}

// ── Main Demo ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Gemini CLI Performance Companion — End-to-End Demo ===\n');

  const outputDir = join(tmpdir(), 'gemini-perf-demo');
  const leak = new LeakyCache();

  // ── Step 1: Warm up ─────────────────────────────────────────────
  console.log('Step 1: Warming up (100 entries)...');
  for (let i = 0; i < 100; i++) leak.add();

  // ── Step 2: Capture Snapshot A (baseline) ───────────────────────
  console.log('Step 2: Capturing baseline snapshot (A)...');
  const snapA = await captureHeapSnapshot({
    target: 'self',
    label: 'demo-baseline',
    outputDir,
    forceGc: true,
  });
  console.log(`  → ${snapA.filePath} (${(snapA.sizeBytes / 1024).toFixed(0)} KB, ${snapA.durationMs}ms)`);

  // ── Step 3: Trigger leak ────────────────────────────────────────
  console.log('Step 3: Triggering leak (adding 500 entries)...');
  for (let i = 0; i < 500; i++) leak.add();

  // ── Step 4: Capture Snapshot B (post-action 1) ──────────────────
  console.log('Step 4: Capturing post-action snapshot (B)...');
  const snapB = await captureHeapSnapshot({
    target: 'self',
    label: 'demo-post-action-1',
    outputDir,
    forceGc: true,
  });

  // ── Step 5: Repeat leak ─────────────────────────────────────────
  console.log('Step 5: Repeating action (adding 500 more entries)...');
  for (let i = 0; i < 500; i++) leak.add();

  // ── Step 6: Capture Snapshot C (post-action 2) ──────────────────
  console.log('Step 6: Capturing final snapshot (C)...');
  const snapC = await captureHeapSnapshot({
    target: 'self',
    label: 'demo-post-action-2',
    outputDir,
    forceGc: true,
  });

  // ── Step 7: Parse all 3 snapshots with full structured output ───
  console.log('\nStep 7: Parsing all 3 snapshots...');
  const parsedA = await parseHeapSnapshotFull(snapA.filePath, { topN: 10 });
  const parsedB = await parseHeapSnapshotFull(snapB.filePath, { topN: 10 });
  const parsedC = await parseHeapSnapshotFull(snapC.filePath, { topN: 10 });

  console.log(`  A: ${parsedA.nodes.length} nodes, ${formatBytes(parsedA.summary.totalSize)}`);
  console.log(`  B: ${parsedB.nodes.length} nodes, ${formatBytes(parsedB.summary.totalSize)}`);
  console.log(`  C: ${parsedC.nodes.length} nodes, ${formatBytes(parsedC.summary.totalSize)}`);

  // ── Step 8: Run 3-snapshot diff with retainer chain extraction ──
  console.log('\nStep 8: Running 3-snapshot diff...');
  const diff = threeSnapshotDiff(
    parsedA.nodes,
    parsedB.nodes,
    parsedC.nodes,
    parsedC.reverseGraph, // Reverse graph from snapshot C for retainer chains
  );

  console.log(`  Leak candidates: ${diff.leakCandidates.length}`);
  console.log(`  Strong leak candidates: ${diff.strongLeakCandidates.length}`);
  console.log(`  Top leaking constructor: ${diff.summary.topLeakingConstructor}`);
  console.log(`  Retainer chains extracted: ${diff.retainerChains.length}`);

  // ── Step 9: Extract retainer chains for top strong candidates ───
  console.log('\nStep 9: Extracting detailed retainer chains...');
  const topConstructors = diff.strongLeakCandidates
    .slice(0, 5)
    .map((c) => c.constructor);

  const retainerChainsMap = extractRetainerChainsForLeaks(
    topConstructors,
    parsedC.nodes,
    parsedC.reverseGraph,
    { maxDepth: 10, maxChains: 3 },
  );

  console.log(`  Constructors with chains: ${retainerChainsMap.size}`);
  for (const [ctor, chains] of retainerChainsMap) {
    console.log(`    ${ctor}: ${chains.length} chain(s), avg depth: ${
      Math.round(chains.reduce((sum, c) => sum + c.depth, 0) / chains.length)
    }`);
  }

  // ── Step 10: Format for LLM consumption ─────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('LLM-FORMATTED OUTPUT (this goes into ToolResult.llmContent)');
  console.log('='.repeat(60));
  console.log(formatDiffForLLM(diff, retainerChainsMap));

  // ── Step 11: Generate Perfetto traces ───────────────────────────
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

  // ── Step 12: Full LLM analysis bridge output ────────────────────
  console.log('\nStep 12: Generating complete analysis...');
  const analysis = analyzeLeakDetection(diff, retainerChainsMap, combinedTrace);
  console.log(`\n${analysis.markdownReport}`);

  if (analysis.suggestions.length > 0) {
    console.log('\n### Suggestions:');
    for (const s of analysis.suggestions) {
      console.log(`  - ${s}`);
    }
  }

  console.log(`\n### Summary (one-liner for ToolResult):
  ${analysis.summary}`);

  console.log('\n=== Demo complete ===');
  console.log(`\nOutput directory: ${outputDir}`);
}

/** Format bytes for display. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

main().catch(console.error);
