/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck — This file targets gemini-cli's packages/core/src/tools/.
// Imports resolve only when placed inside the gemini-cli monorepo.

/**
 * BaseDeclarativeTool integration for heap snapshot capture.
 *
 * This file follows the exact pattern from gemini-cli's ReadFileTool
 * and WebFetchTool. It will be placed at:
 *   packages/core/src/tools/heap-snapshot-capture.ts
 *
 * Registration in config.ts:
 *   maybeRegister(HeapSnapshotCaptureTool, () =>
 *     registry.registerTool(new HeapSnapshotCaptureTool(this, this.messageBus)),
 *   );
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
  HEAP_SNAPSHOT_CAPTURE_TOOL_NAME,
  HEAP_SNAPSHOT_CAPTURE_DISPLAY_NAME,
  HEAP_SNAPSHOT_CAPTURE_DEFINITION,
} from './definitions/coreTools.js';
import { captureHeapSnapshot } from '../perf-companion/capture/heap-snapshot-capture.js';
import type { CaptureOptions } from '../perf-companion/types.js';
import { PerfCompanionError } from '../perf-companion/errors.js';
import { formatBytes } from '../perf-companion/utils.js';

// ─── Parameters ──────────────────────────────────────────────────────

export interface HeapSnapshotCaptureParams {
  target: 'self' | 'remote';
  host?: string;
  port?: number;
  label?: string;
  output_dir?: string;
  force_gc?: boolean;
  timeout_ms?: number;
}

// ─── Invocation ──────────────────────────────────────────────────────

class HeapSnapshotCaptureInvocation extends BaseToolInvocation<
  HeapSnapshotCaptureParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: HeapSnapshotCaptureParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
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
    // No filesystem location to highlight — output path is dynamic.
    return [];
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
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
      // Respect abort signal.
      if (signal.aborted) {
        return {
          llmContent: 'Heap snapshot capture was cancelled.',
          returnDisplay: 'Cancelled.',
          error: { message: 'Capture cancelled by user.' },
        };
      }

      const result = await captureHeapSnapshot(options);

      const sizeStr = formatBytes(result.sizeBytes);
      const summary =
        `Heap snapshot captured successfully.\n` +
        `- **File:** \`${result.filePath}\`\n` +
        `- **Size:** ${sizeStr}\n` +
        `- **Duration:** ${result.durationMs}ms\n` +
        `- **Label:** ${result.label}`;

      const llmContent =
        `Heap snapshot saved to ${result.filePath} ` +
        `(${sizeStr}, ${result.durationMs}ms). ` +
        `Use heap_snapshot_analyze with this path to detect leaks.`;

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

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      HeapSnapshotCaptureTool.Name,
      HEAP_SNAPSHOT_CAPTURE_DISPLAY_NAME,
      HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.description,
      Kind.Execute, // Captures have side effects (write files).
      HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,  // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected override validateToolParamValues(
    params: HeapSnapshotCaptureParams,
  ): string | null {
    if (params.target === 'remote') {
      if (params.port !== undefined && (params.port < 1 || params.port > 65535)) {
        return 'Port must be between 1 and 65535.';
      }
      // Security: only allow localhost connections.
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
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<HeapSnapshotCaptureParams, ToolResult> {
    return new HeapSnapshotCaptureInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}

