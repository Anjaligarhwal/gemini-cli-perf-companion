/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Heap snapshot capture using the Node.js Inspector API.
 *
 * Two modes:
 *   - `self`:   Captures from the current process via `node:inspector`.
 *   - `remote`: Connects to an external `--inspect` process via CDP
 *               WebSocket using the zero-dependency {@link CdpClient}.
 *
 * The inspector session is lazily connected and properly disposed in a
 * `finally` block to prevent resource leaks even on timeout or error.
 *
 * Capture workflow (both modes):
 *   1. Connect to the V8 isolate (in-process or via WebSocket).
 *   2. Optionally force GC (`HeapProfiler.collectGarbage`).
 *   3. Take heap snapshot via `HeapProfiler.takeHeapSnapshot`.
 *   4. Stream snapshot chunks to a string, then write to disk.
 *   5. Disconnect.
 *
 * The 3-snapshot workflow is exposed via `captureThreeSnapshots()`.
 */

import { Session } from 'node:inspector/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';

import type { CaptureOptions, CaptureResult } from '../types.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';
import { CdpClient } from './cdp-client.js';

// ─── Constants ───────────────────────────────────────────────────────

/** Default capture timeout: 30 seconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default output directory under the system temp folder. */
const DEFAULT_OUTPUT_DIR = join(tmpdir(), 'gemini-perf');

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Capture a V8 heap snapshot.
 *
 * Supports two modes:
 *   - `self`:   In-process capture via `node:inspector` (default).
 *   - `remote`: Connect to an external `node --inspect` process via
 *               CDP WebSocket.  Requires `host` and `port` options.
 *
 * @param options - Capture configuration.
 * @returns Capture result with file path, size, and timing.
 * @throws {PerfCompanionError} On timeout, connection failure, or
 *   inspector error.
 */
export async function captureHeapSnapshot(
  options: CaptureOptions = { target: 'self' },
): Promise<CaptureResult> {
  const label = options.label ?? `snapshot-${Date.now()}`;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, `${label}.heapsnapshot`);

  if (options.target === 'remote') {
    return captureRemote(options, filePath, label, timeoutMs);
  }

  return captureSelf(options, filePath, label, timeoutMs);
}

// ─── Self-Capture (in-process) ──────────────────────────────────────

/**
 * Capture from the current process using `node:inspector/promises`.
 */
async function captureSelf(
  options: CaptureOptions,
  filePath: string,
  label: string,
  timeoutMs: number,
): Promise<CaptureResult> {
  const forceGc = options.forceGc ?? true;
  const startTime = performance.now();
  const session = new Session();
  session.connect();

  try {
    if (forceGc) {
      await session.post('HeapProfiler.collectGarbage');
    }

    const chunks: string[] = [];
    session.on('HeapProfiler.addHeapSnapshotChunk', (message) => {
      chunks.push((message as { params: { chunk: string } }).params.chunk);
    });

    const { promise: timeoutPromise, cancel: cancelTimeout } = createTimeout(timeoutMs);
    try {
      await Promise.race([
        session.post('HeapProfiler.takeHeapSnapshot', { reportProgress: false }),
        timeoutPromise,
      ]);
    } finally {
      cancelTimeout();
    }

    const content = chunks.join('');
    await writeFile(filePath, content, 'utf-8');

    const durationMs = Math.round(performance.now() - startTime);
    const sizeBytes = Buffer.byteLength(content, 'utf-8');

    return { filePath, sizeBytes, durationMs, label, timestamp: Date.now() };
  } catch (err) {
    if (err instanceof PerfCompanionError) throw err;

    const message = err instanceof Error ? err.message : String(err);
    throw new PerfCompanionError(
      `Heap snapshot capture failed: ${message}`,
      PerfErrorCode.CAPTURE_TIMEOUT,
      /* recoverable= */ true,
    );
  } finally {
    session.disconnect();
  }
}

// ─── Remote Capture (CDP WebSocket) ─────────────────────────────────

/**
 * Capture from an external `node --inspect` process via CDP.
 *
 * Connects to the target's debugger WebSocket, issues the same
 * HeapProfiler commands as the self-capture path, and streams
 * chunks back over WebSocket.
 *
 * Security: Only connects to localhost by default.  The CdpClient
 * validates the WebSocket URL before connecting.
 */
async function captureRemote(
  options: CaptureOptions,
  filePath: string,
  label: string,
  timeoutMs: number,
): Promise<CaptureResult> {
  const forceGc = options.forceGc ?? true;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9229;
  const startTime = performance.now();

  const client = new CdpClient();

  try {
    await client.connect({ host, port, timeoutMs });

    // Enable the HeapProfiler domain.
    await client.send('HeapProfiler.enable');

    if (forceGc) {
      await client.send('HeapProfiler.collectGarbage');
    }

    // Collect snapshot chunks streamed from the target process.
    const chunks: string[] = [];
    client.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
      const p = params as { chunk: string };
      chunks.push(p.chunk);
    });

    // Take the snapshot with a timeout guard.
    const { promise: timeoutPromise, cancel: cancelTimeout } = createTimeout(timeoutMs);
    try {
      await Promise.race([
        client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }),
        timeoutPromise,
      ]);
    } finally {
      cancelTimeout();
    }

    // Disable and disconnect.
    await client.send('HeapProfiler.disable');

    const content = chunks.join('');
    await writeFile(filePath, content, 'utf-8');

    const durationMs = Math.round(performance.now() - startTime);
    const sizeBytes = Buffer.byteLength(content, 'utf-8');

    return { filePath, sizeBytes, durationMs, label, timestamp: Date.now() };
  } catch (err) {
    if (err instanceof PerfCompanionError) throw err;

    const message = err instanceof Error ? err.message : String(err);
    throw new PerfCompanionError(
      `Remote heap snapshot capture failed (${host}:${port}): ${message}`,
      PerfErrorCode.INSPECTOR_CONNECT_FAILED,
      /* recoverable= */ true,
    );
  } finally {
    await client.disconnect();
  }
}

/**
 * Run the automated 3-snapshot capture workflow.
 *
 * Sequence: A (baseline) → action → B → action → C.
 * The caller provides a `triggerAction` callback that performs the
 * suspected leaking operation between captures.
 *
 * @param options       - Capture configuration.
 * @param triggerAction - Async callback performing the leaking operation.
 * @returns Tuple of three capture results [A, B, C].
 */
export async function captureThreeSnapshots(
  options: CaptureOptions & { readonly intervalMs?: number },
  triggerAction: () => Promise<void>,
): Promise<[CaptureResult, CaptureResult, CaptureResult]> {
  const intervalMs = options.intervalMs ?? 2000;
  const baseLabel = options.label ?? 'leak-detect';

  // Snapshot A: baseline.
  const snapshotA = await captureHeapSnapshot({
    ...options,
    label: `${baseLabel}-baseline`,
  });

  await sleep(intervalMs);
  await triggerAction();
  await sleep(intervalMs);

  // Snapshot B: post-action 1.
  const snapshotB = await captureHeapSnapshot({
    ...options,
    label: `${baseLabel}-post-action-1`,
  });

  await sleep(intervalMs);
  await triggerAction();
  await sleep(intervalMs);

  // Snapshot C: post-action 2.
  const snapshotC = await captureHeapSnapshot({
    ...options,
    label: `${baseLabel}-post-action-2`,
  });

  return [snapshotA, snapshotB, snapshotC];
}

// ─── Private Helpers ─────────────────────────────────────────────────

/**
 * Create a cancellable timeout that rejects after `ms` milliseconds.
 *
 * The caller MUST invoke `cancel()` when the guarded operation completes
 * (success or failure) to prevent the timer from leaking.  This avoids
 * keeping the Node.js event loop alive and suppresses unhandled rejection
 * warnings.
 */
function createTimeout(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PerfCompanionError(
        `Snapshot capture timed out after ${ms}ms`,
        PerfErrorCode.CAPTURE_TIMEOUT,
        /* recoverable= */ true,
      )),
      ms,
    );
  });
  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return { promise, cancel };
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
