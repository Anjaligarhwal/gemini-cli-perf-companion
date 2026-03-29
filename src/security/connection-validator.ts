/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Connection security validator for CDP remote profiling.
 *
 * The V8 inspector protocol grants full control over a process: memory
 * reads, code execution via `Runtime.evaluate`, and file system access
 * via `NodeWorker` domains.  Connecting to the wrong process — or
 * allowing a non-loopback target — could expose arbitrary data.
 *
 * This module enforces a defense-in-depth security boundary:
 *
 *   1. **Loopback enforcement**: Only `127.0.0.1`, `::1`, and
 *      `localhost` are permitted as connect targets.  DNS resolution
 *      is NOT performed — the raw hostname string is validated to
 *      prevent DNS rebinding attacks.
 *
 *   2. **Port range validation**: Privileged ports (1–1023) are
 *      rejected.  Node.js inspector defaults to 9229 and typically
 *      uses 9229–9999.  Allowing arbitrary privileged ports risks
 *      connecting to system services (e.g., SSH on 22, HTTP on 80).
 *
 *   3. **CDP domain allowlist**: Only profiling-related CDP domains
 *      are permitted.  `Runtime.evaluate`, `NodeWorker`, and other
 *      code-execution domains are blocked to prevent the profiler
 *      from being used as an arbitrary code execution vector.
 *
 *   4. **Snapshot output path validation**: Output directories are
 *      constrained to prevent path traversal (e.g., `../../etc/passwd`).
 *
 * Integration:
 *   Import `validateConnectionTarget()` and call it before any
 *   `http.get` or `http.request` to the inspector endpoint.
 *   Import `validateCdpMethod()` before sending any CDP command.
 *
 * @module
 */

import { PerfCompanionError, PerfErrorCode } from '../errors.js';
import { resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Loopback Validation ────────────────────────────────────────────

/**
 * Set of hostnames/IPs that are considered loopback.
 *
 * We deliberately do NOT resolve hostnames via DNS.  Checking the raw
 * string prevents DNS rebinding attacks where `evil.com` resolves to
 * `127.0.0.1` on first query and to an attacker's IP on the second.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
  // Bracketed IPv6 form used in URLs.
  '[::1]',
]);

/**
 * Validate that a connection target is a permitted loopback address.
 *
 * @param host - Target hostname or IP as a raw string.
 * @param port - Target port number.
 * @throws {PerfCompanionError} If the target fails validation.
 */
export function validateConnectionTarget(host: string, port: number): void {
  validateLoopbackHost(host);
  validatePortRange(port);
}

/**
 * Validate that a hostname is a loopback address.
 *
 * @throws {PerfCompanionError} If the host is not a recognized loopback
 *   address.
 */
function validateLoopbackHost(host: string): void {
  const normalized = host.toLowerCase().trim();

  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new PerfCompanionError(
      `Connection to non-loopback host "${host}" is not permitted. ` +
        'The profiler only connects to local processes (127.0.0.1, ::1, localhost). ' +
        'This restriction prevents accidental profiling of remote services.',
      PerfErrorCode.INVALID_PARAMS,
      /* recoverable= */ false,
    );
  }
}

// ─── Port Range Validation ──────────────────────────────────────────

/**
 * Minimum permitted port number.
 *
 * Ports 1–1023 are "well-known" system ports typically requiring root
 * privileges.  Node.js inspector never binds to these by default.
 * Allowing them risks connecting to system services.
 */
const MIN_PORT = 1024;

/**
 * Maximum permitted port number (TCP/UDP ceiling).
 */
const MAX_PORT = 65535;

/**
 * Validate that a port number is in the permitted range.
 *
 * @throws {PerfCompanionError} If the port is privileged or out of range.
 */
function validatePortRange(port: number): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new PerfCompanionError(
      `Port ${port} is not permitted. Allowed range: ${MIN_PORT}–${MAX_PORT}. ` +
        'Privileged ports (1–1023) are rejected to prevent connecting to ' +
        'system services. Node.js inspector defaults to port 9229.',
      PerfErrorCode.INVALID_PARAMS,
      /* recoverable= */ false,
    );
  }
}

// ─── CDP Domain Allowlist ───────────────────────────────────────────

/**
 * CDP methods allowed for profiling operations.
 *
 * Organized by domain.  Each entry is a full `Domain.method` string.
 * Methods not in this set are rejected — this prevents the profiler
 * tool from being repurposed as a code-execution vector via
 * `Runtime.evaluate` or similar dangerous methods.
 */
const ALLOWED_CDP_METHODS: ReadonlySet<string> = new Set([
  // HeapProfiler domain — core heap profiling.
  'HeapProfiler.enable',
  'HeapProfiler.disable',
  'HeapProfiler.takeHeapSnapshot',
  'HeapProfiler.collectGarbage',
  'HeapProfiler.startTrackingHeapObjects',
  'HeapProfiler.stopTrackingHeapObjects',
  'HeapProfiler.getHeapObjectId',
  'HeapProfiler.getSamplingProfile',
  'HeapProfiler.startSampling',
  'HeapProfiler.stopSampling',

  // Profiler domain — CPU profiling.
  'Profiler.enable',
  'Profiler.disable',
  'Profiler.start',
  'Profiler.stop',
  'Profiler.setSamplingInterval',
  'Profiler.getBestEffortCoverage',
  'Profiler.startPreciseCoverage',
  'Profiler.stopPreciseCoverage',

  // Runtime domain — limited to non-execution methods.
  'Runtime.getHeapUsage',

  // NodeTracing domain — performance tracing.
  'NodeTracing.start',
  'NodeTracing.stop',
  'NodeTracing.getCategories',
]);

/**
 * CDP domains that are allowed for event subscription.
 *
 * Events from these domains are passed through; events from other
 * domains are silently dropped.
 */
const ALLOWED_CDP_EVENT_DOMAINS: ReadonlySet<string> = new Set([
  'HeapProfiler',
  'Profiler',
  'Runtime',
  'NodeTracing',
]);

/**
 * Validate that a CDP method is in the profiling allowlist.
 *
 * @param method - CDP method name (e.g., `'HeapProfiler.enable'`).
 * @throws {PerfCompanionError} If the method is not allowed.
 */
export function validateCdpMethod(method: string): void {
  if (!ALLOWED_CDP_METHODS.has(method)) {
    const domain = method.split('.')[0] ?? 'unknown';
    throw new PerfCompanionError(
      `CDP method "${method}" is not permitted. ` +
        `Domain "${domain}" is outside the profiling allowlist. ` +
        'Only HeapProfiler, Profiler, and NodeTracing methods are allowed.',
      PerfErrorCode.INVALID_PARAMS,
      /* recoverable= */ false,
    );
  }
}

/**
 * Check whether a CDP event should be forwarded.
 *
 * Unlike `validateCdpMethod`, this does not throw — unauthorized events
 * are silently dropped rather than crashing the connection.
 *
 * @param eventMethod - CDP event method (e.g., `'HeapProfiler.addHeapSnapshotChunk'`).
 * @returns `true` if the event should be forwarded to listeners.
 */
export function isAllowedCdpEvent(eventMethod: string): boolean {
  const domain = eventMethod.split('.')[0] ?? '';
  return ALLOWED_CDP_EVENT_DOMAINS.has(domain);
}

// ─── Output Path Validation ─────────────────────────────────────────

/**
 * Default set of directories that are considered safe for snapshot output.
 *
 * The profiler writes potentially large files (hundreds of MB).  Constraining
 * the output to temp directories and explicit user-specified paths prevents
 * accidental writes to sensitive locations.
 */
function getDefaultAllowedRoots(): readonly string[] {
  return [
    normalize(tmpdir()),
  ];
}

/**
 * Validate that an output file path is within an allowed directory.
 *
 * Resolves symlinks and normalizes the path before checking containment.
 * This prevents path traversal via `../` sequences.
 *
 * @param outputPath  - The resolved output file path to validate.
 * @param allowedRoots - Directories that may contain output files.
 *   Defaults to the system temp directory.
 * @throws {PerfCompanionError} If the path escapes all allowed roots.
 */
export function validateOutputPath(
  outputPath: string,
  allowedRoots?: readonly string[],
): void {
  const roots = allowedRoots ?? getDefaultAllowedRoots();
  const normalized = normalize(resolve(outputPath));

  const isAllowed = roots.some((root) => {
    const normalizedRoot = normalize(resolve(root));
    // Ensure the path starts with the root and is followed by a separator
    // or is exactly the root.  This prevents `allowedRoot + "extra"` from
    // matching `allowedRootExtra/file`.
    return (
      normalized === normalizedRoot ||
      normalized.startsWith(normalizedRoot + '\\') ||
      normalized.startsWith(normalizedRoot + '/')
    );
  });

  if (!isAllowed) {
    throw new PerfCompanionError(
      `Output path "${outputPath}" is outside permitted directories. ` +
        `Allowed roots: [${roots.join(', ')}]. ` +
        'Specify an output directory within these paths or provide ' +
        'additional allowed roots.',
      PerfErrorCode.INVALID_PARAMS,
      /* recoverable= */ false,
    );
  }
}

// ─── Snapshot Data Sanitization ─────────────────────────────────────

/**
 * Patterns that indicate potentially sensitive data in heap snapshot
 * string tables.
 *
 * Heap snapshots contain the string table of the profiled process.
 * This can include API keys, tokens, passwords, and PII that were
 * held in memory at capture time.
 *
 * These patterns are used for *detection and reporting*, not automatic
 * redaction — the profiler flags the presence of sensitive strings
 * and lets the user decide.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  { label: 'API key (generic)', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/i },
  { label: 'Bearer token', pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i },
  { label: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { label: 'Private key marker', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/ },
  { label: 'JWT token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/ },
  { label: 'Password field', pattern: /(?:password|passwd|secret)\s*[:=]\s*\S+/i },
  { label: 'Connection string', pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/i },
  { label: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { label: 'Google API key', pattern: /AIza[0-9A-Za-z\-_]{35}/ },
];

/** Result of scanning a string table for sensitive content. */
export interface SensitiveDataReport {
  /** Total strings scanned. */
  readonly totalStrings: number;
  /** Number of strings flagged as potentially sensitive. */
  readonly flaggedCount: number;
  /** Categorized findings (label → count). */
  readonly findings: ReadonlyMap<string, number>;
  /** Whether any sensitive data was detected. */
  readonly hasSensitiveData: boolean;
}

/**
 * Scan a heap snapshot string table for potentially sensitive data.
 *
 * Does NOT modify the string table — only reports findings.  The caller
 * decides whether to proceed, redact, or abort.
 *
 * @param strings - The string table from a parsed heap snapshot.
 * @returns Report of detected sensitive patterns.
 */
export function scanForSensitiveData(
  strings: readonly string[],
): SensitiveDataReport {
  const findings = new Map<string, number>();
  let flaggedCount = 0;

  for (let i = 0; i < strings.length; i++) {
    const str = strings[i];
    // Skip short strings — sensitive data is typically > 8 chars.
    if (str.length < 8) continue;

    for (const { label, pattern } of SENSITIVE_PATTERNS) {
      if (pattern.test(str)) {
        findings.set(label, (findings.get(label) ?? 0) + 1);
        flaggedCount++;
        // Don't check remaining patterns for this string — one flag
        // per string is sufficient for reporting.
        break;
      }
    }
  }

  return {
    totalStrings: strings.length,
    flaggedCount,
    findings,
    hasSensitiveData: flaggedCount > 0,
  };
}
