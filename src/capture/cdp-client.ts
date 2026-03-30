/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal Chrome DevTools Protocol client over WebSocket.
 *
 * Connects to a Node.js process started with `--inspect` or
 * `--inspect-brk` and sends/receives CDP messages.  Uses only
 * `node:http` and `node:crypto` — zero external dependencies.
 *
 * Protocol overview:
 *   1. HTTP GET `http://{host}:{port}/json/version` to discover
 *      the debugger WebSocket URL.
 *   2. WebSocket upgrade via `node:http` with RFC 6455 handshake.
 *   3. JSON-RPC 2.0 messages over WebSocket frames.
 *
 * Why not `node:inspector`?
 *   `node:inspector` only connects to the *current* V8 isolate.
 *   To profile external processes (a user's app, Gemini CLI itself,
 *   or any `--inspect` process), CDP over WebSocket is required.
 *
 * Security considerations:
 *   - Only connects to localhost by default.
 *   - Validates the WebSocket URL before connecting.
 *   - Connection timeout prevents hanging on unreachable targets.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { PerfCompanionError, PerfErrorCode } from '../errors.js';

// ─── Configuration ───────────────────────────────────────────────────

/** Options for connecting to a remote debugger. */
export interface CdpConnectionOptions {
  /** Target host. @defaultValue '127.0.0.1' */
  readonly host?: string;
  /** Target debug port. @defaultValue 9229 */
  readonly port?: number;
  /** Connection timeout in milliseconds. @defaultValue 10_000 */
  readonly timeoutMs?: number;
}

/** Represents a CDP JSON-RPC request. */
interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Represents a CDP JSON-RPC response. */
interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Represents a CDP event notification. */
interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
}

/** Pending request awaiting a response. */
interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9229;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Maximum CDP response message size: 256 MB. */
const MAX_MESSAGE_SIZE = 268_435_456;

/** Per-method timeout for CDP calls. */
const METHOD_TIMEOUT_MS = 60_000;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Chrome DevTools Protocol client.
 *
 * Emits CDP events as Node.js EventEmitter events, keyed by the
 * CDP method name (e.g., `'HeapProfiler.addHeapSnapshotChunk'`).
 *
 * @example
 * ```ts
 * const client = new CdpClient();
 * await client.connect({ port: 9229 });
 *
 * client.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
 *   chunks.push(params.chunk);
 * });
 *
 * await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
 * await client.disconnect();
 * ```
 */
export class CdpClient extends EventEmitter {
  private rawSocket: import('node:net').Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private connected = false;
  private receiveBuffer = Buffer.alloc(0);

  // ── Connection Lifecycle ──────────────────────────────────────────

  /**
   * Connect to a Node.js debugger via CDP WebSocket.
   *
   * Steps:
   *   1. Discover the debugger WebSocket URL via HTTP.
   *   2. Perform the WebSocket upgrade handshake.
   *   3. Begin listening for CDP messages.
   *
   * @throws {PerfCompanionError} If the target is unreachable or the
   *   handshake fails.
   */
  async connect(options?: CdpConnectionOptions): Promise<void> {
    if (this.connected) return;

    const host = options?.host ?? DEFAULT_HOST;
    const port = options?.port ?? DEFAULT_PORT;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Step 1: Discover the WebSocket debugger URL.
    const wsUrl = await this.discoverWsUrl(host, port, timeoutMs);

    // Step 2: Perform WebSocket upgrade.
    await this.performUpgrade(wsUrl, timeoutMs);

    this.connected = true;
  }

  /**
   * Send a CDP method call and wait for its response.
   *
   * @param method - CDP method name (e.g., `'HeapProfiler.enable'`).
   * @param params - Optional method parameters.
   * @returns The CDP response result object.
   * @throws {PerfCompanionError} If the call fails or times out.
   */
  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.connected || this.rawSocket === null) {
      throw new PerfCompanionError(
        'CDP client is not connected',
        PerfErrorCode.INSPECTOR_CONNECT_FAILED,
        false,
      );
    }

    const id = this.nextId++;
    const request: CdpRequest = { id, method };
    if (params !== undefined) {
      request.params = params;
    }

    const payload = JSON.stringify(request);
    this.sendWebSocketFrame(payload);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new PerfCompanionError(
            `CDP call '${method}' timed out after ${METHOD_TIMEOUT_MS}ms`,
            PerfErrorCode.CAPTURE_TIMEOUT,
            true,
          ),
        );
      }, METHOD_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /**
   * Gracefully disconnect from the debugger.
   *
   * Rejects all pending requests, closes the socket, and cleans up.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    // Reject outstanding requests.
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new PerfCompanionError(
          'CDP client disconnected',
          PerfErrorCode.INSPECTOR_CONNECT_FAILED,
          false,
        ),
      );
      this.pending.delete(id);
    }

    // Send WebSocket close frame (opcode 0x8).
    if (this.rawSocket !== null && !this.rawSocket.destroyed) {
      this.sendCloseFrame();
      this.rawSocket.end();
    }

    this.rawSocket = null;
    this.connected = false;
    this.receiveBuffer = Buffer.alloc(0);
  }

  /** Whether the client is currently connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  // ── WebSocket Discovery ───────────────────────────────────────────

  /**
   * Discover the debugger WebSocket URL.
   *
   * Tries two V8 inspector HTTP endpoints in order:
   *   1. `/json/version` — returns `{ webSocketDebuggerUrl }` on some
   *      Node.js versions (< v22).
   *   2. `/json` — returns a target list `[{ webSocketDebuggerUrl }]`.
   *      This is the primary endpoint on Node.js v22+ where the version
   *      endpoint no longer includes the WebSocket URL.
   *
   * This two-step discovery ensures compatibility across Node.js 18–22+.
   */
  private async discoverWsUrl(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<string> {
    // Attempt 1: /json/version (returns object with optional wsUrl).
    const versionBody = await this.httpGetWithTimeout(
      `http://${host}:${port}/json/version`,
      timeoutMs,
    );

    try {
      const info = JSON.parse(versionBody) as Record<string, string>;
      const wsUrl = info['webSocketDebuggerUrl'];
      if (typeof wsUrl === 'string' && wsUrl.startsWith('ws://')) {
        return wsUrl;
      }
    } catch {
      // Fall through to /json endpoint.
    }

    // Attempt 2: /json (returns array of targets).
    const listBody = await this.httpGetWithTimeout(
      `http://${host}:${port}/json`,
      timeoutMs,
    );

    try {
      const targets = JSON.parse(listBody) as Array<Record<string, string>>;
      if (Array.isArray(targets) && targets.length > 0) {
        const wsUrl = targets[0]['webSocketDebuggerUrl'];
        if (typeof wsUrl === 'string' && wsUrl.startsWith('ws://')) {
          return wsUrl;
        }
      }
    } catch {
      // Fall through to error.
    }

    throw new PerfCompanionError(
      `Could not discover WebSocket URL from ${host}:${port}. ` +
        'Neither /json/version nor /json returned a valid webSocketDebuggerUrl. ' +
        'Ensure the target process is running with --inspect.',
      PerfErrorCode.INSPECTOR_CONNECT_FAILED,
      /* recoverable= */ false,
    );
  }

  /**
   * HTTP GET with timeout, returning the response body as a string.
   *
   * @throws {PerfCompanionError} On timeout or connection error.
   */
  private httpGetWithTimeout(url: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(
          new PerfCompanionError(
            `Discovery timed out connecting to ${url}`,
            PerfErrorCode.INSPECTOR_CONNECT_FAILED,
            /* recoverable= */ true,
          ),
        );
      }, timeoutMs);

      const req = http.get(url, (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve(body);
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new PerfCompanionError(
            `Cannot connect to debugger at ${url}: ${err.message}. ` +
              'Ensure the target process is running with --inspect.',
            PerfErrorCode.INSPECTOR_CONNECT_FAILED,
            /* recoverable= */ true,
          ),
        );
      });
    });
  }

  // ── WebSocket Handshake ───────────────────────────────────────────

  /**
   * Perform the RFC 6455 WebSocket upgrade handshake.
   *
   * Uses `node:http` request with `Connection: Upgrade` headers.
   * The server responds with `101 Switching Protocols` if the
   * handshake succeeds, giving us a raw TCP socket for framing.
   */
  private performUpgrade(wsUrl: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const parsed = new URL(wsUrl);
      const key = crypto.randomBytes(16).toString('base64');

      const timer = setTimeout(() => {
        req.destroy();
        reject(
          new PerfCompanionError(
            `WebSocket handshake timed out after ${timeoutMs}ms`,
            PerfErrorCode.INSPECTOR_CONNECT_FAILED,
            true,
          ),
        );
      }, timeoutMs);

      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (_res, socket, head) => {
        clearTimeout(timer);

        this.rawSocket = socket;

        // Process any data included in the upgrade response.
        if (head.length > 0) {
          this.onSocketData(head);
        }

        socket.on('data', (data: Buffer) => this.onSocketData(data));
        socket.on('close', () => this.onSocketClose());
        socket.on('error', (err: Error) => this.onSocketError(err));

        resolve();
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new PerfCompanionError(
            `WebSocket upgrade failed: ${err.message}`,
            PerfErrorCode.INSPECTOR_CONNECT_FAILED,
            true,
          ),
        );
      });

      req.end();
    });
  }

  // ── WebSocket Framing (RFC 6455) ──────────────────────────────────

  /**
   * Send a text frame with client masking per RFC 6455.
   *
   * Frame format:
   *   - Byte 0: FIN=1, opcode=0x1 (text) → 0x81
   *   - Byte 1: MASK=1 + payload length
   *   - Bytes 2-5: 4-byte masking key
   *   - Remaining: masked payload
   *
   * Clients MUST mask all frames (RFC 6455 §5.1).
   */
  private sendWebSocketFrame(payload: string): void {
    const socket = this.rawSocket;
    if (socket === null || socket.destroyed) return;

    const data = Buffer.from(payload, 'utf-8');
    const maskingKey = crypto.randomBytes(4);
    const length = data.length;

    // Determine payload length encoding.
    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x81; // FIN + text opcode
      header[1] = 0x80 | length; // MASK + 7-bit length
      maskingKey.copy(header, 2);
    } else if (length < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x81;
      header[1] = 0x80 | 126; // MASK + 16-bit length follows
      header.writeUInt16BE(length, 2);
      maskingKey.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x81;
      header[1] = 0x80 | 127; // MASK + 64-bit length follows
      // Node.js Buffer doesn't have writeUInt64BE, so write as two 32-bit.
      header.writeUInt32BE(0, 2); // High 32 bits (always 0 for realistic sizes)
      header.writeUInt32BE(length, 6);
      maskingKey.copy(header, 10);
    }

    // Apply XOR mask to payload (RFC 6455 §5.3).
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
      masked[i] = data[i] ^ maskingKey[i % 4];
    }

    socket.write(Buffer.concat([header, masked]));
  }

  /** Send a WebSocket close frame (opcode 0x8). */
  private sendCloseFrame(): void {
    const socket = this.rawSocket;
    if (socket === null || socket.destroyed) return;

    const maskingKey = crypto.randomBytes(4);
    const frame = Buffer.alloc(6);
    frame[0] = 0x88; // FIN + close opcode
    frame[1] = 0x80; // MASK + 0 length
    maskingKey.copy(frame, 2);
    socket.write(frame);
  }

  // ── Receive Path ──────────────────────────────────────────────────

  /**
   * Process incoming WebSocket data.
   *
   * Accumulates data in `receiveBuffer`, extracts complete frames,
   * and dispatches their payloads to `handleMessage`.
   *
   * Server frames are NOT masked (RFC 6455 §5.1: server-to-client
   * frames MUST NOT be masked).
   */
  private onSocketData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    // Process all complete frames in the buffer.
    while (this.receiveBuffer.length >= 2) {
      const frame = this.parseFrame();
      if (frame === null) break; // Incomplete frame, wait for more data.

      // Only process text frames (opcode 0x1) and close frames (0x8).
      if (frame.opcode === 0x1) {
        this.handleMessage(frame.payload.toString('utf-8'));
      } else if (frame.opcode === 0x8) {
        // Server initiated close — best-effort cleanup; errors during
        // teardown are non-recoverable and safe to discard.
        this.disconnect().catch(() => {});
        break;
      } else if (frame.opcode === 0x9) {
        // Ping — respond with pong (opcode 0xA).
        this.sendPong(frame.payload);
      }
      // Ignore pong frames (0xA) and other opcodes.
    }
  }

  /**
   * Parse a single WebSocket frame from `receiveBuffer`.
   *
   * Returns null if the buffer doesn't contain a complete frame.
   * Consumes the frame bytes from the buffer on success.
   */
  private parseFrame(): { opcode: number; payload: Buffer } | null {
    const buf = this.receiveBuffer;
    if (buf.length < 2) return null;

    const opcode = buf[0] & 0x0f;
    const isMasked = (buf[1] & 0x80) !== 0;
    let payloadLength = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buf.length < 4) return null;
      payloadLength = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (buf.length < 10) return null;
      // Read as 64-bit, but only use the lower 32 bits for safety.
      const high = buf.readUInt32BE(2);
      const low = buf.readUInt32BE(6);
      if (high > 0) {
        // Payload > 4 GB — reject to prevent OOM.  Best-effort teardown;
        // errors during cleanup are non-recoverable and safe to discard.
        this.disconnect().catch(() => {});
        return null;
      }
      payloadLength = low;
      offset = 10;
    }

    // Guard against pathological payloads.  Best-effort teardown;
    // errors during cleanup are non-recoverable and safe to discard.
    if (payloadLength > MAX_MESSAGE_SIZE) {
      this.disconnect().catch(() => {});
      return null;
    }

    // Server frames should not be masked, but handle it if they are.
    let maskingKey: Buffer | null = null;
    if (isMasked) {
      if (buf.length < offset + 4) return null;
      maskingKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    const totalFrameLength = offset + payloadLength;
    if (buf.length < totalFrameLength) return null; // Incomplete.

    let payload = buf.subarray(offset, totalFrameLength);

    // Unmask if needed.
    if (maskingKey !== null) {
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i++) {
        unmasked[i] = payload[i] ^ maskingKey[i % 4];
      }
      payload = unmasked;
    }

    // Consume the frame from the buffer.
    this.receiveBuffer = buf.subarray(totalFrameLength);

    return { opcode, payload };
  }

  /** Respond to a server ping with a pong carrying the same payload. */
  private sendPong(payload: Buffer): void {
    const socket = this.rawSocket;
    if (socket === null || socket.destroyed) return;

    const maskingKey = crypto.randomBytes(4);
    const length = payload.length;

    const header = Buffer.alloc(6 + length);
    header[0] = 0x8a; // FIN + pong opcode
    header[1] = 0x80 | length;
    maskingKey.copy(header, 2);

    for (let i = 0; i < length; i++) {
      header[6 + i] = payload[i] ^ maskingKey[i % 4];
    }

    socket.write(header);
  }

  // ── Message Dispatch ──────────────────────────────────────────────

  /**
   * Handle a complete CDP JSON message.
   *
   * CDP messages are either:
   *   - Responses: `{ id: number, result: ... }` — resolve the
   *     corresponding pending promise.
   *   - Events: `{ method: string, params: ... }` — emit as a
   *     Node.js EventEmitter event.
   */
  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Malformed JSON — ignore.
      return;
    }

    if ('id' in message) {
      // Response to a previous request.
      const response = message as unknown as CdpResponse;
      const pending = this.pending.get(response.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(response.id);

        if (response.error !== undefined) {
          pending.reject(
            new PerfCompanionError(
              `CDP error in request ${response.id}: ${response.error.message}`,
              PerfErrorCode.INSPECTOR_CONNECT_FAILED,
              false,
            ),
          );
        } else {
          pending.resolve(response.result ?? {});
        }
      }
    } else if ('method' in message) {
      // Event notification.
      const event = message as unknown as CdpEvent;
      this.emit(event.method, event.params ?? {});
    }
  }

  // ── Socket Event Handlers ─────────────────────────────────────────

  private onSocketClose(): void {
    this.connected = false;
    // Reject all pending requests.
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new PerfCompanionError(
          'WebSocket connection closed unexpectedly',
          PerfErrorCode.INSPECTOR_CONNECT_FAILED,
          true,
        ),
      );
      this.pending.delete(id);
    }
    this.emit('close');
  }

  private onSocketError(err: Error): void {
    // Suppress ECONNRESET during intentional disconnect — this is
    // expected when the client initiates close before the server
    // has finished processing.
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ECONNRESET' && !this.connected) return;

    this.emit('error', err);
  }
}
