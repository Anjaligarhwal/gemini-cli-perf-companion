/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared formatting utilities used across the perf-companion subsystem.
 *
 * Centralizes byte/time/path formatting so that every module produces
 * consistent human-readable output for both terminal display and LLM
 * context windows.
 *
 * @module
 */

/**
 * Format a byte count as a human-readable string.
 *
 * Uses binary units (KB = 1024, MB = 1048576) matching V8's own
 * reporting conventions in heap snapshots and DevTools.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Format a microsecond duration as a human-readable string.
 *
 * Automatically selects the most readable unit:
 *   - < 1 ms  → microseconds (μs)
 *   - < 1 s   → milliseconds (ms)
 *   - ≥ 1 s   → seconds (s)
 */
export function formatMicroseconds(us: number): string {
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

/**
 * Abbreviate a V8 script URL to just the filename.
 *
 * V8 CPU profiles record full file:// or absolute paths for each
 * call frame.  For LLM context and terminal display, the filename
 * alone is sufficient and conserves token budget.
 */
export function abbreviateScript(url: string): string {
  if (!url || url === '(native)') return url;
  const lastSlash = url.lastIndexOf('/');
  return lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
}
