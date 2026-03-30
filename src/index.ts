/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public API surface for the perf-companion subsystem.
 *
 * This barrel export exposes every module that gemini-cli's tool
 * implementations and tests need.  Integration-layer files (e.g.,
 * `HeapSnapshotCaptureTool`) are intentionally excluded — they live
 * inside gemini-cli's `packages/core/src/tools/` tree at integration
 * time and import from this package directly.
 *
 * @module
 */

// ─── Core Types ─────────────────────────────────────────────────────
export type {
  HeapSnapshotMeta,
  HeapNode,
  HeapEdge,
  HeapSnapshotSummary,
  ConstructorGroup,
  ObjectGrowthRecord,
  RetainerChain,
  RetainerNode,
  ThreeSnapshotDiffResult,
  CpuProfileData,
  HotFunction,
  CategoryBreakdown,
  PerfettoTraceEvent,
  PerfettoTrace,
  CaptureOptions,
  CaptureResult,
  AnalysisOptions,
  AnalysisResult,
} from './types.js';

// ─── Error Handling ─────────────────────────────────────────────────
export { PerfCompanionError, PerfErrorCode } from './errors.js';

// ─── Validation ─────────────────────────────────────────────────────
export {
  validateFilePath,
  validateSnapshotPath,
  validateCpuProfilePath,
  validatePositiveInteger,
  validateCaptureOptions,
  validateAnalysisOptions,
} from './validation.js';

// ─── Shared Utilities ───────────────────────────────────────────────
export { formatBytes, formatMicroseconds, abbreviateScript } from './utils.js';

// ─── Parse ──────────────────────────────────────────────────────────
export type { ParseOptions, ParsedHeapSnapshot } from './parse/heap-snapshot-parser.js';
export { parseHeapSnapshot, parseHeapSnapshotFull } from './parse/heap-snapshot-parser.js';
export type { StreamingParseOptions } from './parse/streaming-snapshot-parser.js';
export { parseHeapSnapshotStreaming } from './parse/streaming-snapshot-parser.js';
export { parseNodes, aggregateByConstructor } from './parse/node-parser.js';
export type { RetainerEdge } from './parse/edge-parser.js';
export { parseEdges, buildReverseGraph } from './parse/edge-parser.js';

// ─── Analysis ───────────────────────────────────────────────────────
export type { ThreeSnapshotDiffOptions } from './analyze/three-snapshot-diff.js';
export { threeSnapshotDiff, formatDiffForLLM } from './analyze/three-snapshot-diff.js';
export type { NoiseFilterConfig } from './analyze/noise-filter.js';
export { filterNoise, isV8Internal } from './analyze/noise-filter.js';
export type { RetainerChainOptions } from './analyze/retainer-chain-extractor.js';
export {
  extractRetainerChains,
  findNodesByConstructor,
  extractRetainerChainsForLeaks,
  formatRetainerChainsForLLM,
} from './analyze/retainer-chain-extractor.js';
export {
  LeakCategory,
  type LeakCategoryString,
  type LeakClassification,
  type ClassificationReport,
  classifyLeaks,
  formatClassificationForLLM,
} from './analyze/root-cause-classifier.js';
export type { CpuProfileAnalysisOptions } from './analyze/cpu-profile-analyzer.js';
export {
  analyzeCpuProfile,
  analyzeCpuProfileData,
  formatCpuProfileForLLM,
} from './analyze/cpu-profile-analyzer.js';

// ─── Capture ────────────────────────────────────────────────────────
export { captureHeapSnapshot, captureThreeSnapshots } from './capture/heap-snapshot-capture.js';
export type { CpuCaptureOptions } from './capture/cpu-profile-capture.js';
export { captureCpuProfile } from './capture/cpu-profile-capture.js';
export type { CdpConnectionOptions } from './capture/cdp-client.js';
export { CdpClient } from './capture/cdp-client.js';

// ─── Security ───────────────────────────────────────────────────────
export type { SensitiveDataReport } from './security/connection-validator.js';
export {
  validateConnectionTarget,
  validateCdpMethod,
  isAllowedCdpEvent,
  validateOutputPath,
  scanForSensitiveData,
} from './security/connection-validator.js';

// ─── LLM Bridge ─────────────────────────────────────────────────────
export {
  analyzeHeapSummary,
  analyzeLeakDetection,
  analyzeCpuProfile as analyzeCpuProfileForLLM,
  mergeAnalysisResults,
} from './bridge/llm-analysis-bridge.js';

// ─── Perfetto Visualization ─────────────────────────────────────────
export {
  heapSummaryToTrace,
  diffResultToTrace,
  cpuProfileToTrace,
  mergeTraces,
  writeTrace,
} from './format/perfetto-formatter.js';

// ─── Tool Definitions (JSON schemas for gemini-cli registration) ────
export {
  HEAP_SNAPSHOT_CAPTURE_TOOL_NAME,
  HEAP_SNAPSHOT_ANALYZE_TOOL_NAME,
  CPU_PROFILE_CAPTURE_TOOL_NAME,
  CPU_PROFILE_ANALYZE_TOOL_NAME,
  HEAP_SNAPSHOT_CAPTURE_DEFINITION,
  HEAP_SNAPSHOT_ANALYZE_DEFINITION,
  CPU_PROFILE_CAPTURE_DEFINITION,
  CPU_PROFILE_ANALYZE_DEFINITION,
} from './integration/tool-definitions.js';
