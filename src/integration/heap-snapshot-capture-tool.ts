/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BaseDeclarativeTool integration for heap snapshot capture.
 *
 * Target location: packages/core/src/tools/heap-snapshot-capture.ts
 *
 * Follows the exact pattern from gemini-cli's ReadFileTool and WebFetchTool.
 * Framework types come from gemini-cli-types.ts (dependency inversion);
 * engine code imports from the real local modules.
 *
 * At integration time, replace gemini-cli-types.ts imports with:
 *   MessageBus  ← '../confirmation-bus/message-bus.js'
 *   tools.*     ← './tools.js'
 *   Config      ← '../config/config.js'
 */

import type { MessageBus, Config, ToolLocation, ToolInvocation } from './gemini-cli-types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind, type ToolResult } from './gemini-cli-types.js';
import {
  HEAP_SNAPSHOT_CAPTURE_TOOL_NAME,
  HEAP_SNAPSHOT_CAPTURE_DISPLAY_NAME,
  HEAP_SNAPSHOT_CAPTURE_DEFINITION,
} from './tool-definitions.js';
import { captureHeapSnapshot } from '../capture/heap-snapshot-capture.js';
import type { CaptureOptions } from '../types.js';
import { PerfCompanionError } from '../errors.js';
import { formatBytes } from '../utils.js';

// ─── Parameters ──────────────────────────────────────────────────────

export interface HeapSnapshotCaptureParams {
  readonly target: 'self' | 'remote';
  readonly host?: string;
  readonly port?: number;
  readonly label?: string;
  readonly output_dir?: string;
  readonly force_gc?: boolean;
  readonly timeout_ms?: number;
}

// ─── Invocation ──────────────────────────────────────────────────────

class HeapSnapshotCaptureInvocation extends BaseToolInvocation<
  HeapSnapshotCaptureParams,
  ToolResult
> {
  constructor(
    _config: Config, // Used after integration for path resolution via config.workingDir.
    params: HeapSnapshotCaptureParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    if (this.params.target === 'remote') {
      const host = this.params.host ?? '127.0.0.1';
      const port = this.params.port ?? 9229;
      return `Capture heap snapshot from ${host}:${port}`;
    }
    return 'Capture heap snapshot (self)';
  }

  override toolLocations(): ToolLocation[] {
    return [];
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) {
      return {
        llmContent: 'Heap snapshot capture was cancelled.',
        returnDisplay: 'Cancelled.',
        error: { message: 'Capture cancelled by user.' },
      };
    }

    const options: CaptureOptions = {
      target: this.params.target,
      host: this.params.host,
      port: this.params.port,
      label: this.params.label,
      outputDir: this.params.output_dir,
      forceGc: this.params.force_gc,
      timeoutMs: this.params.timeout_ms,
    };

    try {
      const result = await captureHeapSnapshot(options);
      const sizeStr = formatBytes(result.sizeBytes);

      return {
        llmContent:
          `Heap snapshot saved to ${result.filePath} ` +
          `(${sizeStr}, ${result.durationMs}ms). ` +
          `Use heap_snapshot_analyze with this path to detect leaks.`,
        returnDisplay:
          `Heap snapshot captured successfully.\n` +
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
      const recoverable =
        err instanceof PerfCompanionError ? err.recoverable : false;

      return {
        llmContent: `Heap snapshot capture failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message },
        data: { recoverable },
      };
    }
  }
}

// ─── Tool Class ──────────────────────────────────────────────────────

export class HeapSnapshotCaptureTool extends BaseDeclarativeTool<
  HeapSnapshotCaptureParams,
  ToolResult
> {
  static readonly Name = HEAP_SNAPSHOT_CAPTURE_TOOL_NAME;
  private readonly config: Config;

  constructor(config: Config, messageBus: MessageBus) {
    super(
      HeapSnapshotCaptureTool.Name,
      HEAP_SNAPSHOT_CAPTURE_DISPLAY_NAME,
      HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.description,
      Kind.Execute,
      HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.parametersJsonSchema,
      messageBus,
    );
    this.config = config;
  }

  protected validateToolParamValues(
    params: HeapSnapshotCaptureParams,
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
        return 'Remote capture only supports localhost connections (127.0.0.1, localhost, ::1).';
      }
    }
    if (params.timeout_ms !== undefined && params.timeout_ms < 1000) {
      return 'Timeout must be at least 1000ms.';
    }
    return null;
  }

  protected createInvocation(
    params: HeapSnapshotCaptureParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<HeapSnapshotCaptureParams, ToolResult> {
    return new HeapSnapshotCaptureInvocation(
      this.config, params, messageBus, toolName, toolDisplayName,
    );
  }
}
