/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseHeapSnapshotStreaming } from '../parse/streaming-snapshot-parser.js';
import { parseHeapSnapshotFull } from '../parse/heap-snapshot-parser.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';

// ─── Test Fixtures ──────────────────────────────────────────────────

/**
 * Minimal valid V8 heap snapshot JSON.
 *
 * 3 nodes, 1 edge, 4 strings — same fixture used by the batch parser
 * tests, ensuring identical output between both parsers.
 */
function buildMinimalSnapshot(): object {
  return {
    snapshot: {
      meta: {
        node_fields: [
          'type',
          'name',
          'id',
          'self_size',
          'edge_count',
          'trace_node_id',
          'detachedness',
        ],
        node_types: [
          [
            'hidden',
            'array',
            'string',
            'object',
            'code',
            'closure',
            'regexp',
            'number',
            'native',
            'synthetic',
          ],
          'string',
          'number',
          'number',
          'number',
          'number',
          'number',
        ],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [
          [
            'context',
            'element',
            'property',
            'internal',
            'hidden',
            'shortcut',
            'weak',
          ],
          'string_or_number',
          'node',
        ],
        trace_function_info_fields: [],
        trace_node_fields: [],
        sample_fields: [],
        location_fields: [],
      },
      node_count: 3,
      edge_count: 1,
    },
    nodes: [
      3, 0, 1, 1024, 1, 0, 0, 3, 1, 3, 512, 0, 0, 0, 9, 2, 5, 0, 0, 0, 0,
    ],
    edges: [2, 3, 7],
    trace_function_infos: [],
    trace_tree: [],
    samples: [],
    locations: [],
    strings: ['LeakyCache', 'EventEmitter', '(GC roots)', 'listener'],
  };
}

/**
 * Snapshot with string escape sequences in the string table.
 */
function buildEscapeSequenceSnapshot(): object {
  const base = buildMinimalSnapshot() as Record<string, unknown>;
  base['strings'] = [
    'normal',
    'with\ttab',
    'with\nnewline',
    'with"quote',
    'with\\backslash',
    'listener',
  ];
  return base;
}

/**
 * Snapshot with unicode escapes in the string table.
 *
 * When JSON.stringify encodes these strings, they'll contain \uXXXX
 * escapes that the streaming parser must decode.
 */
function buildUnicodeSnapshot(): object {
  const base = buildMinimalSnapshot() as Record<string, unknown>;
  // Include characters that JSON.stringify will escape as \uXXXX.
  base['strings'] = [
    'caf\u00e9',
    '\u0041\u0042\u0043',
    '(GC roots)',
    'listener',
  ];
  return base;
}

/**
 * Snapshot with extra unrecognized top-level sections.
 */
function buildSnapshotWithExtraSections(): object {
  const base = buildMinimalSnapshot() as Record<string, unknown>;
  // Add sections that should be skipped.
  (base as Record<string, unknown>)['custom_data'] = { nested: { deep: [1, 2, 3] } };
  (base as Record<string, unknown>)['another_array'] = [10, 20, [30, 40]];
  return base;
}

/**
 * Snapshot with empty nodes, edges, and strings arrays.
 */
function buildEmptyArraysSnapshot(): object {
  const base = buildMinimalSnapshot() as Record<string, unknown>;
  const snapshot = base['snapshot'] as Record<string, unknown>;
  snapshot['node_count'] = 0;
  snapshot['edge_count'] = 0;
  base['nodes'] = [];
  base['edges'] = [];
  base['strings'] = [];
  return base;
}

// ─── Temp Directory Management ──────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `perf-streaming-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeSnapshot(
  name: string,
  data: object,
): Promise<string> {
  const filePath = join(testDir, name);
  await writeFile(filePath, JSON.stringify(data), 'utf-8');
  return filePath;
}

async function writePrettySnapshot(
  name: string,
  data: object,
): Promise<string> {
  const filePath = join(testDir, name);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

// ─── Correctness Tests ──────────────────────────────────────────────

describe('parseHeapSnapshotStreaming', () => {
  describe('correctness', () => {
    it('should parse a minimal snapshot and return correct summary', async () => {
      const filePath = await writeSnapshot(
        'stream-minimal.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const result = await parseHeapSnapshotStreaming(filePath);

      expect(result.summary.nodeCount).toBe(3);
      expect(result.summary.edgeCount).toBe(1);
      expect(result.summary.stringCount).toBe(4);
      expect(result.summary.totalSize).toBe(1536);
    });

    it('should produce identical results to the batch parser', async () => {
      const filePath = await writeSnapshot(
        'stream-vs-batch.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const batchResult = await parseHeapSnapshotFull(filePath);
      const streamResult = await parseHeapSnapshotStreaming(filePath);

      // Node-level comparison.
      expect(streamResult.nodes.length).toBe(batchResult.nodes.length);
      for (let i = 0; i < streamResult.nodes.length; i++) {
        expect(streamResult.nodes[i].type).toBe(batchResult.nodes[i].type);
        expect(streamResult.nodes[i].name).toBe(batchResult.nodes[i].name);
        expect(streamResult.nodes[i].id).toBe(batchResult.nodes[i].id);
        expect(streamResult.nodes[i].selfSize).toBe(
          batchResult.nodes[i].selfSize,
        );
        expect(streamResult.nodes[i].edgeCount).toBe(
          batchResult.nodes[i].edgeCount,
        );
      }

      // Edge-level comparison.
      expect(streamResult.edges.length).toBe(batchResult.edges.length);
      for (let i = 0; i < streamResult.edges.length; i++) {
        expect(streamResult.edges[i].type).toBe(batchResult.edges[i].type);
        expect(streamResult.edges[i].nameOrIndex).toBe(
          batchResult.edges[i].nameOrIndex,
        );
        expect(streamResult.edges[i].toNodeIndex).toBe(
          batchResult.edges[i].toNodeIndex,
        );
        expect(streamResult.edges[i].fromNodeIndex).toBe(
          batchResult.edges[i].fromNodeIndex,
        );
      }

      // String table comparison.
      expect(streamResult.strings).toEqual(batchResult.strings);

      // Metadata comparison.
      expect(streamResult.meta).toEqual(batchResult.meta);

      // Reverse graph comparison.
      expect(streamResult.reverseGraph.size).toBe(
        batchResult.reverseGraph.size,
      );

      // Summary comparison (excluding timing-dependent fields).
      expect(streamResult.summary.nodeCount).toBe(
        batchResult.summary.nodeCount,
      );
      expect(streamResult.summary.edgeCount).toBe(
        batchResult.summary.edgeCount,
      );
      expect(streamResult.summary.totalSize).toBe(
        batchResult.summary.totalSize,
      );
      expect(streamResult.summary.detachedDomNodes).toBe(
        batchResult.summary.detachedDomNodes,
      );
    });

    it('should correctly extract string table with escape sequences', async () => {
      const filePath = await writeSnapshot(
        'stream-escapes.heapsnapshot',
        buildEscapeSequenceSnapshot(),
      );

      const result = await parseHeapSnapshotStreaming(filePath);

      expect(result.strings[0]).toBe('normal');
      expect(result.strings[1]).toBe('with\ttab');
      expect(result.strings[2]).toBe('with\nnewline');
      expect(result.strings[3]).toBe('with"quote');
      expect(result.strings[4]).toBe('with\\backslash');
    });

    it('should handle unicode escapes in string values', async () => {
      const filePath = await writeSnapshot(
        'stream-unicode.heapsnapshot',
        buildUnicodeSnapshot(),
      );

      const result = await parseHeapSnapshotStreaming(filePath);

      expect(result.strings[0]).toBe('caf\u00e9');
      expect(result.strings[1]).toBe('ABC');
    });

    it('should handle empty nodes/edges/strings arrays', async () => {
      const filePath = await writeSnapshot(
        'stream-empty.heapsnapshot',
        buildEmptyArraysSnapshot(),
      );

      const result = await parseHeapSnapshotStreaming(filePath);

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(result.strings).toHaveLength(0);
      expect(result.summary.totalSize).toBe(0);
    });

    it('should respect topN option', async () => {
      const filePath = await writeSnapshot(
        'stream-topn.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const result = await parseHeapSnapshotStreaming(filePath, { topN: 1 });

      expect(result.summary.topConstructors.length).toBe(1);
    });
  });

  // ─── Robustness Tests ───────────────────────────────────────────────

  describe('robustness', () => {
    it('should handle chunk boundaries splitting tokens (tiny chunks)', async () => {
      const filePath = await writeSnapshot(
        'stream-tiny-chunks.heapsnapshot',
        buildMinimalSnapshot(),
      );

      // 16-byte chunks force token splitting across boundaries.
      const result = await parseHeapSnapshotStreaming(filePath, {
        chunkSize: 16,
      });

      expect(result.summary.nodeCount).toBe(3);
      expect(result.summary.edgeCount).toBe(1);
      expect(result.strings).toEqual([
        'LeakyCache',
        'EventEmitter',
        '(GC roots)',
        'listener',
      ]);
    });

    it('should handle single-byte chunks', async () => {
      const filePath = await writeSnapshot(
        'stream-byte-chunks.heapsnapshot',
        buildMinimalSnapshot(),
      );

      // 1-byte chunks: maximum chunk boundary stress test.
      const result = await parseHeapSnapshotStreaming(filePath, {
        chunkSize: 1,
      });

      expect(result.summary.nodeCount).toBe(3);
      expect(result.nodes[0].name).toBe('LeakyCache');
      expect(result.nodes[0].selfSize).toBe(1024);
    });

    it('should handle pretty-printed snapshots', async () => {
      const filePath = await writePrettySnapshot(
        'stream-pretty.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const result = await parseHeapSnapshotStreaming(filePath);

      expect(result.summary.nodeCount).toBe(3);
      expect(result.summary.edgeCount).toBe(1);
      expect(result.summary.totalSize).toBe(1536);
    });

    it('should skip unrecognized top-level sections', async () => {
      const filePath = await writeSnapshot(
        'stream-extra-sections.heapsnapshot',
        buildSnapshotWithExtraSections(),
      );

      const result = await parseHeapSnapshotStreaming(filePath);

      expect(result.summary.nodeCount).toBe(3);
      expect(result.summary.edgeCount).toBe(1);
    });

    it('should handle escape sequences split across tiny chunks', async () => {
      const filePath = await writeSnapshot(
        'stream-escape-split.heapsnapshot',
        buildEscapeSequenceSnapshot(),
      );

      // Tiny chunks to split escape sequences like \" across boundaries.
      const result = await parseHeapSnapshotStreaming(filePath, {
        chunkSize: 3,
      });

      expect(result.strings[1]).toBe('with\ttab');
      expect(result.strings[3]).toBe('with"quote');
    });
  });

  // ─── Error Handling Tests ─────────────────────────────────────────

  describe('error handling', () => {
    it('should throw FILE_NOT_FOUND for missing files', async () => {
      const promise = parseHeapSnapshotStreaming(
        join(testDir, 'nonexistent.heapsnapshot'),
      );

      await expect(promise).rejects.toThrow(PerfCompanionError);

      try {
        await parseHeapSnapshotStreaming(
          join(testDir, 'nonexistent.heapsnapshot'),
        );
      } catch (err) {
        expect((err as PerfCompanionError).code).toBe(
          PerfErrorCode.FILE_NOT_FOUND,
        );
      }
    });

    it('should throw SNAPSHOT_TOO_LARGE when file exceeds limit', async () => {
      const filePath = await writeSnapshot(
        'stream-large.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const promise = parseHeapSnapshotStreaming(filePath, {
        maxFileSizeBytes: 1,
      });

      await expect(promise).rejects.toThrow(PerfCompanionError);

      try {
        await parseHeapSnapshotStreaming(filePath, { maxFileSizeBytes: 1 });
      } catch (err) {
        expect((err as PerfCompanionError).code).toBe(
          PerfErrorCode.SNAPSHOT_TOO_LARGE,
        );
      }
    });

    it('should throw INVALID_SNAPSHOT_FORMAT for missing snapshot object', async () => {
      const filePath = await writeSnapshot('stream-no-snapshot.heapsnapshot', {
        nodes: [],
        strings: [],
      });

      await expect(
        parseHeapSnapshotStreaming(filePath),
      ).rejects.toThrow(/metadata/i);
    });

    it('should throw for corrupt JSON in snapshot metadata', async () => {
      const filePath = join(testDir, 'stream-corrupt.heapsnapshot');
      await writeFile(filePath, '{"snapshot": INVALID}', 'utf-8');

      await expect(
        parseHeapSnapshotStreaming(filePath),
      ).rejects.toThrow(PerfCompanionError);
    });

    it('should throw for empty file', async () => {
      const filePath = join(testDir, 'stream-empty-file.heapsnapshot');
      await writeFile(filePath, '', 'utf-8');

      await expect(
        parseHeapSnapshotStreaming(filePath),
      ).rejects.toThrow(PerfCompanionError);
    });
  });

  // ─── Feature Tests ────────────────────────────────────────────────

  describe('features', () => {
    it('should support AbortSignal cancellation', async () => {
      const filePath = await writeSnapshot(
        'stream-abort.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const controller = new AbortController();
      controller.abort('test cancellation');

      await expect(
        parseHeapSnapshotStreaming(filePath, { signal: controller.signal }),
      ).rejects.toThrow(/abort/i);
    });

    it('should invoke progress callback', async () => {
      const filePath = await writeSnapshot(
        'stream-progress.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const progressCalls: Array<{ bytes: number; total: number }> = [];

      await parseHeapSnapshotStreaming(filePath, {
        onProgress: (bytes, total) => {
          progressCalls.push({ bytes, total });
        },
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      // Final progress call should have bytes === total.
      const lastCall = progressCalls[progressCalls.length - 1];
      expect(lastCall.bytes).toBe(lastCall.total);
    });

    it('should record positive parse time', async () => {
      const filePath = await writeSnapshot(
        'stream-timing.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const result = await parseHeapSnapshotStreaming(filePath);

      expect(result.summary.parseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should build correct reverse graph', async () => {
      const filePath = await writeSnapshot(
        'stream-reverse.heapsnapshot',
        buildMinimalSnapshot(),
      );

      const result = await parseHeapSnapshotStreaming(filePath);

      // Edge: Node 0 → Node 1 (property "listener").
      // Reverse: Node 1 is retained by Node 0.
      const retainers = result.reverseGraph.get(1);
      expect(retainers).toBeDefined();
      expect(retainers!.length).toBe(1);
      expect(retainers![0].fromNodeIndex).toBe(0);
      expect(retainers![0].edgeName).toBe('listener');
    });
  });
});
