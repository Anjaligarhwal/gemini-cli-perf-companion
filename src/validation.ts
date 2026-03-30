/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runtime input validation with zero external dependencies.
 *
 * Every validator returns `undefined` on success or a human-readable error
 * string on failure — matching gemini-cli's `validateToolParamValues()` convention.
 */

import type { AnalysisOptions, CaptureOptions } from './types.js';

/** Maximum file path length to prevent path traversal and OS-level errors. */
const MAX_PATH_LENGTH = 4096;

/**
 * Minimum port: 1024 (rejects privileged ports 1–1023).
 *
 * Aligns with the security module's `connection-validator.ts` which
 * rejects privileged ports to prevent connecting to system services.
 * Node.js inspector defaults to 9229.
 */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

const VALID_ANALYSIS_MODES = new Set(['summary', 'diff', 'leak-detect', 'growth']);
const VALID_OUTPUT_FORMATS = new Set(['markdown', 'json', 'perfetto']);
const VALID_CAPTURE_TARGETS = new Set(['self', 'remote']);

export function validateFilePath(
  path: unknown,
  label: string,
): string | undefined {
  if (typeof path !== 'string' || path.length === 0) {
    return `${label} must be a non-empty string`;
  }
  if (path.length > MAX_PATH_LENGTH) {
    return `${label} exceeds maximum path length of ${MAX_PATH_LENGTH}`;
  }
  return undefined;
}

export function validateSnapshotPath(path: unknown): string | undefined {
  const err = validateFilePath(path, 'Snapshot path');
  if (err !== undefined) return err;
  if (!(path as string).endsWith('.heapsnapshot')) {
    return 'Snapshot path must have .heapsnapshot extension';
  }
  return undefined;
}

export function validateCpuProfilePath(path: unknown): string | undefined {
  const err = validateFilePath(path, 'CPU profile path');
  if (err !== undefined) return err;
  if (!(path as string).endsWith('.cpuprofile')) {
    return 'CPU profile path must have .cpuprofile extension';
  }
  return undefined;
}

export function validatePositiveInteger(
  value: unknown,
  label: string,
): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return `${label} must be a positive integer`;
  }
  return undefined;
}

export function validateCaptureOptions(
  opts: Partial<CaptureOptions>,
): string | undefined {
  if (opts.target !== undefined && !VALID_CAPTURE_TARGETS.has(opts.target)) {
    return `target must be one of: ${[...VALID_CAPTURE_TARGETS].join(', ')}`;
  }
  if (opts.timeoutMs !== undefined) {
    const err = validatePositiveInteger(opts.timeoutMs, 'timeoutMs');
    if (err !== undefined) return err;
  }
  if (opts.port !== undefined) {
    if (
      typeof opts.port !== 'number' ||
      !Number.isInteger(opts.port) ||
      opts.port < MIN_PORT ||
      opts.port > MAX_PORT
    ) {
      return `port must be an integer between ${MIN_PORT} and ${MAX_PORT}`;
    }
  }
  if (opts.outputDir !== undefined) {
    const err = validateFilePath(opts.outputDir, 'outputDir');
    if (err !== undefined) return err;
  }
  return undefined;
}

export function validateAnalysisOptions(
  opts: Partial<AnalysisOptions>,
): string | undefined {
  if (opts.mode !== undefined && !VALID_ANALYSIS_MODES.has(opts.mode)) {
    return `mode must be one of: ${[...VALID_ANALYSIS_MODES].join(', ')}`;
  }
  if (opts.topN !== undefined) {
    const err = validatePositiveInteger(opts.topN, 'topN');
    if (err !== undefined) return err;
  }
  if (opts.minSizeBytes !== undefined) {
    if (typeof opts.minSizeBytes !== 'number' || opts.minSizeBytes < 0) {
      return 'minSizeBytes must be a non-negative number';
    }
  }
  if (opts.outputFormat !== undefined && !VALID_OUTPUT_FORMATS.has(opts.outputFormat)) {
    return `outputFormat must be one of: ${[...VALID_OUTPUT_FORMATS].join(', ')}`;
  }
  return undefined;
}
