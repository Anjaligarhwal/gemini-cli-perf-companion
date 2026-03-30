/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * External process profiling demo.
 *
 * Demonstrates the core differentiator of this tool: profiling a process
 * that the user is *not* running inside of.  This is the workflow that
 * gemini-cli's agent would use — the CLI process connects to the user's
 * application via CDP and captures diagnostics remotely.
 *
 * Architecture:
 *
 *   ┌──────────────┐      CDP / WebSocket      ┌──────────────────┐
 *   │  This script  │ ◄──────────────────────► │  Leaky server     │
 *   │  (profiler)   │    HeapProfiler.take...   │  (child process)  │
 *   │               │                           │  --inspect=9230   │
 *   └──────────────┘                            └──────────────────┘
 *
 * Pipeline:
 *   1. Spawn a child Node.js process with `--inspect=9230`.
 *   2. Wait for the debugger to bind (poll `/json/version`).
 *   3. Connect our CdpClient.
 *   4. Trigger traffic → capture snapshot A.
 *   5. Trigger traffic → capture snapshot B.
 *   6. Trigger traffic → capture snapshot C.
 *   7. Parse → diff → retainer chains → Perfetto → LLM output.
 *   8. Kill the child process.
 *
 * Run with: npx tsx src/demo-external.ts
 */

import { fork } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import * as http from 'node:http';

import { CdpClient } from './capture/cdp-client.js';
import { parseHeapSnapshotStreaming } from './parse/streaming-snapshot-parser.js';
import { threeSnapshotDiff, formatDiffForLLM } from './analyze/three-snapshot-diff.js';
import { extractRetainerChainsForLeaks } from './analyze/retainer-chain-extractor.js';
import { diffResultToTrace, heapSummaryToTrace, mergeTraces, writeTrace } from './format/perfetto-formatter.js';
import { analyzeLeakDetection } from './bridge/llm-analysis-bridge.js';
import { validateConnectionTarget, validateCdpMethod, scanForSensitiveData } from './security/connection-validator.js';
import { formatBytes } from './utils.js';

// ─── Configuration ──────────────────────────────────────────────────

const INSPECT_PORT = 9230;
const INSPECT_HOST = '127.0.0.1';
const OUTPUT_DIR = join(tmpdir(), 'gemini-perf-external-demo');
// ─── Leaky Server Script ────────────────────────────────────────────

/**
 * Inline script for the child process.
 *
 * A minimal HTTP server with a classic memory leak: request contexts
 * are stored in a Map and never evicted.  The server accepts POST
 * requests to `/traffic` to trigger allocation bursts, and GET to
 * `/status` to report current state.
 */
const LEAKY_SERVER_SCRIPT = `
'use strict';

const http = require('node:http');

class RequestContext {
  constructor(id) {
    this.id = id;
    this.timestamp = Date.now();
    this.payload = Buffer.alloc(2048, 0x41);
    this.headers = { 'x-request-id': id };
  }
}

const sessions = new Map();
let requestCounter = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/traffic' && req.method === 'POST') {
    const count = 150;
    for (let i = 0; i < count; i++) {
      const id = 'req-' + (requestCounter++);
      sessions.set(id, new RequestContext(id));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ added: count, total: sessions.size }));
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: sessions.size, requests: requestCounter }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  // Signal the parent that we're ready.
  process.send({ type: 'ready', port: addr.port });
});
`;

// ─── Helper Functions ───────────────────────────────────────────────

/**
 * Wait for the V8 inspector to bind on the target port.
 *
 * Polls `/json/version` until it responds, with exponential backoff.
 * This is necessary because `--inspect` binds asynchronously — the
 * child process may report "ready" before the debugger socket is open.
 */
async function waitForInspector(
  host: string,
  port: number,
  maxRetries: number = 20,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await httpGet(`http://${host}:${port}/json/version`);
      return;
    } catch {
      const delay = Math.min(100 * attempt, 1000);
      await sleep(delay);
    }
  }
  throw new Error(
    `Inspector at ${host}:${port} did not respond after ${maxRetries} attempts`,
  );
}

/** Minimal HTTP GET returning the response body. */
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

/** Trigger a traffic burst on the leaky server. */
async function triggerTraffic(serverPort: number): Promise<{ added: number; total: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: serverPort,
        path: '/traffic',
        method: 'POST',
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          resolve(JSON.parse(body) as { added: number; total: number });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Capture a heap snapshot from a remote process via CDP.
 *
 * Validates connection target and CDP methods via the security model
 * before issuing any commands.
 */
async function captureRemoteSnapshot(
  client: CdpClient,
  label: string,
  outputDir: string,
  forceGc: boolean = true,
): Promise<{ filePath: string; sizeBytes: number; durationMs: number }> {
  const startTime = performance.now();

  // Security: validate every CDP method before sending.
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

  // Remove the listener to avoid accumulating across captures.
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
  console.log('=== External Process Profiling Demo ===\n');

  await mkdir(OUTPUT_DIR, { recursive: true });

  // ── Security validation ────────────────────────────────────────────
  console.log('Step 0: Validating connection security...');
  validateConnectionTarget(INSPECT_HOST, INSPECT_PORT);
  console.log(`  ✓ Target ${INSPECT_HOST}:${INSPECT_PORT} passes loopback and port checks\n`);

  // ── Step 1: Spawn leaky server ─────────────────────────────────────
  console.log('Step 1: Spawning leaky server with --inspect...');

  // Write the server script to a temp file (fork requires a file path).
  const scriptPath = join(OUTPUT_DIR, '_leaky-server.cjs');
  await writeFile(scriptPath, LEAKY_SERVER_SCRIPT, 'utf-8');

  const child = fork(scriptPath, [], {
    execArgv: [`--inspect=${INSPECT_PORT}`],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  // Suppress child stderr (V8 inspector binding messages).
  child.stderr?.resume();
  child.stdout?.resume();

  // Wait for the child to signal it's listening.
  const serverPort = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child did not start')), 10_000);
    child.on('message', (msg: { type: string; port: number }) => {
      if (msg.type === 'ready') {
        clearTimeout(timeout);
        resolve(msg.port);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  console.log(`  → Server listening on port ${serverPort}`);
  console.log(`  → Inspector on ${INSPECT_HOST}:${INSPECT_PORT}`);

  // Wait for the inspector to be fully ready.
  await waitForInspector(INSPECT_HOST, INSPECT_PORT);
  console.log('  → Inspector ready\n');

  try {
    // ── Step 2: Connect CDP client ─────────────────────────────────
    console.log('Step 2: Connecting CDP client...');
    const client = new CdpClient();
    await client.connect({ host: INSPECT_HOST, port: INSPECT_PORT, timeoutMs: 5000 });
    console.log('  → Connected via WebSocket\n');

    // ── Step 3: Warm up + baseline snapshot ────────────────────────
    console.log('Step 3: Warming up server (initial traffic burst)...');
    const warmup = await triggerTraffic(serverPort);
    console.log(`  → Sessions: ${warmup.total}`);

    // Allow V8 to stabilize.
    await sleep(500);

    console.log('Step 4: Capturing baseline snapshot (A) via CDP...');
    const snapA = await captureRemoteSnapshot(client, 'external-baseline', OUTPUT_DIR);
    console.log(`  → ${snapA.filePath}`);
    console.log(`  → Size: ${formatBytes(snapA.sizeBytes)}, Duration: ${snapA.durationMs}ms\n`);

    // ── Step 5: First leak burst + snapshot B ──────────────────────
    console.log('Step 5: Traffic burst #1...');
    const burst1 = await triggerTraffic(serverPort);
    console.log(`  → Sessions: ${burst1.total}`);
    await sleep(500);

    console.log('Step 6: Capturing post-action snapshot (B) via CDP...');
    const snapB = await captureRemoteSnapshot(client, 'external-post-1', OUTPUT_DIR);
    console.log(`  → Size: ${formatBytes(snapB.sizeBytes)}, Duration: ${snapB.durationMs}ms\n`);

    // ── Step 7: Second leak burst + snapshot C ─────────────────────
    console.log('Step 7: Traffic burst #2...');
    const burst2 = await triggerTraffic(serverPort);
    console.log(`  → Sessions: ${burst2.total}`);
    await sleep(500);

    console.log('Step 8: Capturing final snapshot (C) via CDP...');
    const snapC = await captureRemoteSnapshot(client, 'external-post-2', OUTPUT_DIR);
    console.log(`  → Size: ${formatBytes(snapC.sizeBytes)}, Duration: ${snapC.durationMs}ms\n`);

    // ── Step 9: Disconnect CDP ─────────────────────────────────────
    await client.disconnect();
    console.log('Step 9: CDP client disconnected.\n');

    // ── Step 10: Parse snapshots (demonstrate streaming parser) ────
    console.log('Step 10: Parsing snapshots (streaming parser)...');
    const parsedA = await parseHeapSnapshotStreaming(snapA.filePath);
    const parsedB = await parseHeapSnapshotStreaming(snapB.filePath);
    const parsedC = await parseHeapSnapshotStreaming(snapC.filePath);

    console.log(`  A: ${parsedA.nodes.length.toLocaleString()} nodes, ${formatBytes(parsedA.summary.totalSize)}`);
    console.log(`  B: ${parsedB.nodes.length.toLocaleString()} nodes, ${formatBytes(parsedB.summary.totalSize)}`);
    console.log(`  C: ${parsedC.nodes.length.toLocaleString()} nodes, ${formatBytes(parsedC.summary.totalSize)}\n`);

    // ── Step 11: Sensitive data scan ───────────────────────────────
    console.log('Step 11: Scanning for sensitive data in snapshot strings...');
    const sensitiveReport = scanForSensitiveData(parsedC.strings);
    if (sensitiveReport.hasSensitiveData) {
      console.log(`  ⚠ Found ${sensitiveReport.flaggedCount} potentially sensitive strings:`);
      for (const [label, count] of sensitiveReport.findings) {
        console.log(`    ${label}: ${count}`);
      }
    } else {
      console.log('  ✓ No sensitive data detected in string table.');
    }
    console.log();

    // ── Step 12: Three-snapshot diff ───────────────────────────────
    console.log('Step 12: Running 3-snapshot diff...');
    const diff = threeSnapshotDiff(
      parsedA.nodes,
      parsedB.nodes,
      parsedC.nodes,
      parsedC.reverseGraph,
    );

    console.log(`  Leak candidates: ${diff.leakCandidates.length}`);
    console.log(`  Strong leak candidates: ${diff.strongLeakCandidates.length}`);
    console.log(`  Top leaking constructor: ${diff.summary.topLeakingConstructor}`);
    console.log(`  Retainer chains: ${diff.retainerChains.length}\n`);

    // ── Step 13: Detailed retainer chains ──────────────────────────
    console.log('Step 13: Extracting detailed retainer chains...');
    const topConstructors = diff.strongLeakCandidates
      .slice(0, 5)
      .map((c) => c.constructor);

    const retainerChainsMap = extractRetainerChainsForLeaks(
      topConstructors,
      parsedC.nodes,
      parsedC.reverseGraph,
      { maxDepth: 10, maxChains: 5 },
    );

    for (const [ctor, chains] of retainerChainsMap) {
      console.log(`  ${ctor}: ${chains.length} chain(s)`);
      if (chains.length > 0) {
        const chain = chains[0];
        const path = chain.nodes.map((n) => n.name).join(' ← ');
        console.log(`    Shortest: ${path}`);
        console.log(`    Depth: ${chain.depth}, Retained: ${formatBytes(chain.totalRetainedSize)}`);
      }
    }
    console.log();

    // ── Step 14: LLM output ────────────────────────────────────────
    console.log('='.repeat(60));
    console.log('LLM-FORMATTED OUTPUT (ToolResult.llmContent)');
    console.log('='.repeat(60));
    const llmOutput = formatDiffForLLM(diff, retainerChainsMap);
    console.log(llmOutput);
    console.log(`\n[llmContent size: ${llmOutput.length} bytes]\n`);

    // ── Step 15: Perfetto trace ────────────────────────────────────
    console.log('Step 15: Generating Perfetto trace...');
    const now = Date.now() * 1000;
    const summaryTrace = heapSummaryToTrace(parsedC.summary, 'external-final', now);
    const diffTrace = diffResultToTrace(diff, {
      a: now, b: now + 1_000_000, c: now + 2_000_000,
    });
    const combined = mergeTraces(summaryTrace, diffTrace);
    const tracePath = join(OUTPUT_DIR, 'external-demo-trace.json');
    await writeTrace(combined, tracePath);
    console.log(`  → ${tracePath} (${combined.traceEvents.length} events)`);
    console.log('  → Open at: https://ui.perfetto.dev/\n');

    // ── Step 16: Full analysis ─────────────────────────────────────
    const analysis = analyzeLeakDetection(diff, retainerChainsMap, combined);
    console.log(analysis.markdownReport);
    console.log('\nSuggestions:');
    for (const s of analysis.suggestions) {
      console.log(`  → ${s}`);
    }
    console.log(`\nSummary: ${analysis.summary}`);

  } finally {
    // ── Cleanup: kill the child process ────────────────────────────
    child.kill('SIGTERM');
    console.log('\n=== Demo complete. Child process terminated. ===');
    console.log(`Output directory: ${OUTPUT_DIR}`);
  }
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
