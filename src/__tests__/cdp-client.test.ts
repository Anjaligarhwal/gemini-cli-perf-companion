/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { CdpClient } from '../capture/cdp-client.js';
import { PerfCompanionError } from '../errors.js';

// ─── Test Infrastructure ─────────────────────────────────────────────

/**
 * Minimal mock inspector server that:
 *   1. Responds to GET /json/version with a WebSocket URL.
 *   2. Accepts WebSocket upgrades.
 *   3. Echoes CDP requests back as responses.
 *   4. Can emit CDP events.
 */
class MockInspectorServer {
  private server: http.Server;
  private connections: import('node:net').Socket[] = [];
  readonly port: number;
  private _onMessage?: (msg: Record<string, unknown>, socket: import('node:net').Socket) => void;

  constructor(port: number = 0) {
    this.port = port;
    this.server = http.createServer();
  }

  /** Set a handler for incoming CDP messages. */
  onMessage(
    handler: (msg: Record<string, unknown>, socket: import('node:net').Socket) => void,
  ): void {
    this._onMessage = handler;
  }

  async start(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        const actualPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        (this as { port: number }).port = actualPort;

        // Handle /json/version discovery.
        this.server.on('request', (req, res) => {
          if (req.url === '/json/version') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                webSocketDebuggerUrl: `ws://127.0.0.1:${actualPort}/ws`,
              }),
            );
          } else {
            res.writeHead(404);
            res.end();
          }
        });

        // Handle WebSocket upgrades.
        this.server.on('upgrade', (req, socket, head) => {
          this.connections.push(socket);
          socket.on('error', () => {}); // Suppress ECONNRESET on teardown.

          // Compute Sec-WebSocket-Accept per RFC 6455.
          const key = req.headers['sec-websocket-key'] ?? '';
          const accept = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-5AB9FAF1E3B3')
            .digest('base64');

          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Accept: ${accept}\r\n` +
              '\r\n',
          );

          if (head.length > 0) {
            this.processData(head, socket);
          }

          socket.on('data', (data: Buffer) => {
            this.processData(data, socket);
          });
        });

        resolve(actualPort);
      });
    });
  }

  /** Send a CDP event to all connected clients. */
  sendEvent(method: string, params: Record<string, unknown>): void {
    const message = JSON.stringify({ method, params });
    for (const socket of this.connections) {
      this.sendFrame(socket, message);
    }
  }

  /** Send a CDP response to a specific socket. */
  sendResponse(
    socket: import('node:net').Socket,
    id: number,
    result: Record<string, unknown>,
  ): void {
    const message = JSON.stringify({ id, result });
    this.sendFrame(socket, message);
  }

  async stop(): Promise<void> {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections = [];
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /** Send an unmasked server text frame. */
  private sendFrame(socket: import('node:net').Socket, payload: string): void {
    if (socket.destroyed) return;
    const data = Buffer.from(payload, 'utf-8');
    const length = data.length;

    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }

    socket.write(Buffer.concat([header, data]));
  }

  /** Parse a masked client frame and dispatch to the message handler. */
  private processData(data: Buffer, socket: import('node:net').Socket): void {
    if (data.length < 6) return; // Minimum: 2 header + 4 mask

    const payloadLength = data[1] & 0x7f;
    let offset = 2;

    let actualLength = payloadLength;
    if (payloadLength === 126) {
      actualLength = data.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      actualLength = data.readUInt32BE(6);
      offset = 10;
    }

    const maskingKey = data.subarray(offset, offset + 4);
    offset += 4;

    const masked = data.subarray(offset, offset + actualLength);
    const unmasked = Buffer.alloc(actualLength);
    for (let i = 0; i < actualLength; i++) {
      unmasked[i] = masked[i] ^ maskingKey[i % 4];
    }

    const text = unmasked.toString('utf-8');

    try {
      const msg = JSON.parse(text) as Record<string, unknown>;
      if (this._onMessage) {
        this._onMessage(msg, socket);
      }
    } catch {
      // Ignore non-JSON frames (e.g., close frames).
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('CdpClient', () => {
  let server: MockInspectorServer;
  let client: CdpClient;
  let port: number;

  beforeEach(async () => {
    server = new MockInspectorServer();
    port = await server.start();
    client = new CdpClient();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
  });

  describe('connection', () => {
    it('should connect to a mock inspector server', async () => {
      await client.connect({ port });
      expect(client.isConnected).toBe(true);
    });

    it('should reject connection to non-existent port', async () => {
      await expect(
        client.connect({ port: 19999, timeoutMs: 1000 }),
      ).rejects.toThrow(PerfCompanionError);
    });

    it('should handle double connect gracefully', async () => {
      await client.connect({ port });
      await client.connect({ port }); // Should be a no-op
      expect(client.isConnected).toBe(true);
    });

    it('should handle disconnect without connect', async () => {
      await expect(client.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('send/receive', () => {
    it('should send a CDP method and receive a response', async () => {
      server.onMessage((msg, socket) => {
        const id = msg['id'] as number;
        server.sendResponse(socket, id, { enabled: true });
      });

      await client.connect({ port });
      const result = await client.send('HeapProfiler.enable');
      expect(result).toEqual({ enabled: true });
    });

    it('should handle CDP error responses', async () => {
      server.onMessage((msg, socket) => {
        const id = msg['id'] as number;
        const errorResponse = JSON.stringify({
          id,
          error: { code: -32601, message: 'Method not found' },
        });
        // Send raw frame manually since sendResponse only sends result.
        const data = Buffer.from(errorResponse, 'utf-8');
        const header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = data.length;
        socket.write(Buffer.concat([header, data]));
      });

      await client.connect({ port });
      await expect(client.send('Nonexistent.method')).rejects.toThrow(
        'Method not found',
      );
    });

    it('should reject sends when not connected', async () => {
      await expect(client.send('HeapProfiler.enable')).rejects.toThrow(
        'CDP client is not connected',
      );
    });
  });

  describe('events', () => {
    it('should emit CDP events from the server', async () => {
      server.onMessage((msg, socket) => {
        const id = msg['id'] as number;
        const method = msg['method'] as string;

        if (method === 'HeapProfiler.takeHeapSnapshot') {
          // Send chunk events before the response.
          server.sendEvent('HeapProfiler.addHeapSnapshotChunk', {
            chunk: '{"snapshot":',
          });
          server.sendEvent('HeapProfiler.addHeapSnapshotChunk', {
            chunk: '{"meta":{}}}',
          });
          // Then send the method response.
          setTimeout(() => server.sendResponse(socket, id, {}), 10);
        } else {
          server.sendResponse(socket, id, {});
        }
      });

      await client.connect({ port });

      const chunks: string[] = [];
      client.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
        const p = params as { chunk: string };
        chunks.push(p.chunk);
      });

      await client.send('HeapProfiler.takeHeapSnapshot', {
        reportProgress: false,
      });

      // Wait for events to be processed.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.join('')).toContain('snapshot');
    });
  });

  describe('multiple methods', () => {
    it('should handle sequential CDP calls', async () => {
      server.onMessage((msg, socket) => {
        const id = msg['id'] as number;
        const method = msg['method'] as string;
        server.sendResponse(socket, id, { method });
      });

      await client.connect({ port });

      const r1 = await client.send('HeapProfiler.enable');
      const r2 = await client.send('HeapProfiler.collectGarbage');
      const r3 = await client.send('HeapProfiler.disable');

      expect(r1).toEqual({ method: 'HeapProfiler.enable' });
      expect(r2).toEqual({ method: 'HeapProfiler.collectGarbage' });
      expect(r3).toEqual({ method: 'HeapProfiler.disable' });
    });
  });

  describe('disconnect cleanup', () => {
    it('should reject pending requests on disconnect', async () => {
      // Server never responds — simulates a hang.
      server.onMessage(() => {});

      await client.connect({ port });

      const sendPromise = client.send('HeapProfiler.takeHeapSnapshot');

      // Disconnect while the request is pending.
      await client.disconnect();

      await expect(sendPromise).rejects.toThrow('disconnected');
    });

    it('should report isConnected as false after disconnect', async () => {
      await client.connect({ port });
      expect(client.isConnected).toBe(true);

      await client.disconnect();
      expect(client.isConnected).toBe(false);
    });
  });
});
