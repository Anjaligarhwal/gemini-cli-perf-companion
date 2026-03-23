/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BaseDeclarativeTool integration for CPU profile analysis.
 *
 * Follows the exact pattern from gemini-cli's ReadFileTool.
 * Placement: packages/core/src/tools/cpu-profile-analyze.ts
 *
 * Parses .cpuprofile files, identifies hot functions, computes
 * category breakdowns (GC, Idle, User, etc.), and returns
 * LLM-optimized context for the Gemini agent loop.
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
  CPU_PROFILE_ANALYZE_TOOL_NAME,
  CPU_PROFILE_ANALYZE_DISPLAY_NAME,
  CPU_PROFILE_ANALYZE_DEFINITION,
} from './definitions/coreTools.js';
import { parseCpuProfile } from '../perf-companion/parse/cpu-profile-parser.js';
import { analyzeCpuProfile } from '../perf-companion/bridge/llm-analysis-bridge.js';
import { convertCpuProfileToTrace } from '../perf-companion/format/perfetto-formatter.js';
import { PerfCompanionError } from '../perf-companion/errors.js';

// ─── Parameters ──────────────────────────────────────────────────────

export interface CpuProfileAnalyzeParams {
  profile_path: string;
  top_n?: number;
  output_format?: 'markdown' | 'json' | 'perfetto';
}

// ─── Invocation ──────────────────────────────────────────────────────

class CpuProfileAnalyzeInvocation extends BaseToolInvocation<
  CpuProfileAnalyzeParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: CpuProfileAnalyzeParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    return 'Analyze CPU profile';
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.profile_path }];
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
      const profile = await parseCpuProfile(this.params.profile_path, { topN });

      const perfettoTrace =
        this.params.output_format === 'perfetto'
          ? convertCpuProfileToTrace(profile)
          : undefined;

      const result = analyzeCpuProfile(profile, perfettoTrace);

      return {
        llmContent: result.llmContext,
        returnDisplay: result.markdownReport,
        data: {
          summary: result.summary,
          suggestions: result.suggestions,
          hotFunctionCount: profile.hotFunctions.length,
          sampleCount: profile.sampleCount,
        },
      };
    } catch (err) {
      const message =
        err instanceof PerfCompanionError
          ? err.message
          : err instanceof Error
            ? err.message
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

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      CpuProfileAnalyzeTool.Name,
      CPU_PROFILE_ANALYZE_DISPLAY_NAME,
      CPU_PROFILE_ANALYZE_DEFINITION.base.description,
      Kind.Read, // Analysis is read-only.
      CPU_PROFILE_ANALYZE_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: CpuProfileAnalyzeParams,
  ): string | null {
    if (params.profile_path.trim() === '') {
      return 'profile_path must be non-empty.';
    }

    if (params.top_n !== undefined && params.top_n < 1) {
      return 'top_n must be at least 1.';
    }

    const validationError = this.config.validatePathAccess(
      params.profile_path,
      'read',
    );
    if (validationError) {
      return validationError;
    }

    return null;
  }

  protected createInvocation(
    params: CpuProfileAnalyzeParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<CpuProfileAnalyzeParams, ToolResult> {
    return new CpuProfileAnalyzeInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
