/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck — This file targets gemini-cli's packages/core/src/tools/.
// Imports resolve only when placed inside the gemini-cli monorepo.

/**
 * BaseDeclarativeTool integration for CPU profile capture.
 *
 * Follows the exact pattern from gemini-cli's ReadFileTool/WebFetchTool.
 * Placement: packages/core/src/tools/cpu-profile-capture.ts
 *
 * Uses the V8 Profiler domain via node:inspector (self mode) or
 * CDP WebSocket (remote mode) to record CPU sampling data.
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import {
  CPU_PROFILE_CAPTURE_TOOL_NAME,
  CPU_PROFILE_CAPTURE_DISPLAY_NAME,
  CPU_PROFILE_CAPTURE_DEFINITION,
} from './definitions/coreTools.js';
import { captureCpuProfile } from '../perf-companion/capture/cpu-profile-capture.js';
import { PerfCompanionError } from '../perf-companion/errors.js';
import { formatBytes } from '../perf-companion/utils.js';

// ─── Parameters ──────────────────────────────────────────────────────

export interface CpuProfileCaptureParams {
  target: 'self' | 'remote';
  duration_ms?: number;
  host?: string;
  port?: number;
  label?: string;
  output_dir?: string;
}

// ─── Invocation ──────────────────────────────────────────────────────

class CpuProfileCaptureInvocation extends BaseToolInvocation<
  CpuProfileCaptureParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: CpuProfileCaptureParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const duration = this.params.duration_ms ?? 5000;
    if (this.params.target === 'remote') {
      const host = this.params.host ?? '127.0.0.1';
      const port = this.params.port ?? 9229;
      return `Capture CPU profile from ${host}:${port} (${duration}ms)`;
    }
    return `Capture CPU profile (self, ${duration}ms)`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) {
      return {
        llmContent: 'CPU profile capture was cancelled.',
        returnDisplay: 'Cancelled.',
        error: { message: 'Capture cancelled by user.' },
      };
    }

    try {
      const result = await captureCpuProfile({
        target: this.params.target,
        durationMs: this.params.duration_ms ?? 5000,
        host: this.params.host,
        port: this.params.port,
        label: this.params.label,
        outputDir: this.params.output_dir,
      });

      const sizeStr = formatBytes(result.sizeBytes);
      const summary =
        `CPU profile captured successfully.\n` +
        `- **File:** \`${result.filePath}\`\n` +
        `- **Size:** ${sizeStr}\n` +
        `- **Duration:** ${result.durationMs}ms\n` +
        `- **Label:** ${result.label}`;

      const llmContent =
        `CPU profile saved to ${result.filePath} ` +
        `(${sizeStr}, ${result.durationMs}ms). ` +
        `Use cpu_profile_analyze with this path to identify hot functions.`;

      return {
        llmContent,
        returnDisplay: summary,
        data: {
          filePath: result.filePath,
          sizeBytes: result.sizeBytes,
          durationMs: result.durationMs,
          label: result.label,
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
        llmContent: `CPU profile capture failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message },
      };
    }
  }
}

// ─── Tool Class ──────────────────────────────────────────────────────

export class CpuProfileCaptureTool extends BaseDeclarativeTool<
  CpuProfileCaptureParams,
  ToolResult
> {
  static readonly Name = CPU_PROFILE_CAPTURE_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      CpuProfileCaptureTool.Name,
      CPU_PROFILE_CAPTURE_DISPLAY_NAME,
      CPU_PROFILE_CAPTURE_DEFINITION.base.description,
      Kind.Execute, // Captures have side effects.
      CPU_PROFILE_CAPTURE_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: CpuProfileCaptureParams,
  ): string | null {
    if (params.target === 'remote') {
      if (params.port !== undefined && (params.port < 1 || params.port > 65535)) {
        return 'Port must be between 1 and 65535.';
      }
      if (
        params.host !== undefined &&
        params.host !== '127.0.0.1' &&
        params.host !== 'localhost' &&
        params.host !== '::1'
      ) {
        return 'Remote capture only supports localhost connections.';
      }
    }

    if (params.duration_ms !== undefined) {
      if (params.duration_ms < 100) {
        return 'Duration must be at least 100ms.';
      }
      if (params.duration_ms > 300_000) {
        return 'Duration cannot exceed 300000ms (5 minutes).';
      }
    }

    return null;
  }

  protected createInvocation(
    params: CpuProfileCaptureParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<CpuProfileCaptureParams, ToolResult> {
    return new CpuProfileCaptureInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}

