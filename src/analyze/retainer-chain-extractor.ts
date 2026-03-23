/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retainer chain extractor.
 *
 * Given a leaked object identified by the 3-snapshot diff, walks backwards
 * through the heap graph via BFS to find the shortest retention paths to
 * GC roots.  Answers "WHY is this object alive?" rather than just "WHAT
 * objects are leaking?"
 *
 * Key design decisions:
 *   - BFS (not DFS) guarantees shortest-path chains.
 *   - Weak references are excluded upstream in `buildReverseGraph`.
 *   - A visited set prevents infinite loops on cyclic references.
 *   - Partial chains (truncated at maxDepth) are returned when no
 *     root-terminated chain is found, to aid diagnosis.
 */

import type { HeapNode, RetainerChain, RetainerNode } from '../types.js';
import type { RetainerEdge } from '../parse/edge-parser.js';

// ─── Configuration ───────────────────────────────────────────────────

/** Options controlling chain extraction depth and breadth. */
export interface RetainerChainOptions {
  /**
   * Maximum number of nodes in a chain before truncation.
   * @defaultValue 10
   */
  maxDepth?: number;
  /**
   * Maximum number of distinct chains to return per target.
   * @defaultValue 5
   */
  maxChains?: number;
}

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_CHAINS = 5;

/** Minimum path length required to emit a partial (truncated) chain. */
const MIN_PARTIAL_CHAIN_LENGTH = 3;

// ─── Internal Types ──────────────────────────────────────────────────

/** BFS queue entry carrying the full path from target to current node. */
interface BfsEntry {
  readonly nodeIndex: number;
  readonly path: ReadonlyArray<PathStep>;
}

interface PathStep {
  readonly nodeIndex: number;
  readonly edgeType: string;
  readonly edgeName: string;
}

// ─── Core Algorithm ──────────────────────────────────────────────────

/**
 * Extract retainer chains for a single target node.
 *
 * Performs BFS from `targetNodeIndex` upward through the reverse graph,
 * collecting chains that terminate at GC roots (synthetic nodes).
 *
 * Complexity: O(V + E) worst-case, bounded by `maxDepth × maxChains`.
 *
 * @param targetNodeIndex - Logical index of the leaked node.
 * @param reverseGraph    - Reverse adjacency map from `buildReverseGraph`.
 * @param nodes           - Full node list for metadata resolution.
 * @param options         - Depth and breadth limits.
 * @returns Retention paths from target to GC root, shortest first.
 */
export function extractRetainerChains(
  targetNodeIndex: number,
  reverseGraph: ReadonlyMap<number, readonly RetainerEdge[]>,
  nodes: readonly HeapNode[],
  options?: RetainerChainOptions,
): RetainerChain[] {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxChains = options?.maxChains ?? DEFAULT_MAX_CHAINS;

  const targetNode = nodes[targetNodeIndex];
  if (targetNode === undefined) return [];

  const chains: RetainerChain[] = [];
  const visited = new Set<number>([targetNodeIndex]);

  const initialStep: PathStep = {
    nodeIndex: targetNodeIndex,
    edgeType: '(target)',
    edgeName: targetNode.name,
  };

  const queue: BfsEntry[] = [{
    nodeIndex: targetNodeIndex,
    path: [initialStep],
  }];

  while (queue.length > 0 && chains.length < maxChains) {
    const current = queue.shift()!;

    // Enforce depth limit.
    if (current.path.length > maxDepth) continue;

    const currentNode = nodes[current.nodeIndex];

    // Chain terminates when we reach a GC root (any synthetic node).
    if (current.path.length > 1 && isSyntheticRoot(currentNode)) {
      chains.push(materializeChain(current.path, nodes));
      continue;
    }

    // Expand: enqueue all non-visited retainers.
    const retainers = reverseGraph.get(current.nodeIndex);
    if (retainers === undefined) continue;

    for (let i = 0; i < retainers.length; i++) {
      const retainer = retainers[i];
      if (visited.has(retainer.fromNodeIndex)) continue;
      visited.add(retainer.fromNodeIndex);

      const nextStep: PathStep = {
        nodeIndex: retainer.fromNodeIndex,
        edgeType: retainer.edgeType,
        edgeName: retainer.edgeName,
      };

      queue.push({
        nodeIndex: retainer.fromNodeIndex,
        path: [...current.path, nextStep],
      });
    }
  }

  // Fall back to partial chains if no root was reached.
  if (chains.length === 0) {
    collectPartialChains(queue, nodes, maxChains, chains);
  }

  return chains;
}

// ─── Batch Entry Points ──────────────────────────────────────────────

/**
 * Find heap node indices matching a given constructor name.
 *
 * Returns indices sorted by `selfSize` descending so the largest
 * (most interesting) instances are analyzed first.
 *
 * @param nodes           - Full node list.
 * @param constructorName - Constructor name to search for.
 * @param limit           - Maximum number of indices to return.
 */
export function findNodesByConstructor(
  nodes: readonly HeapNode[],
  constructorName: string,
  limit: number = 3,
): number[] {
  const matches: Array<{ index: number; size: number }> = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.name === constructorName || node.type === constructorName) {
      matches.push({ index: i, size: node.selfSize });
    }
  }

  // Sort by size descending, take top-N.
  matches.sort((a, b) => b.size - a.size);

  const result = new Array<number>(Math.min(matches.length, limit));
  for (let i = 0; i < result.length; i++) {
    result[i] = matches[i].index;
  }
  return result;
}

/**
 * Extract retainer chains for all strong leak candidates at once.
 *
 * For each leaking constructor, selects representative instances and
 * runs the BFS extractor.  Returns a map keyed by constructor name.
 */
export function extractRetainerChainsForLeaks(
  leakingConstructors: readonly string[],
  nodes: readonly HeapNode[],
  reverseGraph: ReadonlyMap<number, readonly RetainerEdge[]>,
  options?: RetainerChainOptions,
): Map<string, RetainerChain[]> {
  const result = new Map<string, RetainerChain[]>();

  for (const ctor of leakingConstructors) {
    const representatives = findNodesByConstructor(nodes, ctor, 2);
    const allChains: RetainerChain[] = [];

    for (const nodeIdx of representatives) {
      const chains = extractRetainerChains(nodeIdx, reverseGraph, nodes, options);
      for (const chain of chains) {
        allChains.push(chain);
      }
    }

    if (allChains.length > 0) {
      result.set(ctor, allChains);
    }
  }

  return result;
}

// ─── LLM Output Formatting ──────────────────────────────────────────

/**
 * Format retainer chains into compact LLM-readable markdown.
 *
 * Output example:
 *   ### LeakyCache (1 chain)
 *   1. **LeakyCache** ←(property: _cache)— EventEmitter ←(property: global)— (GC roots)
 */
export function formatRetainerChainsForLLM(
  chainsMap: ReadonlyMap<string, readonly RetainerChain[]>,
): string {
  if (chainsMap.size === 0) {
    return 'No retainer chains found. Objects may be retained by complex or indirect references.';
  }

  const sections: string[] = ['## Retainer Chain Analysis\n'];

  for (const [ctor, chains] of chainsMap) {
    sections.push(`### ${ctor} (${chains.length} chain${chains.length !== 1 ? 's' : ''})\n`);

    for (let i = 0; i < chains.length; i++) {
      const chain = chains[i];
      const pathStr = chain.nodes
        .map((node, idx) =>
          idx === 0
            ? `**${node.name}**`
            : `←(${node.edgeType}: ${node.edgeName})— ${node.name}`,
        )
        .join(' ');

      sections.push(`${i + 1}. ${pathStr}`);
      sections.push(`   Depth: ${chain.depth}, Retained: ${formatBytes(chain.totalRetainedSize)}\n`);
    }
  }

  sections.push('### Suggested Actions\n');
  for (const [ctor] of chainsMap) {
    sections.push(`- Check **${ctor}** for missing cleanup in dispose/destroy methods`);
    sections.push(`- Verify event listeners referencing ${ctor} are removed on teardown`);
  }

  return sections.join('\n');
}

// ─── Private Helpers ─────────────────────────────────────────────────

/** V8 synthetic nodes are GC roots or root-like containers. */
function isSyntheticRoot(node: HeapNode): boolean {
  return node.type === 'synthetic';
}

/** Convert a BFS path into a materialized `RetainerChain`. */
function materializeChain(
  path: ReadonlyArray<PathStep>,
  nodes: readonly HeapNode[],
): RetainerChain {
  let totalRetainedSize = 0;
  const retainerNodes = new Array<RetainerNode>(path.length);

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const node = nodes[step.nodeIndex];
    const selfSize = node?.selfSize ?? 0;
    totalRetainedSize += selfSize;

    retainerNodes[i] = {
      type: node?.type ?? 'unknown',
      name: node?.name ?? `<node:${step.nodeIndex}>`,
      edgeType: step.edgeType,
      edgeName: step.edgeName,
      selfSize,
    };
  }

  return { depth: path.length, nodes: retainerNodes, totalRetainedSize };
}

/**
 * When BFS cannot reach a root within maxDepth, emit the deepest
 * partial chains as diagnostic output.
 */
function collectPartialChains(
  remainingQueue: readonly BfsEntry[],
  nodes: readonly HeapNode[],
  maxChains: number,
  out: RetainerChain[],
): void {
  // Sort candidates by path length descending, take the deepest.
  const candidates = remainingQueue
    .filter((entry) => entry.path.length >= MIN_PARTIAL_CHAIN_LENGTH)
    .sort((a, b) => b.path.length - a.path.length);

  const limit = Math.min(candidates.length, maxChains);
  for (let i = 0; i < limit; i++) {
    // Mark the last step as truncated before materialization so the
    // resulting chain is immutable from the start.
    const path = candidates[i].path;
    const truncatedPath: PathStep[] = new Array(path.length);
    for (let j = 0; j < path.length - 1; j++) {
      truncatedPath[j] = path[j];
    }
    truncatedPath[path.length - 1] = {
      ...path[path.length - 1],
      edgeType: '(truncated)',
    };
    out.push(materializeChain(truncatedPath, nodes));
  }
}

/** Format a byte count for human/LLM consumption. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
