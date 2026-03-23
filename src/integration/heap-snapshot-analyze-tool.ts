/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BaseDeclarativeTool integration for heap snapshot analysis.
 *
 * This file follows the exact pattern from gemini-cli's ReadFileTool.
 * Placement: packages/core/src/tools/heap-snapshot-analyze.ts
 *
 * The tool reads .heapsnapshot files from disk, parses them using the
 * perf-companion engine, and returns structured analysis via ToolResult.
 * The LLM-optimized context feeds directly into the Gemini agent loop.
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolLocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import {
  HEAP_SNAPSHOT_ANALYZE_TOOL_NAME,
  HEAP_SNAPSHOT_ANALYZE_DISPLAY_NAME,
  HEAP_SNAPSHOT_ANALYZE_DEFINITION,
} from './definitions/coreTools.js';
import {
  parseHeapSnapshot,
  parseHeapSnapshotFull,
} from '../perf-companion/parse/heap-snapshot-parser.js';
import { diffSnapshots } from '../perf-companion/analyze/three-snapshot-diff.js';
import {
  extractRetainerChainsForLeaks,
} from '../perf-companion/analyze/retainer-chain-extractor.js';
import {
  analyzeHeapSummary,
  analyzeLeakDetection,
} from '../perf-companion/bridge/llm-analysis-bridge.js';
import { convertHeapSummaryToTrace } from '../perf-companion/format/perfetto-formatter.js';
import { PerfCompanionError } from '../perf-companion/errors.js';

// ─── Parameters ──────────────────────────────────────────────────────

export interface HeapSnapshotAnalyzeParams {
  snapshot_path: string;
  baseline_path?: string;
  mode: 'summary' | 'diff' | 'leak-detect';
  top_n?: number;
  output_format?: 'markdown' | 'json' | 'perfetto';
}

// ─── Invocation ──────────────────────────────────────────────────────

class HeapSnapshotAnalyzeInvocation extends BaseToolInvocation<
  HeapSnapshotAnalyzeParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: HeapSnapshotAnalyzeParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    return `Analyze heap snapshot (${this.params.mode})`;
  }

  override toolLocations(): ToolLocation[] {
    const locations: ToolLocation[] = [{ path: this.params.snapshot_path }];
    if (this.params.baseline_path) {
      locations.push({ path: this.params.baseline_path });
    }
    return locations;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) {
      return {
        llmContent: 'Analysis was cancelled.',
        returnDisplay: 'Cancelled.',
        error: { message: 'Analysis cancelled by user.' },
      };
    }

    try {
      const topN = this.params.top_n ?? 10;

      if (this.params.mode === 'summary') {
        return await this.analyzeSummary(topN);
      }

      if (this.params.mode === 'diff' || this.params.mode === 'leak-detect') {
        if (!this.params.baseline_path) {
          return {
            llmContent: 'Error: baseline_path is required for diff and leak-detect modes.',
            returnDisplay: 'Missing baseline_path parameter.',
            error: { message: 'baseline_path is required for diff/leak-detect modes.' },
          };
        }
        return await this.analyzeDiff(topN);
      }

      return {
        llmContent: `Unknown mode: ${this.params.mode}`,
        returnDisplay: `Error: unknown mode "${this.params.mode}"`,
        error: { message: `Unknown analysis mode: ${this.params.mode}` },
      };
    } catch (err) {
      const message =
        err instanceof PerfCompanionError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      return {
        llmContent: `Heap analysis failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message },
      };
    }
  }

  private async analyzeSummary(topN: number): Promise<ToolResult> {
    const summary = await parseHeapSnapshot(this.params.snapshot_path, { topN });

    const perfettoTrace =
      this.params.output_format === 'perfetto'
        ? convertHeapSummaryToTrace(summary)
        : undefined;

    const result = analyzeHeapSummary(summary, perfettoTrace);

    return {
      llmContent: result.llmContext,
      returnDisplay: result.markdownReport,
      data: {
        summary: result.summary,
        suggestions: result.suggestions,
      },
    };
  }

  private async analyzeDiff(topN: number): Promise<ToolResult> {
    // Parse both snapshots.
    const baselineSummary = await parseHeapSnapshot(this.params.baseline_path!, { topN });
    const currentSummary = await parseHeapSnapshot(this.params.snapshot_path, { topN });

    // Compute diff.
    const diffResult = diffSnapshots(baselineSummary, currentSummary);

    // For leak-detect mode, also extract retainer chains.
    let retainerChains: ReadonlyMap<string, readonly import('../perf-companion/types.js').RetainerChain[]> | undefined;

    if (this.params.mode === 'leak-detect' && diffResult.strongLeakCandidates.length > 0) {
      const fullSnapshot = await parseHeapSnapshotFull(this.params.snapshot_path);
      const leakConstructors = diffResult.strongLeakCandidates
        .slice(0, 5)
        .map((c) => c.constructor);

      retainerChains = extractRetainerChainsForLeaks(
        fullSnapshot.nodes,
        fullSnapshot.edges,
        fullSnapshot.reverseGraph,
        leakConstructors,
      );
    }

    const result = analyzeLeakDetection(diffResult, retainerChains);

    return {
      llmContent: result.llmContext,
      returnDisplay: result.markdownReport,
      data: {
        summary: result.summary,
        suggestions: result.suggestions,
        strongCandidateCount: diffResult.summary.strongCandidateCount,
      },
    };
  }
}

// ─── Tool Class ──────────────────────────────────────────────────────

export class HeapSnapshotAnalyzeTool extends BaseDeclarativeTool<
  HeapSnapshotAnalyzeParams,
  ToolResult
> {
  static readonly Name = HEAP_SNAPSHOT_ANALYZE_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      HeapSnapshotAnalyzeTool.Name,
      HEAP_SNAPSHOT_ANALYZE_DISPLAY_NAME,
      HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.description,
      Kind.Read, // Analysis is read-only (reads snapshot files).
      HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,  // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected override validateToolParamValues(
    params: HeapSnapshotAnalyzeParams,
  ): string | null {
    if (params.snapshot_path.trim() === '') {
      return 'snapshot_path must be non-empty.';
    }

    if (
      (params.mode === 'diff' || params.mode === 'leak-detect') &&
      (!params.baseline_path || params.baseline_path.trim() === '')
    ) {
      return `baseline_path is required for "${params.mode}" mode.`;
    }

    if (params.top_n !== undefined && params.top_n < 1) {
      return 'top_n must be at least 1.';
    }

    // Validate file access through Config.
    const validationError = this.config.validatePathAccess(
      params.snapshot_path,
      'read',
    );
    if (validationError) {
      return validationError;
    }

    if (params.baseline_path) {
      const baselineError = this.config.validatePathAccess(
        params.baseline_path,
        'read',
      );
      if (baselineError) {
        return baselineError;
      }
    }

    return null;
  }

  protected createInvocation(
    params: HeapSnapshotAnalyzeParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<HeapSnapshotAnalyzeParams, ToolResult> {
    return new HeapSnapshotAnalyzeInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
