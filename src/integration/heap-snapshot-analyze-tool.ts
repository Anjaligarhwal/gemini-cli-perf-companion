/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BaseDeclarativeTool integration for heap snapshot analysis.
 *
 * Target location: packages/core/src/tools/heap-snapshot-analyze.ts
 *
 * Reads .heapsnapshot files from disk, parses them using the streaming
 * parser, runs leak detection + retainer chain extraction, and returns
 * structured analysis via ToolResult for the Gemini agent loop.
 */

import type { MessageBus, Config, ToolLocation, ToolInvocation } from './gemini-cli-types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind, type ToolResult } from './gemini-cli-types.js';
import {
  HEAP_SNAPSHOT_ANALYZE_TOOL_NAME,
  HEAP_SNAPSHOT_ANALYZE_DISPLAY_NAME,
  HEAP_SNAPSHOT_ANALYZE_DEFINITION,
} from './tool-definitions.js';
import { parseHeapSnapshot, parseHeapSnapshotFull } from '../parse/heap-snapshot-parser.js';
import { threeSnapshotDiff } from '../analyze/three-snapshot-diff.js';
import { extractRetainerChainsForLeaks } from '../analyze/retainer-chain-extractor.js';
import { analyzeHeapSummary, analyzeLeakDetection } from '../bridge/llm-analysis-bridge.js';
import { heapSummaryToTrace } from '../format/perfetto-formatter.js';
import { PerfCompanionError } from '../errors.js';

// ─── Parameters ──────────────────────────────────────────────────────

export interface HeapSnapshotAnalyzeParams {
  readonly snapshot_path: string;
  readonly baseline_path?: string;
  readonly third_path?: string;
  readonly mode: 'summary' | 'diff' | 'leak-detect';
  readonly top_n?: number;
  readonly output_format?: 'markdown' | 'json' | 'perfetto';
}

// ─── Invocation ──────────────────────────────────────────────────────

class HeapSnapshotAnalyzeInvocation extends BaseToolInvocation<
  HeapSnapshotAnalyzeParams,
  ToolResult
> {
  constructor(
    _config: Config, // Used after integration for path resolution via config.workingDir.
    params: HeapSnapshotAnalyzeParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    return `Analyze heap snapshot (${this.params.mode})`;
  }

  override toolLocations(): ToolLocation[] {
    const locations: ToolLocation[] = [{ filePath: this.params.snapshot_path }];
    if (this.params.baseline_path) {
      locations.push({ filePath: this.params.baseline_path });
    }
    if (this.params.third_path) {
      locations.push({ filePath: this.params.third_path });
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
      if (this.params.mode === 'diff') {
        return await this.analyzeLeaks(topN);
      }
      return await this.analyzeLeaks(topN);
    } catch (err: unknown) {
      const message =
        err instanceof PerfCompanionError ? err.message
          : err instanceof Error ? err.message
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
        ? heapSummaryToTrace(summary, 'heap-analysis', Date.now() * 1000)
        : undefined;

    const result = analyzeHeapSummary(summary, perfettoTrace);

    return {
      llmContent: result.llmContext,
      returnDisplay: result.markdownReport,
      data: { summary: result.summary, suggestions: result.suggestions },
    };
  }

  /**
   * 3-snapshot leak detection: requires snapshot_path (C), baseline_path (A),
   * and third_path (B). Runs threeSnapshotDiff(A, B, C), extracts retainer
   * chains for the top candidates, and formats for the LLM.
   */
  private async analyzeLeaks(topN: number): Promise<ToolResult> {
    const baselinePath = this.params.baseline_path!;
    const midPath = this.params.third_path ?? this.params.snapshot_path;

    const [snapshotA, snapshotB, snapshotC] = await Promise.all([
      parseHeapSnapshotFull(baselinePath, { topN }),
      parseHeapSnapshotFull(midPath, { topN }),
      parseHeapSnapshotFull(this.params.snapshot_path, { topN }),
    ]);

    const diffResult = threeSnapshotDiff(
      snapshotA.nodes,
      snapshotB.nodes,
      snapshotC.nodes,
      snapshotC.reverseGraph,
    );

    let retainerChains: ReturnType<typeof extractRetainerChainsForLeaks> | undefined;

    if (diffResult.strongLeakCandidates.length > 0) {
      const leakConstructors = diffResult.strongLeakCandidates
        .slice(0, 5)
        .map((c) => c.constructor);

      retainerChains = extractRetainerChainsForLeaks(
        leakConstructors,
        snapshotC.nodes,
        snapshotC.reverseGraph,
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
  private readonly config: Config;

  constructor(config: Config, messageBus: MessageBus) {
    super(
      HeapSnapshotAnalyzeTool.Name,
      HEAP_SNAPSHOT_ANALYZE_DISPLAY_NAME,
      HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.description,
      Kind.Read,
      HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.parametersJsonSchema,
      messageBus,
    );
    this.config = config;
  }

  protected validateToolParamValues(
    params: HeapSnapshotAnalyzeParams,
  ): string | null {
    if (params.snapshot_path.trim() === '') {
      return 'snapshot_path must be non-empty.';
    }
    if (params.mode === 'leak-detect') {
      if (!params.baseline_path || params.baseline_path.trim() === '') {
        return 'baseline_path is required for leak-detect mode.';
      }
    }
    if (params.top_n !== undefined && params.top_n < 1) {
      return 'top_n must be at least 1.';
    }
    return null;
  }

  protected createInvocation(
    params: HeapSnapshotAnalyzeParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<HeapSnapshotAnalyzeParams, ToolResult> {
    return new HeapSnapshotAnalyzeInvocation(
      this.config, params, messageBus, toolName, toolDisplayName,
    );
  }
}
