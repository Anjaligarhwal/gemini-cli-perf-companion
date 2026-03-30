/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { HeapSnapshotMeta } from '../types.js';
import { parseNodes, aggregateByConstructor } from '../parse/node-parser.js';
import { PerfCompanionError } from '../errors.js';

// ─── Fixtures ────────────────────────────────────────────────────────

/**
 * Standard V8 metadata with 7 node fields.
 *
 * nodeTypes[0] maps type indices to human-readable names:
 *   0=hidden, 1=array, 2=string, 3=object, 4=code, 5=closure,
 *   6=regexp, 7=number, 8=native, 9=synthetic
 */
const META: HeapSnapshotMeta = {
  nodeFields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
  nodeTypes: [['hidden', 'array', 'string', 'object', 'code', 'closure',
               'regexp', 'number', 'native', 'synthetic']],
  edgeFields: ['type', 'name_or_index', 'to_node'],
  edgeTypes: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']],
  traceFunctionInfoFields: [],
  traceNodeFields: [],
  sampleFields: [],
  locationFields: [],
};

const NODE_FIELD_COUNT = META.nodeFields.length; // 7

const STRINGS = ['', 'MyObject', 'EventEmitter', 'Timer', '(anonymous)', 'global'];

/**
 * Build a flat-array representation of a single V8 node.
 *
 * @param typeIdx     - Index into nodeTypes enum (3 = object).
 * @param nameIdx     - Index into the string table.
 * @param id          - Unique node ID.
 * @param selfSize    - Self size in bytes.
 * @param edgeCount   - Number of outgoing edges.
 * @param traceNodeId - Trace node ID (default 0).
 * @param detachedness - Detachedness flag (default 0).
 */
function flatNode(
  typeIdx: number,
  nameIdx: number,
  id: number,
  selfSize: number,
  edgeCount: number,
  traceNodeId: number = 0,
  detachedness: number = 0,
): number[] {
  return [typeIdx, nameIdx, id, selfSize, edgeCount, traceNodeId, detachedness];
}

// ─── parseNodes tests ────────────────────────────────────────────────

describe('parseNodes', () => {
  it('should decode a single node from the flat array', () => {
    // type=3 (object), name=1 ("MyObject"), id=101, selfSize=256, edgeCount=2
    const flatNodes = flatNode(3, 1, 101, 256, 2);

    const nodes = parseNodes(flatNodes, META, STRINGS);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('object');
    expect(nodes[0].name).toBe('MyObject');
    expect(nodes[0].id).toBe(101);
    expect(nodes[0].selfSize).toBe(256);
    expect(nodes[0].edgeCount).toBe(2);
    expect(nodes[0].nodeIndex).toBe(0);
  });

  it('should decode multiple nodes sequentially', () => {
    const flatNodes = [
      ...flatNode(3, 1, 101, 256, 2),    // object "MyObject"
      ...flatNode(5, 2, 102, 128, 1),    // closure "EventEmitter"
      ...flatNode(9, 5, 103, 0, 3),      // synthetic "global"
    ];

    const nodes = parseNodes(flatNodes, META, STRINGS);

    expect(nodes).toHaveLength(3);
    expect(nodes[0].type).toBe('object');
    expect(nodes[0].name).toBe('MyObject');
    expect(nodes[1].type).toBe('closure');
    expect(nodes[1].name).toBe('EventEmitter');
    expect(nodes[2].type).toBe('synthetic');
    expect(nodes[2].name).toBe('global');
  });

  it('should assign correct sequential nodeIndex values', () => {
    const flatNodes = [
      ...flatNode(3, 1, 101, 64, 0),
      ...flatNode(3, 2, 102, 64, 0),
      ...flatNode(3, 3, 103, 64, 0),
    ];

    const nodes = parseNodes(flatNodes, META, STRINGS);

    expect(nodes[0].nodeIndex).toBe(0);
    expect(nodes[1].nodeIndex).toBe(1);
    expect(nodes[2].nodeIndex).toBe(2);
  });

  it('should handle unknown type indices gracefully', () => {
    // typeIdx=99 is beyond the nodeTypes enum length
    const flatNodes = flatNode(99, 1, 101, 64, 0);

    const nodes = parseNodes(flatNodes, META, STRINGS);

    expect(nodes[0].type).toBe('unknown(99)');
  });

  it('should handle unresolved string indices gracefully', () => {
    // nameIdx=999 is beyond the string table length
    const flatNodes = flatNode(3, 999, 101, 64, 0);

    const nodes = parseNodes(flatNodes, META, STRINGS);

    expect(nodes[0].name).toBe('<unresolved:999>');
  });

  it('should default optional fields when metadata lacks them', () => {
    // Metadata without trace_node_id and detachedness
    const minimalMeta: HeapSnapshotMeta = {
      ...META,
      nodeFields: ['type', 'name', 'id', 'self_size', 'edge_count'],
      nodeTypes: META.nodeTypes,
    };

    // Only 5 fields per node
    const flatNodes = [3, 1, 101, 256, 2];

    const nodes = parseNodes(flatNodes, minimalMeta, STRINGS);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].traceNodeId).toBe(0);
    expect(nodes[0].detachedness).toBe(0);
  });

  it('should detect detached DOM nodes via detachedness > 0', () => {
    const flatNodes = [
      ...flatNode(3, 1, 101, 64, 0, 0, 0),  // not detached
      ...flatNode(3, 2, 102, 64, 0, 0, 1),  // detached
      ...flatNode(3, 3, 103, 64, 0, 0, 2),  // detached
    ];

    const nodes = parseNodes(flatNodes, META, STRINGS);

    expect(nodes[0].detachedness).toBe(0);
    expect(nodes[1].detachedness).toBe(1);
    expect(nodes[2].detachedness).toBe(2);
  });

  it('should throw on empty nodeFields in metadata', () => {
    const badMeta: HeapSnapshotMeta = { ...META, nodeFields: [] };

    expect(() => parseNodes([], badMeta, [])).toThrow(PerfCompanionError);
  });

  it('should throw when required fields are missing', () => {
    const badMeta: HeapSnapshotMeta = {
      ...META,
      nodeFields: ['type', 'name'],  // missing id, self_size, edge_count
    };

    expect(() => parseNodes([0, 0], badMeta, STRINGS)).toThrow(PerfCompanionError);
    expect(() => parseNodes([0, 0], badMeta, STRINGS)).toThrow(/Missing required node fields/);
  });

  it('should handle empty flat array (zero nodes)', () => {
    const nodes = parseNodes([], META, STRINGS);
    expect(nodes).toHaveLength(0);
  });

  it('should pre-allocate output array to exact size', () => {
    // 3 nodes × 7 fields = 21 integers
    const flatNodes = [
      ...flatNode(3, 1, 101, 64, 0),
      ...flatNode(3, 2, 102, 64, 0),
      ...flatNode(3, 3, 103, 64, 0),
    ];

    const nodes = parseNodes(flatNodes, META, STRINGS);

    // Array.length should be exactly 3 (no empty slots)
    expect(nodes.length).toBe(3);
    expect(nodes.every((n) => n !== undefined)).toBe(true);
  });
});

// ─── aggregateByConstructor tests ────────────────────────────────────

describe('aggregateByConstructor', () => {
  it('should group objects by constructor name', () => {
    const nodes = parseNodes([
      ...flatNode(3, 1, 101, 100, 0),  // object "MyObject" 100B
      ...flatNode(3, 1, 102, 200, 0),  // object "MyObject" 200B
      ...flatNode(3, 2, 103, 50, 0),   // object "EventEmitter" 50B (closure→type=5 would use name too)
    ], META, STRINGS);

    const agg = aggregateByConstructor(nodes);

    const myObj = agg.get('MyObject');
    expect(myObj).toBeDefined();
    expect(myObj!.count).toBe(2);
    expect(myObj!.totalSize).toBe(300);
  });

  it('should group system types by (type) notation', () => {
    const nodes = parseNodes([
      ...flatNode(2, 0, 101, 50, 0),   // string "" → key is "(string)"
      ...flatNode(2, 0, 102, 30, 0),   // string "" → key is "(string)"
      ...flatNode(7, 0, 103, 8, 0),    // number "" → key is "(number)"
    ], META, STRINGS);

    const agg = aggregateByConstructor(nodes);

    expect(agg.get('(string)')?.count).toBe(2);
    expect(agg.get('(string)')?.totalSize).toBe(80);
    expect(agg.get('(number)')?.count).toBe(1);
  });

  it('should use (anonymous) for objects with empty names', () => {
    // name index 0 → empty string ""
    const nodes = parseNodes([
      ...flatNode(3, 0, 101, 64, 0),
    ], META, STRINGS);

    const agg = aggregateByConstructor(nodes);

    // Empty string falsy → falls through to '(anonymous)'
    expect(agg.has('(anonymous)')).toBe(true);
  });

  it('should group closures by their name (not type)', () => {
    const nodes = parseNodes([
      ...flatNode(5, 3, 101, 32, 0),  // closure "Timer"
      ...flatNode(5, 3, 102, 48, 0),  // closure "Timer"
    ], META, STRINGS);

    const agg = aggregateByConstructor(nodes);

    expect(agg.get('Timer')?.count).toBe(2);
    expect(agg.get('Timer')?.totalSize).toBe(80);
  });

  it('should handle empty node list', () => {
    const agg = aggregateByConstructor([]);
    expect(agg.size).toBe(0);
  });
});
