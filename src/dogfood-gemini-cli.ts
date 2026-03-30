/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dogfood: Profile Gemini CLI's own startup and module loading.
 *
 * This script launches gemini-cli's entry point with `--inspect=9230`,
 * captures two heap snapshots during startup, and runs a full analysis
 * pipeline.  The goal is to demonstrate the tool working against its
 * own intended target — not a toy leak, but the real Gemini CLI process.
 *
 * Architecture:
 *
 *   ┌─────────────────────┐    CDP / WebSocket    ┌─────────────────────┐
 *   │  perf-companion      │ ◄──────────────────► │  gemini-cli process  │
 *   │  (this script)       │  HeapProfiler.take..  │  --inspect=9230      │
 *   └─────────────────────┘                        └─────────────────────┘
 *
 * Run with: npx tsx src/dogfood-gemini-cli.ts
 *
 * Note: This captures a snapshot of gemini-cli's startup heap.
 * No API key or interactive session is required — the process is
 * profiled during module loading, which is where initialization-time
 * memory issues (e.g., large static registries, eager caching)
 * are detectable.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import * as http from 'node:http';

import { CdpClient } from './capture/cdp-client.js';
import { parseHeapSnapshotStreaming } from './parse/streaming-snapshot-parser.js';
import { heapSummaryToTrace, writeTrace } from './format/perfetto-formatter.js';
import { analyzeHeapSummary } from './bridge/llm-analysis-bridge.js';
import { validateConnectionTarget, validateCdpMethod, scanForSensitiveData } from './security/connection-validator.js';
import { formatBytes } from './utils.js';

// ─── Configuration ──────────────────────────────────────────────────

const INSPECT_PORT = 9230;
const INSPECT_HOST = '127.0.0.1';
const OUTPUT_DIR = join(tmpdir(), 'gemini-perf-dogfood');

/** Path to the gemini-cli entry point relative to this repo. */
const GEMINI_CLI_ENTRY = join(
  import.meta.dirname,
  '..', '..', 'gemini-cli', 'packages', 'cli', 'dist', 'index.js',
);

// ─── Helper Functions ───────────────────────────────────────────────

async function waitForInspector(
  host: string,
  port: number,
  maxRetries: number = 30,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await httpGet(`http://${host}:${port}/json/version`);
      return;
    } catch {
      const delay = Math.min(200 * attempt, 2000);
      await sleep(delay);
    }
  }
  throw new Error(
    `Inspector at ${host}:${port} did not respond after ${maxRetries} attempts`,
  );
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function captureRemoteSnapshot(
  client: CdpClient,
  label: string,
  outputDir: string,
  forceGc: boolean = true,
): Promise<{ filePath: string; sizeBytes: number; durationMs: number }> {
  const startTime = performance.now();

  validateCdpMethod('HeapProfiler.enable');
  await client.send('HeapProfiler.enable');

  if (forceGc) {
    validateCdpMethod('HeapProfiler.collectGarbage');
    await client.send('HeapProfiler.collectGarbage');
  }

  const chunks: string[] = [];
  client.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
    const p = params as { chunk: string };
    chunks.push(p.chunk);
  });

  validateCdpMethod('HeapProfiler.takeHeapSnapshot');
  await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });

  validateCdpMethod('HeapProfiler.disable');
  await client.send('HeapProfiler.disable');

  client.removeAllListeners('HeapProfiler.addHeapSnapshotChunk');

  const content = chunks.join('');
  const filePath = join(outputDir, `${label}.heapsnapshot`);
  await writeFile(filePath, content, 'utf-8');

  const durationMs = Math.round(performance.now() - startTime);
  const sizeBytes = Buffer.byteLength(content, 'utf-8');

  return { filePath, sizeBytes, durationMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Gemini CLI Performance Companion — Dogfood Analysis      ║');
  console.log('║  Target: gemini-cli (the tool this project is built for)  ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  await mkdir(OUTPUT_DIR, { recursive: true });

  // ── Security validation ────────────────────────────────────────────
  console.log('Step 0: Validating connection security...');
  validateConnectionTarget(INSPECT_HOST, INSPECT_PORT);
  console.log(`  ✓ Target ${INSPECT_HOST}:${INSPECT_PORT} passes security checks\n`);

  // ── Step 1: Launch gemini-cli with --inspect ───────────────────────
  console.log('Step 1: Launching gemini-cli with --inspect...');
  console.log(`  Entry: ${GEMINI_CLI_ENTRY}`);

  const geminiProcess = spawn('node', [
    `--inspect=${INSPECT_PORT}`,
    '--inspect-publish-uid=http',
    GEMINI_CLI_ENTRY,
    '--version',  // Use --version: quick exit, but still loads the full module graph
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  // Capture gemini-cli stdout/stderr for reference.
  let geminiStdout = '';
  let geminiStderr = '';
  geminiProcess.stdout?.on('data', (d: Buffer) => { geminiStdout += d.toString(); });
  geminiProcess.stderr?.on('data', (d: Buffer) => { geminiStderr += d.toString(); });

  try {
    // Wait for the inspector to be fully ready.
    console.log('  Waiting for V8 inspector...');
    await waitForInspector(INSPECT_HOST, INSPECT_PORT);
    console.log('  ✓ Inspector ready\n');

    // ── Step 2: Connect CDP client ─────────────────────────────────
    console.log('Step 2: Connecting CDP client via WebSocket...');
    const client = new CdpClient();
    await client.connect({ host: INSPECT_HOST, port: INSPECT_PORT, timeoutMs: 10_000 });
    console.log('  ✓ Connected to gemini-cli\'s V8 isolate\n');

    // ── Step 3: Capture snapshot (post-startup) ────────────────────
    // The process has loaded all modules by now. This captures the
    // full memory state of gemini-cli after module initialization.
    console.log('Step 3: Allowing gemini-cli to complete startup (1.5s)...');
    await sleep(1500);

    console.log('Step 4: Capturing heap snapshot via CDP...');
    const snap = await captureRemoteSnapshot(client, 'gemini-cli-startup', OUTPUT_DIR);
    console.log(`  → ${snap.filePath}`);
    console.log(`  → Size: ${formatBytes(snap.sizeBytes)}, Capture: ${snap.durationMs}ms\n`);

    // ── Disconnect CDP ──────────────────────────────────────────────
    await client.disconnect();
    console.log('Step 5: CDP client disconnected.\n');

    // ── Parse snapshot (streaming parser for 89MB+ files) ───────────
    console.log('Step 6: Parsing gemini-cli heap snapshot (streaming parser)...');
    const startParse = performance.now();
    const parsed = await parseHeapSnapshotStreaming(snap.filePath, {
      onProgress: (bytes, total) => {
        const pct = ((bytes / total) * 100).toFixed(0);
        process.stdout.write(`\r  Parsing: ${pct}% (${formatBytes(bytes)} / ${formatBytes(total)})`);
      },
    });
    const parseMs = Math.round(performance.now() - startParse);
    console.log(`\n  → ${parsed.nodes.length.toLocaleString()} nodes, ${parsed.edges.length.toLocaleString()} edges`);
    console.log(`  → ${parsed.strings.length.toLocaleString()} strings, ${formatBytes(parsed.summary.totalSize)} total heap`);
    console.log(`  → Parse time: ${parseMs}ms (streaming, ${formatBytes(snap.sizeBytes)} input)\n`);

    // ── Sensitive data scan ──────────────────────────────────────────
    console.log('Step 7: Scanning for sensitive data in gemini-cli heap...');
    const sensitiveReport = scanForSensitiveData(parsed.strings);
    if (sensitiveReport.hasSensitiveData) {
      console.log(`  ⚠ Found ${sensitiveReport.flaggedCount} potentially sensitive strings:`);
      for (const [label, count] of sensitiveReport.findings) {
        console.log(`    ${label}: ${count}`);
      }
    } else {
      console.log('  ✓ No sensitive data detected in string table.');
    }
    console.log();

    // ── Heap summary analysis ────────────────────────────────────────
    console.log('═'.repeat(60));
    console.log('GEMINI-CLI STARTUP HEAP ANALYSIS');
    console.log('═'.repeat(60));

    const summaryAnalysis = analyzeHeapSummary(parsed.summary);
    console.log(summaryAnalysis.markdownReport);

    if (summaryAnalysis.suggestions.length > 0) {
      console.log('\n### Suggestions:');
      for (const s of summaryAnalysis.suggestions) {
        console.log(`  → ${s}`);
      }
    }

    console.log(`\n### Summary: ${summaryAnalysis.summary}`);

    // ── Perfetto trace ───────────────────────────────────────────────
    console.log('\nStep 8: Generating Perfetto trace...');
    const now = Date.now() * 1000;
    const summaryTrace = heapSummaryToTrace(parsed.summary, 'gemini-cli-startup', now);
    const tracePath = join(OUTPUT_DIR, 'gemini-cli-dogfood-trace.json');
    await writeTrace(summaryTrace, tracePath);
    console.log(`  → ${tracePath} (${summaryTrace.traceEvents.length} events)`);
    console.log('  → Open at: https://ui.perfetto.dev/');

    // ── Gemini-cli output reference ──────────────────────────────────
    if (geminiStdout.trim()) {
      console.log('\n--- gemini-cli stdout ---');
      console.log(geminiStdout.slice(0, 300));
    }

  } finally {
    // ── Cleanup ─────────────────────────────────────────────────────
    geminiProcess.kill('SIGTERM');
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  Dogfood analysis complete.                               ║');
    console.log(`║  Output: ${OUTPUT_DIR.slice(0, 48).padEnd(48)} ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');
  }
}

main().catch((err) => {
  console.error('Dogfood failed:', err);
  process.exit(1);
});
