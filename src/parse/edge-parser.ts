/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * V8 heap snapshot edge parser.
 *
 * V8 stores edges as a flat integer array where each edge occupies
 * `edgeFieldCount` consecutive slots.  Edges are implicitly bound to
 * their source node: the first `node[0].edgeCount` edges belong to
 * node 0, the next `node[1].edgeCount` to node 1, and so on.
 *
 * Default V8 edge fields: [type, name_or_index, to_node].
 */

import type { HeapEdge, HeapNode, HeapSnapshotMeta } from '../types.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';

// ─── Public Types ────────────────────────────────────────────────────

/** A single entry in the reverse adjacency map. */
export interface RetainerEdge {
  /** Logical index of the node that holds the reference. */
  fromNodeIndex: number;
  /** V8 edge type (property, element, context, internal, etc.). */
  edgeType: string;
  /** Human-readable edge label (property name or array index). */
  edgeName: string;
}

// ─── Edge Parsing ────────────────────────────────────────────────────

/**
 * Decode the flat V8 edge array into structured `HeapEdge` objects.
 *
 * Complexity: O(E) where E = number of edges.
 * Memory: allocates one `HeapEdge` per edge (pre-sized array avoids realloc).
 *
 * @param flatEdges - Raw integer array from the `.heapsnapshot` "edges" field.
 * @param nodes     - Parsed nodes (only `edgeCount` is read per node).
 * @param meta      - Snapshot metadata defining field layout and type enums.
 * @param strings   - String table for resolving name indices.
 * @returns Structured edges with computed `fromNodeIndex`.
 * @throws {PerfCompanionError} If metadata is missing required fields.
 */
export function parseEdges(
  flatEdges: readonly number[],
  nodes: readonly HeapNode[],
  meta: HeapSnapshotMeta,
  strings: readonly string[],
): HeapEdge[] {
  const edgeFieldCount = meta.edgeFields.length;
  if (edgeFieldCount === 0) {
    throw new PerfCompanionError(
      'edgeFields is empty in snapshot metadata',
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }

  // Resolve required field indices once (amortized O(1) per edge).
  const typeIdx = meta.edgeFields.indexOf('type');
  const nameIdx = meta.edgeFields.indexOf('name_or_index');
  const toNodeIdx = meta.edgeFields.indexOf('to_node');

  if (typeIdx === -1 || nameIdx === -1 || toNodeIdx === -1) {
    throw new PerfCompanionError(
      `Missing required edge fields (need type, name_or_index, to_node). ` +
        `Found: [${meta.edgeFields.join(', ')}]`,
      PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
      /* recoverable= */ false,
    );
  }

  // Edge type enum array lives at meta.edgeTypes[typeIdx].
  const edgeTypeNames: readonly string[] = Array.isArray(meta.edgeTypes[typeIdx])
    ? (meta.edgeTypes[typeIdx] as string[])
    : [];

  // V8 encodes `to_node` as a flat-array byte offset; dividing by
  // nodeFieldCount yields the logical node index.
  const nodeFieldCount = meta.nodeFields.length;

  const edgeCount = (flatEdges.length / edgeFieldCount) | 0;
  const edges: HeapEdge[] = new Array<HeapEdge>(edgeCount);

  let flatOffset = 0;
  let writeIdx = 0;

  for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
    const ownerEdgeCount = nodes[nodeIdx].edgeCount;

    for (let e = 0; e < ownerEdgeCount; e++) {
      const rawType = flatEdges[flatOffset + typeIdx];
      const rawName = flatEdges[flatOffset + nameIdx];
      const rawToNode = flatEdges[flatOffset + toNodeIdx];

      const typeName = edgeTypeNames[rawType] ?? `unknown(${rawType})`;

      // Element edges carry a numeric array index; all others carry a
      // string-table index that must be resolved.
      const nameOrIndex: string | number =
        typeName === 'element'
          ? rawName
          : (strings[rawName] ?? `<unresolved:${rawName}>`);

      edges[writeIdx] = {
        type: typeName,
        nameOrIndex,
        fromNodeIndex: nodeIdx,
        toNodeIndex: (rawToNode / nodeFieldCount) | 0,
      };

      flatOffset += edgeFieldCount;
      writeIdx++;
    }
  }

  return edges;
}

// ─── Reverse Graph Construction ──────────────────────────────────────

/**
 * Build a reverse adjacency map: for each node, which nodes retain it?
 *
 * Weak references (edge type `"weak"`) are excluded because they do not
 * prevent garbage collection and would produce misleading retainer chains.
 *
 * Complexity: O(E) time, O(E) space.
 *
 * @param edges - Parsed edges from `parseEdges()`.
 * @returns Map from target node index → array of retaining edges.
 */
export function buildReverseGraph(
  edges: readonly HeapEdge[],
): Map<number, RetainerEdge[]> {
  const reverse = new Map<number, RetainerEdge[]>();

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];

    // Weak references don't prevent GC — exclude them.
    if (edge.type === 'weak') continue;

    let retainers = reverse.get(edge.toNodeIndex);
    if (retainers === undefined) {
      retainers = [];
      reverse.set(edge.toNodeIndex, retainers);
    }

    retainers.push({
      fromNodeIndex: edge.fromNodeIndex,
      edgeType: edge.type,
      edgeName:
        typeof edge.nameOrIndex === 'number'
          ? `[${edge.nameOrIndex}]`
          : String(edge.nameOrIndex),
    });
  }

  return reverse;
}
