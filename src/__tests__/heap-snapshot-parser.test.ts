/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHeapSnapshot, parseHeapSnapshotFull } from '../parse/heap-snapshot-parser.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';

// ─── Test Fixture ────────────────────────────────────────────────────

/**
 * Minimal valid V8 heap snapshot JSON.
 *
 * Contains 3 nodes:
 *   Node 0: object "LeakyCache"   (selfSize=1024, 1 edge)
 *   Node 1: object "EventEmitter" (selfSize=512, 0 edges)
 *   Node 2: synthetic "(GC roots)" (selfSize=0, 0 edges)
 *
 * Contains 1 edge:
 *   Node 0 → Node 1, type=property, name="listener"
 *
 * Node field layout: [type, name, id, self_size, edge_count, trace_node_id, detachedness]
 * Edge field layout: [type, name_or_index, to_node]
 */
function buildMinimalSnapshot(): object {
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
        node_types: [
          ['hidden', 'array', 'string', 'object', 'code', 'closure',
           'regexp', 'number', 'native', 'synthetic'],
          'string', 'number', 'number', 'number', 'number', 'number',
        ],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [
          ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'],
          'string_or_number', 'node',
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
      // Node 0: type=3(object), name=0("LeakyCache"), id=1, selfSize=1024, edgeCount=1, traceNodeId=0, detachedness=0
      3, 0, 1, 1024, 1, 0, 0,
      // Node 1: type=3(object), name=1("EventEmitter"), id=3, selfSize=512, edgeCount=0, traceNodeId=0, detachedness=0
      3, 1, 3, 512, 0, 0, 0,
      // Node 2: type=9(synthetic), name=2("(GC roots)"), id=5, selfSize=0, edgeCount=0, traceNodeId=0, detachedness=0
      9, 2, 5, 0, 0, 0, 0,
    ],
    edges: [
      // Edge from Node 0 → Node 1: type=2(property), name_or_index=3("listener"), to_node=7 (node 1 × 7 fields)
      2, 3, 7,
    ],
    trace_function_infos: [],
    trace_tree: [],
    samples: [],
    locations: [],
    strings: ['LeakyCache', 'EventEmitter', '(GC roots)', 'listener'],
  };
}

// ─── Temp Directory Management ───────────────────────────────────────

let testDir: string;

beforeAll(async () => {
  testDir = join(tmpdir(), `perf-companion-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeSnapshot(name: string, data: object): Promise<string> {
  const filePath = join(testDir, name);
  await writeFile(filePath, JSON.stringify(data), 'utf-8');
  return filePath;
}

// ─── parseHeapSnapshot (summary) tests ───────────────────────────────

describe('parseHeapSnapshot', () => {
  it('should parse a minimal snapshot and return correct summary', async () => {
    const filePath = await writeSnapshot('minimal.heapsnapshot', buildMinimalSnapshot());

    const summary = await parseHeapSnapshot(filePath);

    expect(summary.nodeCount).toBe(3);
    expect(summary.edgeCount).toBe(1);
    expect(summary.stringCount).toBe(4);
    expect(summary.totalSize).toBe(1536); // 1024 + 512 + 0
  });

  it('should identify top constructors sorted by size', async () => {
    const filePath = await writeSnapshot('constructors.heapsnapshot', buildMinimalSnapshot());

    const summary = await parseHeapSnapshot(filePath);

    expect(summary.topConstructors.length).toBeGreaterThan(0);
    // LeakyCache (1024B) should be first
    expect(summary.topConstructors[0].constructor).toBe('LeakyCache');
    expect(summary.topConstructors[0].totalSize).toBe(1024);
  });

  it('should compute correct size percentages', async () => {
    const filePath = await writeSnapshot('pct.heapsnapshot', buildMinimalSnapshot());

    const summary = await parseHeapSnapshot(filePath);

    const leaky = summary.topConstructors.find((c) => c.constructor === 'LeakyCache');
    expect(leaky).toBeDefined();
    // 1024 / 1536 ≈ 66.7%
    expect(leaky!.sizePercentage).toBeCloseTo(66.67, 0);
  });

  it('should respect topN option', async () => {
    const filePath = await writeSnapshot('topn.heapsnapshot', buildMinimalSnapshot());

    const summary = await parseHeapSnapshot(filePath, { topN: 1 });

    expect(summary.topConstructors.length).toBe(1);
  });

  it('should record positive parse time', async () => {
    const filePath = await writeSnapshot('timing.heapsnapshot', buildMinimalSnapshot());

    const summary = await parseHeapSnapshot(filePath);

    expect(summary.parseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('should throw FILE_NOT_FOUND for missing files', async () => {
    await expect(
      parseHeapSnapshot(join(testDir, 'nonexistent.heapsnapshot')),
    ).rejects.toThrow(PerfCompanionError);

    try {
      await parseHeapSnapshot(join(testDir, 'nonexistent.heapsnapshot'));
    } catch (err) {
      expect((err as PerfCompanionError).code).toBe(PerfErrorCode.FILE_NOT_FOUND);
    }
  });

  it('should throw SNAPSHOT_TOO_LARGE when file exceeds limit', async () => {
    const filePath = await writeSnapshot('large.heapsnapshot', buildMinimalSnapshot());

    await expect(
      parseHeapSnapshot(filePath, { maxFileSizeBytes: 1 }),
    ).rejects.toThrow(PerfCompanionError);

    try {
      await parseHeapSnapshot(filePath, { maxFileSizeBytes: 1 });
    } catch (err) {
      expect((err as PerfCompanionError).code).toBe(PerfErrorCode.SNAPSHOT_TOO_LARGE);
    }
  });

  it('should throw PARSE_FAILED for invalid JSON', async () => {
    const filePath = join(testDir, 'bad.heapsnapshot');
    await writeFile(filePath, 'not valid json {{{', 'utf-8');

    await expect(parseHeapSnapshot(filePath)).rejects.toThrow(PerfCompanionError);
  });

  it('should throw INVALID_SNAPSHOT_FORMAT for missing snapshot key', async () => {
    const filePath = await writeSnapshot('nosnapshot.heapsnapshot', { nodes: [], strings: [] });

    await expect(parseHeapSnapshot(filePath)).rejects.toThrow(/missing.*snapshot/i);
  });
});

// ─── parseHeapSnapshotFull tests ─────────────────────────────────────

describe('parseHeapSnapshotFull', () => {
  it('should return full parsed structure with nodes, edges, and reverse graph', async () => {
    const filePath = await writeSnapshot('full.heapsnapshot', buildMinimalSnapshot());

    const parsed = await parseHeapSnapshotFull(filePath);

    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.strings).toHaveLength(4);
    expect(parsed.reverseGraph.size).toBeGreaterThan(0);
    expect(parsed.meta.nodeFields).toContain('type');
  });

  it('should build correct reverse graph from edges', async () => {
    const filePath = await writeSnapshot('reverse.heapsnapshot', buildMinimalSnapshot());

    const parsed = await parseHeapSnapshotFull(filePath);

    // Edge: Node 0 → Node 1 (property "listener")
    // Reverse: Node 1 is retained by Node 0
    const retainers = parsed.reverseGraph.get(1);
    expect(retainers).toBeDefined();
    expect(retainers!.length).toBe(1);
    expect(retainers![0].fromNodeIndex).toBe(0);
    expect(retainers![0].edgeName).toBe('listener');
  });

  it('should have consistent node/edge counts between full parse and summary', async () => {
    const filePath = await writeSnapshot('consistency.heapsnapshot', buildMinimalSnapshot());

    const parsed = await parseHeapSnapshotFull(filePath);

    expect(parsed.summary.nodeCount).toBe(parsed.nodes.length);
    expect(parsed.summary.edgeCount).toBe(parsed.edges.length);
  });

  it('should correctly resolve node types from metadata', async () => {
    const filePath = await writeSnapshot('types.heapsnapshot', buildMinimalSnapshot());

    const parsed = await parseHeapSnapshotFull(filePath);

    expect(parsed.nodes[0].type).toBe('object');
    expect(parsed.nodes[0].name).toBe('LeakyCache');
    expect(parsed.nodes[2].type).toBe('synthetic');
    expect(parsed.nodes[2].name).toBe('(GC roots)');
  });
});
