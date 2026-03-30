/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interface definitions for gemini-cli framework types.
 *
 * These define the contract that integration tools depend on. They match
 * the signatures from gemini-cli's packages/core/src/ (v0.36.0-nightly).
 *
 * During GSoC integration, this file is deleted and each import is
 * redirected to the real module:
 *
 *   MessageBus        ← '../confirmation-bus/message-bus.js'
 *   Config            ← '../config/config.js'
 *   BaseDeclarativeTool, BaseToolInvocation, Kind,
 *   ToolInvocation, ToolLocation, ToolResult ← './tools.js'
 *
 * This is dependency inversion: we define the interfaces we need,
 * program against them, and swap implementations at integration time.
 */

// ─── Message Bus ────────────────────────────────────────────────────

export interface MessageBus {
  publish(topic: string, message: unknown): void;
  subscribe(topic: string, handler: (message: unknown) => void): void;
}

// ─── Config ─────────────────────────────────────────────────────────

export interface Config {
  readonly workingDir: string;
}

// ─── Tool Kind ──────────────────────────────────────────────────────

export enum Kind {
  Read = 'read',
  Execute = 'execute',
  Agent = 'agent',
  ReadStream = 'read_stream',
  Shell = 'shell',
}

// ─── Tool Result ────────────────────────────────────────────────────

export interface ToolResult {
  readonly llmContent: string;
  readonly returnDisplay: string;
  readonly data?: unknown;
  readonly error?: { readonly message: string };
}

// ─── Tool Location ──────────────────────────────────────────────────

export interface ToolLocation {
  readonly filePath: string;
  readonly description?: string;
}

// ─── Tool Invocation ────────────────────────────────────────────────

export interface ToolInvocation<TParams, TResult> {
  readonly params: TParams;
  getDescription(): string;
  toolLocations(): ToolLocation[];
  execute(signal: AbortSignal): Promise<TResult>;
}

// ─── Base Tool Invocation ───────────────────────────────────────────

export abstract class BaseToolInvocation<TParams extends object, TResult>
  implements ToolInvocation<TParams, TResult>
{
  readonly params: TParams;

  constructor(
    params: TParams,
    protected readonly messageBus: MessageBus,
    protected readonly toolName?: string,
    protected readonly toolDisplayName?: string,
  ) {
    this.params = params;
  }

  abstract getDescription(): string;

  toolLocations(): ToolLocation[] {
    return [];
  }

  abstract execute(signal: AbortSignal): Promise<TResult>;
}

// ─── Base Declarative Tool ──────────────────────────────────────────

export abstract class BaseDeclarativeTool<
  TParams extends object,
  TResult extends ToolResult,
> {
  constructor(
    public readonly name: string,
    public readonly displayName: string,
    public readonly description: string,
    public readonly kind: Kind,
    protected readonly parameterSchema: unknown,
    protected readonly messageBus: MessageBus,
    protected readonly isOutputMarkdown: boolean = true,
    protected readonly canUpdateOutput: boolean = false,
  ) {}

  build(params: TParams, messageBus: MessageBus): ToolInvocation<TParams, TResult> {
    const error = this.validateToolParamValues(params);
    if (error !== null) {
      throw new Error(error);
    }
    return this.createInvocation(params, messageBus);
  }

  protected abstract validateToolParamValues(params: TParams): string | null;

  protected abstract createInvocation(
    params: TParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<TParams, TResult>;
}
