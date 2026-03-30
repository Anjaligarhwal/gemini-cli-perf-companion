/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BaseDeclarativeTool integration for CPU profile analysis.
 *
 * Target location: packages/core/src/tools/cpu-profile-analyze.ts
 *
 * Parses .cpuprofile files, identifies hot functions, computes
 * category breakdowns (GC, Idle, User, etc.), and returns
 * LLM-optimized context for the Gemini agent loop.
 */

import type { MessageBus, Config, ToolLocation, ToolInvocation } from './gemini-cli-types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind, type ToolResult } from './gemini-cli-types.js';
import {
  CPU_PROFILE_ANALYZE_TOOL_NAME,
  CPU_PROFILE_ANALYZE_DISPLAY_NAME,
  CPU_PROFILE_ANALYZE_DEFINITION,
} from './tool-definitions.js';
import { analyzeCpuProfile as parseCpuProfileFile } from '../analyze/cpu-profile-analyzer.js';
import { analyzeCpuProfile as formatCpuForLLM } from '../bridge/llm-analysis-bridge.js';
import { cpuProfileToTrace } from '../format/perfetto-formatter.js';
import { PerfCompanionError } from '../errors.js';

// ─── Parameters ──────────────────────────────────────────────────────

export interface CpuProfileAnalyzeParams {
  readonly profile_path: string;
  readonly top_n?: number;
  readonly output_format?: 'markdown' | 'json' | 'perfetto';
}

// ─── Invocation ──────────────────────────────────────────────────────

class CpuProfileAnalyzeInvocation extends BaseToolInvocation<
  CpuProfileAnalyzeParams,
  ToolResult
> {
  constructor(
    _config: Config, // Used after integration for path resolution via config.workingDir.
    params: CpuProfileAnalyzeParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    return 'Analyze CPU profile';
  }

  override toolLocations(): ToolLocation[] {
    return [{ filePath: this.params.profile_path }];
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) {
      return {
        llmContent: 'CPU analysis was cancelled.',
        returnDisplay: 'Cancelled.',
        error: { message: 'Analysis cancelled by user.' },
      };
    }

    try {
      const topN = this.params.top_n ?? 10;

      // Step 1: Parse .cpuprofile file into structured CpuProfileData.
      const profileData = await parseCpuProfileFile(this.params.profile_path, { topN });

      // Step 2: Optionally generate Perfetto trace.
      const perfettoTrace =
        this.params.output_format === 'perfetto'
          ? cpuProfileToTrace(profileData, Date.now() * 1000)
          : undefined;

      // Step 3: Format for LLM consumption.
      const result = formatCpuForLLM(profileData, perfettoTrace);

      return {
        llmContent: result.llmContext,
        returnDisplay: result.markdownReport,
        data: {
          summary: result.summary,
          suggestions: result.suggestions,
          hotFunctionCount: profileData.hotFunctions.length,
          sampleCount: profileData.sampleCount,
        },
      };
    } catch (err: unknown) {
      const message =
        err instanceof PerfCompanionError ? err.message
          : err instanceof Error ? err.message
          : String(err);

      return {
        llmContent: `CPU profile analysis failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message },
      };
    }
  }
}

// ─── Tool Class ──────────────────────────────────────────────────────

export class CpuProfileAnalyzeTool extends BaseDeclarativeTool<
  CpuProfileAnalyzeParams,
  ToolResult
> {
  static readonly Name = CPU_PROFILE_ANALYZE_TOOL_NAME;
  private readonly config: Config;

  constructor(config: Config, messageBus: MessageBus) {
    super(
      CpuProfileAnalyzeTool.Name,
      CPU_PROFILE_ANALYZE_DISPLAY_NAME,
      CPU_PROFILE_ANALYZE_DEFINITION.base.description,
      Kind.Read,
      CPU_PROFILE_ANALYZE_DEFINITION.base.parametersJsonSchema,
      messageBus,
    );
    this.config = config;
  }

  protected validateToolParamValues(
    params: CpuProfileAnalyzeParams,
  ): string | null {
    if (params.profile_path.trim() === '') {
      return 'profile_path must be non-empty.';
    }
    if (params.top_n !== undefined && params.top_n < 1) {
      return 'top_n must be at least 1.';
    }
    return null;
  }

  protected createInvocation(
    params: CpuProfileAnalyzeParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<CpuProfileAnalyzeParams, ToolResult> {
    return new CpuProfileAnalyzeInvocation(
      this.config, params, messageBus, toolName, toolDisplayName,
    );
  }
}
