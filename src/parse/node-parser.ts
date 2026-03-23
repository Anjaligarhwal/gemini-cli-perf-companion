/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * V8 heap snapshot node parser.
 *
 * V8 stores nodes as a flat integer array where each node occupies
 * `nodeFieldCount` consecutive slots.  Default V8 node fields:
 *
 *   [type, name, id, self_size, edge_count, trace_node_id, detachedness]
 *
 * The parser resolves type indices against `meta.nodeTypes[0]` and name
 * indices against the snapshot string table, producing structured
 * `HeapNode` objects suitable for downstream analysis.
 *
 * Key design decisions:
 *   - Pre-allocated output array avoids intermediate GC pressure.
 *   - Field-index resolution is amortized O(1) via a single upfront
 *     `indexOf` pass over `meta.nodeFields`.
 *   - `readonly` parameter types enforce immutability at the call site.
 *   - Missing optional fields (`trace_node_id`, `detachedness`) default
 *     to 0, matching V8's behavior for older snapshot formats.
 *
 * Complexity: O(N) where N = number of nodes.
 * Memory: one `HeapNode` allocation per node (pre-sized array).
 */

import type { HeapNode, HeapSnapshotMeta } from '../types.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';

// ─── Required Field Names ────────────────────────────────────────────

/** Minimum set of node fields that must be present in the metadata. */
const REQUIRED_NODE_FIELDS = ['type', 'name', 'id', 'self_size', 'edge_count'] as const;

// ─── Core Parser ─────────────────────────────────────────────────────

/**
 * Decode the flat V8 node array into structured `HeapNode` objects.
 *
 * @param flatNodes - Raw integer array from the `.heapsnapshot` "nodes" field.
 * @param meta      - Snapshot metadata defining field layout and type enums.
 * @param strings   - String table for resolving name indices.
 * @returns Array of structured `HeapNode` objects, one per logical node.
 * @throws {PerfCompanionError} If metadata is missing required node fields.
 */
export function parseNodes(
  flatNodes: readonly number[],
  meta: HeapSnapshotMeta,
  strings: readonly string[],
): HeapNode[] {
  const nodeFieldCount = meta.nodeFields.length;
  if (nodeFieldCount === 0) {
    throw new PerfCompanionError(
      'nodeFields is empty in snapshot metadata',
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }

  // Resolve required field indices once (amortized O(1) per node).
  const fieldIndices = resolveFieldIndices(meta.nodeFields);

  // Node type enum array lives at meta.nodeTypes[0].
  const nodeTypeNames: readonly string[] = Array.isArray(meta.nodeTypes[0])
    ? (meta.nodeTypes[0] as string[])
    : [];

  const nodeCount = (flatNodes.length / nodeFieldCount) | 0;
  const nodes: HeapNode[] = new Array<HeapNode>(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    const base = i * nodeFieldCount;

    const rawType = flatNodes[base + fieldIndices.type];
    const rawName = flatNodes[base + fieldIndices.name];

    nodes[i] = {
      type: nodeTypeNames[rawType] ?? `unknown(${rawType})`,
      name: strings[rawName] ?? `<unresolved:${rawName}>`,
      id: flatNodes[base + fieldIndices.id],
      selfSize: flatNodes[base + fieldIndices.selfSize],
      edgeCount: flatNodes[base + fieldIndices.edgeCount],
      traceNodeId: fieldIndices.traceNodeId >= 0
        ? flatNodes[base + fieldIndices.traceNodeId]
        : 0,
      detachedness: fieldIndices.detachedness >= 0
        ? flatNodes[base + fieldIndices.detachedness]
        : 0,
      nodeIndex: i,
    };
  }

  return nodes;
}

// ─── Constructor Aggregation ─────────────────────────────────────────

/** Intermediate accumulator for constructor-level statistics. */
interface ConstructorAccumulator {
  count: number;
  totalSize: number;
}

/**
 * Aggregate nodes by constructor name for diff analysis.
 *
 * Objects and closures are grouped by their `name` field (the constructor
 * name).  All other node types are grouped by their `type` field wrapped
 * in parentheses (e.g., `(string)`, `(number)`).
 *
 * Complexity: O(N) time, O(C) space where C = distinct constructor names.
 *
 * @param nodes - Parsed heap nodes.
 * @returns Map from constructor key to count and total size.
 */
export function aggregateByConstructor(
  nodes: readonly HeapNode[],
): Map<string, ConstructorAccumulator> {
  const map = new Map<string, ConstructorAccumulator>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    // Objects and closures use the constructor name; everything else
    // uses the type wrapped in parens to distinguish system allocations.
    const key = node.type === 'object' || node.type === 'closure'
      ? (node.name || '(anonymous)')
      : `(${node.type})`;

    const existing = map.get(key);
    if (existing !== undefined) {
      existing.count++;
      existing.totalSize += node.selfSize;
    } else {
      map.set(key, { count: 1, totalSize: node.selfSize });
    }
  }

  return map;
}

// ─── Private Helpers ─────────────────────────────────────────────────

/** Resolved indices for each node field within the flat array stride. */
interface NodeFieldIndices {
  readonly type: number;
  readonly name: number;
  readonly id: number;
  readonly selfSize: number;
  readonly edgeCount: number;
  readonly traceNodeId: number;
  readonly detachedness: number;
}

/**
 * Resolve field names to their integer indices within the flat array stride.
 *
 * @throws {PerfCompanionError} If any required field is missing.
 */
function resolveFieldIndices(
  nodeFields: readonly string[],
): NodeFieldIndices {
  const typeIdx = nodeFields.indexOf('type');
  const nameIdx = nodeFields.indexOf('name');
  const idIdx = nodeFields.indexOf('id');
  const selfSizeIdx = nodeFields.indexOf('self_size');
  const edgeCountIdx = nodeFields.indexOf('edge_count');

  // Validate all required fields are present.
  if (typeIdx === -1 || nameIdx === -1 || idIdx === -1 ||
      selfSizeIdx === -1 || edgeCountIdx === -1) {
    const missing = REQUIRED_NODE_FIELDS.filter(
      (f) => nodeFields.indexOf(f) === -1,
    );
    throw new PerfCompanionError(
      `Missing required node fields: [${missing.join(', ')}]. ` +
        `Found: [${nodeFields.join(', ')}]`,
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }

  return {
    type: typeIdx,
    name: nameIdx,
    id: idIdx,
    selfSize: selfSizeIdx,
    edgeCount: edgeCountIdx,
    // Optional fields — absent in older V8 formats.
    traceNodeId: nodeFields.indexOf('trace_node_id'),
    detachedness: nodeFields.indexOf('detachedness'),
  };
}
