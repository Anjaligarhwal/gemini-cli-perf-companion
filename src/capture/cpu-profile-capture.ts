/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CPU profile capture using the Node.js Inspector API.
 *
 * Uses the `Profiler` domain of the V8 Inspector protocol to record
 * a CPU sampling profile of the current process.  The profiler runs
 * at a configurable sampling interval (default: 1000 μs = 1 ms) and
 * writes the result as a standard `.cpuprofile` JSON file.
 *
 * Usage:
 * ```ts
 * const result = await captureCpuProfile({
 *   durationMs: 5000,
 *   label: 'startup',
 * });
 * // result.filePath → /tmp/gemini-perf/startup.cpuprofile
 * ```
 *
 * Limitations:
 *   - Only supports in-process profiling (`target: 'self'`).
 *   - Remote CDP profiling is left as a TODO for the GSoC implementation.
 */

import { Session } from 'node:inspector/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';

import type { CaptureResult } from '../types.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';

// ─── Configuration ───────────────────────────────────────────────────

/** Options for CPU profile capture. */
export interface CpuCaptureOptions {
  /** Profiling duration in milliseconds. @defaultValue 5000 */
  durationMs?: number;
  /** V8 sampling interval in microseconds. @defaultValue 1000 (1 ms) */
  samplingIntervalUs?: number;
  /** Human-readable label for the output file. @defaultValue `cpu-profile-{timestamp}` */
  label?: string;
  /** Output directory for the `.cpuprofile` file. @defaultValue `{tmpdir}/gemini-perf` */
  outputDir?: string;
  /** Maximum file size to prevent disk exhaustion. @defaultValue 104_857_600 (100 MB) */
  maxOutputBytes?: number;
}

/** Default profiling duration: 5 seconds. */
const DEFAULT_DURATION_MS = 5000;

/** Default V8 sampling interval: 1000 μs (1 ms). */
const DEFAULT_SAMPLING_INTERVAL_US = 1000;

/** Default maximum output file size: 100 MB. */
const DEFAULT_MAX_OUTPUT_BYTES = 104_857_600;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Capture a CPU profile from the current Node.js process.
 *
 * Opens an Inspector session, starts the V8 profiler, waits for the
 * specified duration, stops profiling, and writes the result to disk.
 *
 * @param options - Capture configuration.
 * @returns Capture result with file path, size, and timing.
 * @throws {PerfCompanionError} On profiler failure or output limit exceeded.
 */
export async function captureCpuProfile(
  options?: CpuCaptureOptions,
): Promise<CaptureResult> {
  const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS;
  const samplingInterval = options?.samplingIntervalUs ?? DEFAULT_SAMPLING_INTERVAL_US;
  const label = options?.label ?? `cpu-profile-${Date.now()}`;
  const outputDir = options?.outputDir ?? join(tmpdir(), 'gemini-perf');
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, `${label}.cpuprofile`);

  const startTime = performance.now();

  const session = new Session();
  session.connect();

  try {
    // Enable the Profiler domain.
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', {
      interval: samplingInterval,
    });

    // Start profiling.
    await session.post('Profiler.start');

    // Wait for the specified duration.
    await sleep(durationMs);

    // Stop profiling and retrieve the result.
    const result = await session.post('Profiler.stop');
    const profile = (result as unknown as { profile: Record<string, unknown> }).profile;

    // Serialize and validate output size.
    const json = JSON.stringify(profile);
    const sizeBytes = Buffer.byteLength(json, 'utf-8');

    if (sizeBytes > maxOutputBytes) {
      throw new PerfCompanionError(
        `CPU profile output (${formatBytes(sizeBytes)}) exceeds ` +
          `${formatBytes(maxOutputBytes)} limit`,
        PerfErrorCode.SNAPSHOT_TOO_LARGE,
        /* recoverable= */ true,
      );
    }

    await writeFile(filePath, json, 'utf-8');

    // Disable the profiler domain.
    await session.post('Profiler.disable');

    const durationActual = Math.round(performance.now() - startTime);

    return {
      filePath,
      sizeBytes,
      durationMs: durationActual,
      label,
      timestamp: Date.now(),
    };
  } catch (err) {
    if (err instanceof PerfCompanionError) throw err;

    const message = err instanceof Error ? err.message : String(err);
    throw new PerfCompanionError(
      `CPU profiler failed: ${message}`,
      PerfErrorCode.PROFILER_NOT_AVAILABLE,
      /* recoverable= */ true,
    );
  } finally {
    session.disconnect();
  }
}

// ─── Private Helpers ─────────────────────────────────────────────────

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format bytes for error messages. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
