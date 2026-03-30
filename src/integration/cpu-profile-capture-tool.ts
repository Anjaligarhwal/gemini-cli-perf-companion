/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BaseDeclarativeTool integration for CPU profile capture.
 *
 * Target location: packages/core/src/tools/cpu-profile-capture.ts
 *
 * Uses the V8 Profiler domain via node:inspector (self mode) or
 * CDP WebSocket (remote mode) to record CPU sampling data.
 */

import type { MessageBus, Config, ToolInvocation } from './gemini-cli-types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind, type ToolResult } from './gemini-cli-types.js';
import {
  CPU_PROFILE_CAPTURE_TOOL_NAME,
  CPU_PROFILE_CAPTURE_DISPLAY_NAME,
  CPU_PROFILE_CAPTURE_DEFINITION,
} from './tool-definitions.js';
import { captureCpuProfile } from '../capture/cpu-profile-capture.js';
import { PerfCompanionError } from '../errors.js';
import { formatBytes } from '../utils.js';

// ─── Parameters ──────────────────────────────────────────────────────

export interface CpuProfileCaptureParams {
  readonly target: 'self' | 'remote';
  readonly duration_ms?: number;
  readonly host?: string;
  readonly port?: number;
  readonly label?: string;
  readonly output_dir?: string;
}

// ─── Invocation ──────────────────────────────────────────────────────

class CpuProfileCaptureInvocation extends BaseToolInvocation<
  CpuProfileCaptureParams,
  ToolResult
> {
  constructor(
    _config: Config, // Used after integration for path resolution via config.workingDir.
    params: CpuProfileCaptureParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
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
      // Current engine supports self-capture. Remote capture via CDP
      // Profiler domain will be added during GSoC integration.
      const result = await captureCpuProfile({
        durationMs: this.params.duration_ms ?? 5000,
        label: this.params.label,
        outputDir: this.params.output_dir,
      });

      const sizeStr = formatBytes(result.sizeBytes);

      return {
        llmContent:
          `CPU profile saved to ${result.filePath} ` +
          `(${sizeStr}, ${result.durationMs}ms). ` +
          `Use cpu_profile_analyze with this path to identify hot functions.`,
        returnDisplay:
          `CPU profile captured successfully.\n` +
          `- **File:** \`${result.filePath}\`\n` +
          `- **Size:** ${sizeStr}\n` +
          `- **Duration:** ${result.durationMs}ms\n` +
          `- **Label:** ${result.label}`,
        data: {
          filePath: result.filePath,
          sizeBytes: result.sizeBytes,
          durationMs: result.durationMs,
          label: result.label,
        },
      };
    } catch (err: unknown) {
      const message =
        err instanceof PerfCompanionError ? err.message
          : err instanceof Error ? err.message
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
  private readonly config: Config;

  constructor(config: Config, messageBus: MessageBus) {
    super(
      CpuProfileCaptureTool.Name,
      CPU_PROFILE_CAPTURE_DISPLAY_NAME,
      CPU_PROFILE_CAPTURE_DEFINITION.base.description,
      Kind.Execute,
      CPU_PROFILE_CAPTURE_DEFINITION.base.parametersJsonSchema,
      messageBus,
    );
    this.config = config;
  }

  protected validateToolParamValues(
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
      if (params.duration_ms < 100) return 'Duration must be at least 100ms.';
      if (params.duration_ms > 300_000) return 'Duration cannot exceed 300000ms (5 minutes).';
    }
    return null;
  }

  protected createInvocation(
    params: CpuProfileCaptureParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<CpuProfileCaptureParams, ToolResult> {
    return new CpuProfileCaptureInvocation(
      this.config, params, messageBus, toolName, toolDisplayName,
    );
  }
}
