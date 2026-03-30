/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JSON schema definitions for perf-companion tools.
 *
 * These follow the exact pattern used by gemini-cli's
 * `packages/core/src/tools/definitions/` for tool declarations.
 * Each tool has a name, display name, description, and parametersJsonSchema.
 *
 * During GSoC integration, these definitions will be added to the
 * model-family-sets and coreTools.ts registries.
 */

// ─── Tool Names ──────────────────────────────────────────────────────

export const HEAP_SNAPSHOT_CAPTURE_TOOL_NAME = 'heap_snapshot_capture';
export const HEAP_SNAPSHOT_ANALYZE_TOOL_NAME = 'heap_snapshot_analyze';
export const CPU_PROFILE_CAPTURE_TOOL_NAME = 'cpu_profile_capture';
export const CPU_PROFILE_ANALYZE_TOOL_NAME = 'cpu_profile_analyze';

export const HEAP_SNAPSHOT_CAPTURE_DISPLAY_NAME = 'CaptureHeapSnapshot';
export const HEAP_SNAPSHOT_ANALYZE_DISPLAY_NAME = 'AnalyzeHeapSnapshot';
export const CPU_PROFILE_CAPTURE_DISPLAY_NAME = 'CaptureCpuProfile';
export const CPU_PROFILE_ANALYZE_DISPLAY_NAME = 'AnalyzeCpuProfile';

// ─── Parameter Names ─────────────────────────────────────────────────

export const PARAM_TARGET = 'target';
export const PARAM_HOST = 'host';
export const PARAM_PORT = 'port';
export const PARAM_LABEL = 'label';
export const PARAM_OUTPUT_DIR = 'output_dir';
export const PARAM_FORCE_GC = 'force_gc';
export const PARAM_TIMEOUT_MS = 'timeout_ms';
export const PARAM_SNAPSHOT_PATH = 'snapshot_path';
export const PARAM_BASELINE_PATH = 'baseline_path';
export const PARAM_MODE = 'mode';
export const PARAM_TOP_N = 'top_n';
export const PARAM_OUTPUT_FORMAT = 'output_format';
export const PARAM_DURATION_MS = 'duration_ms';
export const PARAM_THIRD_PATH = 'third_path';
export const PARAM_PROFILE_PATH = 'profile_path';

// ─── Heap Snapshot Capture Definition ────────────────────────────────

export const HEAP_SNAPSHOT_CAPTURE_DEFINITION = {
  base: {
    name: HEAP_SNAPSHOT_CAPTURE_TOOL_NAME,
    description:
      'Capture a V8 heap snapshot from the current Node.js process or a ' +
      'remote `node --inspect` process. Writes the snapshot to disk and ' +
      'returns the file path, size, and timing. Use this before ' +
      '`heap_snapshot_analyze` to generate data for leak detection.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_TARGET]: {
          type: 'string',
          enum: ['self', 'remote'],
          description:
            'Capture mode: "self" profiles the current process, ' +
            '"remote" connects to an external `node --inspect` process via CDP WebSocket.',
        },
        [PARAM_HOST]: {
          type: 'string',
          description:
            'Hostname of the remote inspector (default: 127.0.0.1). Only used when target is "remote".',
        },
        [PARAM_PORT]: {
          type: 'number',
          description:
            'Port of the remote inspector (default: 9229). Only used when target is "remote".',
        },
        [PARAM_LABEL]: {
          type: 'string',
          description:
            'Human-readable label for the snapshot file (default: "snapshot-{timestamp}").',
        },
        [PARAM_OUTPUT_DIR]: {
          type: 'string',
          description:
            'Directory to write the .heapsnapshot file (default: system temp dir).',
        },
        [PARAM_FORCE_GC]: {
          type: 'boolean',
          description:
            'Force garbage collection before capture (default: true). ' +
            'Ensures the snapshot reflects reachable objects only.',
        },
        [PARAM_TIMEOUT_MS]: {
          type: 'number',
          description: 'Timeout in milliseconds for the capture operation (default: 30000).',
        },
      },
      required: [PARAM_TARGET],
    },
  },
} as const;

// ─── Heap Snapshot Analyze Definition ────────────────────────────────

export const HEAP_SNAPSHOT_ANALYZE_DEFINITION = {
  base: {
    name: HEAP_SNAPSHOT_ANALYZE_TOOL_NAME,
    description:
      'Analyze one or two V8 heap snapshots to detect memory leaks, ' +
      'identify dominant constructors, and extract retainer chains. ' +
      'Supports single-snapshot summary, two-snapshot diff, and ' +
      '3-snapshot leak detection (when given baseline + post-action paths). ' +
      'Returns structured markdown for the user and LLM-optimized context.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_SNAPSHOT_PATH]: {
          type: 'string',
          description: 'Path to the primary .heapsnapshot file to analyze.',
        },
        [PARAM_BASELINE_PATH]: {
          type: 'string',
          description:
            'Optional path to a baseline .heapsnapshot for diff/leak detection. ' +
            'When provided, the tool computes object growth between baseline and primary.',
        },
        [PARAM_THIRD_PATH]: {
          type: 'string',
          description:
            'Optional path to a mid-point .heapsnapshot (snapshot B) for 3-snapshot leak detection. ' +
            'When provided with baseline_path (A) and snapshot_path (C), enables the full A→B→C technique.',
        },
        [PARAM_MODE]: {
          type: 'string',
          enum: ['summary', 'diff', 'leak-detect'],
          description:
            'Analysis mode: "summary" for single snapshot, "diff" for two-snapshot comparison, ' +
            '"leak-detect" for full 3-snapshot technique with retainer chains.',
        },
        [PARAM_TOP_N]: {
          type: 'number',
          description:
            'Number of top constructors to include in the report (default: 10).',
        },
        [PARAM_OUTPUT_FORMAT]: {
          type: 'string',
          enum: ['markdown', 'json', 'perfetto'],
          description:
            'Output format: "markdown" for human-readable, "json" for structured data, ' +
            '"perfetto" to generate a Chrome Trace Event JSON for ui.perfetto.dev.',
        },
      },
      required: [PARAM_SNAPSHOT_PATH, PARAM_MODE],
    },
  },
} as const;

// ─── CPU Profile Capture Definition ──────────────────────────────────

export const CPU_PROFILE_CAPTURE_DEFINITION = {
  base: {
    name: CPU_PROFILE_CAPTURE_TOOL_NAME,
    description:
      'Capture a V8 CPU profile from the current Node.js process or a ' +
      'remote `node --inspect` process. Records sampling profiler data for ' +
      'the specified duration and writes a .cpuprofile file. Use this before ' +
      '`cpu_profile_analyze` to identify hot functions and performance bottlenecks.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_TARGET]: {
          type: 'string',
          enum: ['self', 'remote'],
          description:
            'Capture mode: "self" profiles the current process, ' +
            '"remote" connects to an external `node --inspect` process via CDP WebSocket.',
        },
        [PARAM_DURATION_MS]: {
          type: 'number',
          description:
            'Duration to record the CPU profile in milliseconds (default: 5000).',
        },
        [PARAM_HOST]: {
          type: 'string',
          description:
            'Hostname of the remote inspector (default: 127.0.0.1). Only used when target is "remote".',
        },
        [PARAM_PORT]: {
          type: 'number',
          description:
            'Port of the remote inspector (default: 9229). Only used when target is "remote".',
        },
        [PARAM_LABEL]: {
          type: 'string',
          description: 'Human-readable label for the profile file.',
        },
        [PARAM_OUTPUT_DIR]: {
          type: 'string',
          description: 'Directory to write the .cpuprofile file.',
        },
      },
      required: [PARAM_TARGET],
    },
  },
} as const;

// ─── CPU Profile Analyze Definition ──────────────────────────────────

export const CPU_PROFILE_ANALYZE_DEFINITION = {
  base: {
    name: CPU_PROFILE_ANALYZE_TOOL_NAME,
    description:
      'Analyze a V8 CPU profile (.cpuprofile) to identify hot functions, ' +
      'GC pressure, and performance bottlenecks. Returns a ranked list of ' +
      'functions by self-time with script locations, category breakdowns, ' +
      'and actionable optimization suggestions.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_PROFILE_PATH]: {
          type: 'string',
          description: 'Path to the .cpuprofile file to analyze.',
        },
        [PARAM_TOP_N]: {
          type: 'number',
          description:
            'Number of hot functions to include in the report (default: 10).',
        },
        [PARAM_OUTPUT_FORMAT]: {
          type: 'string',
          enum: ['markdown', 'json', 'perfetto'],
          description:
            'Output format: "markdown" for human-readable, "json" for structured data, ' +
            '"perfetto" to generate a Chrome Trace Event JSON for ui.perfetto.dev.',
        },
      },
      required: [PARAM_PROFILE_PATH],
    },
  },
} as const;
