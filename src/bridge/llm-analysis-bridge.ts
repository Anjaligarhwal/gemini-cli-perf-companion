/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LLM analysis bridge — formats profiling results for Gemini agent consumption.
 *
 * This module does NOT make direct API calls to Gemini.  Instead, it returns
 * structured text that becomes part of `ToolResult.llmContent`, flowing through
 * the existing gemini-cli agent loop.  This design leverages the agent's
 * built-in Gemini context window without requiring separate API credentials.
 *
 * Output contract:
 *   - `summary`: One-sentence overview for quick triage.
 *   - `markdownReport`: Human-readable report with tables and sections.
 *   - `llmContext`: Dense, structured text optimized for LLM reasoning.
 *   - `suggestions`: Actionable next-step recommendations.
 *   - `perfettoTrace`: Optional Perfetto trace for visualization.
 */

import type {
  AnalysisResult,
  CpuProfileData,
  HeapSnapshotSummary,
  PerfettoTrace,
  RetainerChain,
  ThreeSnapshotDiffResult,
} from '../types.js';

import { formatDiffForLLM } from '../analyze/three-snapshot-diff.js';
import { formatRetainerChainsForLLM } from '../analyze/retainer-chain-extractor.js';
import { formatCpuProfileForLLM } from '../analyze/cpu-profile-analyzer.js';

// ─── Heap Summary Analysis ───────────────────────────────────────────

/**
 * Build analysis result for a heap snapshot summary.
 *
 * @param summary       - Parsed heap snapshot summary.
 * @param perfettoTrace - Optional Perfetto trace for visualization.
 * @returns Structured analysis result for the agent.
 */
export function analyzeHeapSummary(
  summary: HeapSnapshotSummary,
  perfettoTrace?: PerfettoTrace,
): AnalysisResult {
  const markdownReport = buildMarkdownSummary(summary);
  const llmContext = buildHeapLLMContext(summary);
  const suggestions = generateHeapSuggestions(summary);

  return {
    summary: `Heap snapshot: ${formatBytes(summary.totalSize)} total, ` +
      `${summary.nodeCount.toLocaleString()} nodes, ` +
      `${summary.detachedDomNodes} detached DOM nodes.`,
    markdownReport,
    llmContext,
    perfettoTrace,
    suggestions,
  };
}

// ─── Leak Detection Analysis ─────────────────────────────────────────

/**
 * Build analysis result for a 3-snapshot diff.
 *
 * Integrates retainer chain data when available, producing a
 * comprehensive leak report for the Gemini agent.
 *
 * @param result         - Three-snapshot diff result.
 * @param retainerChains - Optional retainer chains map keyed by constructor.
 * @param perfettoTrace  - Optional Perfetto trace for visualization.
 * @returns Structured analysis result for the agent.
 */
export function analyzeLeakDetection(
  result: ThreeSnapshotDiffResult,
  retainerChains?: ReadonlyMap<string, readonly RetainerChain[]>,
  perfettoTrace?: PerfettoTrace,
): AnalysisResult {
  const llmContext = buildLeakLLMContext(result, retainerChains);
  const markdownReport = buildLeakMarkdown(result, retainerChains);
  const suggestions = generateLeakSuggestions(result);

  return {
    summary: `Leak detection: ${result.summary.strongCandidateCount} strong candidates, ` +
      `top: ${result.summary.topLeakingConstructor}`,
    markdownReport,
    llmContext,
    perfettoTrace,
    suggestions,
  };
}

// ─── CPU Profile Analysis ────────────────────────────────────────────

/**
 * Build analysis result for a CPU profile.
 *
 * @param profile       - Analyzed CPU profile data.
 * @param perfettoTrace - Optional Perfetto trace for visualization.
 * @returns Structured analysis result for the agent.
 */
export function analyzeCpuProfile(
  profile: CpuProfileData,
  perfettoTrace?: PerfettoTrace,
): AnalysisResult {
  const markdownReport = buildCpuMarkdown(profile);
  const llmContext = formatCpuProfileForLLM(profile);
  const suggestions = generateCpuSuggestions(profile);

  return {
    summary: `CPU profile: ${formatMicroseconds(profile.duration)} duration, ` +
      `${profile.sampleCount} samples, ` +
      `top: ${profile.hotFunctions[0]?.functionName ?? 'none'}`,
    markdownReport,
    llmContext,
    perfettoTrace,
    suggestions,
  };
}

// ─── Combined Analysis ───────────────────────────────────────────────

/**
 * Merge multiple analysis results into a single comprehensive report.
 *
 * @param results - One or more partial analysis results.
 * @returns Combined analysis with merged content.
 */
export function mergeAnalysisResults(
  ...results: readonly AnalysisResult[]
): AnalysisResult {
  const summaries: string[] = [];
  const markdownParts: string[] = [];
  const llmParts: string[] = [];
  const allSuggestions: string[] = [];

  for (let i = 0; i < results.length; i++) {
    summaries.push(results[i].summary);
    markdownParts.push(results[i].markdownReport);
    llmParts.push(results[i].llmContext);
    for (const s of results[i].suggestions) {
      allSuggestions.push(s);
    }
  }

  return {
    summary: summaries.join(' | '),
    markdownReport: markdownParts.join('\n\n---\n\n'),
    llmContext: llmParts.join('\n\n'),
    perfettoTrace: results.find((r) => r.perfettoTrace !== undefined)?.perfettoTrace,
    suggestions: allSuggestions,
  };
}

// ─── Private: Heap Summary Formatting ────────────────────────────────

function buildMarkdownSummary(summary: HeapSnapshotSummary): string {
  const lines = [
    '## Heap Snapshot Summary\n',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Size | ${formatBytes(summary.totalSize)} |`,
    `| Nodes | ${summary.nodeCount.toLocaleString()} |`,
    `| Edges | ${summary.edgeCount.toLocaleString()} |`,
    `| Strings | ${summary.stringCount.toLocaleString()} |`,
    `| Detached DOM | ${summary.detachedDomNodes} |`,
    `| Parse Time | ${summary.parseTimeMs}ms |`,
    '',
    '### Top Constructors by Size\n',
    '| Constructor | Count | Total Size | % of Heap |',
    '|------------|-------|------------|-----------|',
  ];

  const ctorLimit = Math.min(summary.topConstructors.length, 15);
  for (let i = 0; i < ctorLimit; i++) {
    const ctor = summary.topConstructors[i];
    lines.push(
      `| \`${ctor.constructor}\` | ${ctor.count.toLocaleString()} | ` +
        `${formatBytes(ctor.totalSize)} | ${ctor.sizePercentage.toFixed(1)}% |`,
    );
  }

  return lines.join('\n');
}

function buildHeapLLMContext(summary: HeapSnapshotSummary): string {
  const lines = [
    '## Heap Snapshot Analysis\n',
    `Total heap size: ${formatBytes(summary.totalSize)}`,
    `Node count: ${summary.nodeCount}`,
    `Detached DOM nodes: ${summary.detachedDomNodes}`,
    '',
    'Top 10 constructors by retained size:',
  ];

  const limit = Math.min(summary.topConstructors.length, 10);
  for (let i = 0; i < limit; i++) {
    const ctor = summary.topConstructors[i];
    lines.push(
      `  ${ctor.constructor}: ${ctor.count} instances, ` +
        `${formatBytes(ctor.totalSize)} (${ctor.sizePercentage.toFixed(1)}%)`,
    );
  }

  return lines.join('\n');
}

function generateHeapSuggestions(summary: HeapSnapshotSummary): string[] {
  const suggestions: string[] = [];

  if (summary.detachedDomNodes > 0) {
    suggestions.push(
      `Found ${summary.detachedDomNodes} detached DOM nodes — DOM elements removed ` +
        'from the document tree but still referenced by JavaScript. Check for event ' +
        'listeners or closures holding references to removed elements.',
    );
  }

  const topCtor = summary.topConstructors[0];
  if (topCtor !== undefined && topCtor.sizePercentage > 30) {
    suggestions.push(
      `\`${topCtor.constructor}\` accounts for ${topCtor.sizePercentage.toFixed(1)}% of the heap. ` +
        'This unusually high concentration may indicate a leak or inefficient data structure.',
    );
  }

  if (summary.totalSize > 100_000_000) {
    suggestions.push(
      `Heap size is ${formatBytes(summary.totalSize)} — consider running the ` +
        '3-snapshot leak detection to identify objects that grow across operations.',
    );
  }

  return suggestions;
}

// ─── Private: Leak Detection Formatting ──────────────────────────────

function buildLeakLLMContext(
  result: ThreeSnapshotDiffResult,
  retainerChains?: ReadonlyMap<string, readonly RetainerChain[]>,
): string {
  const parts: string[] = [formatDiffForLLM(result)];

  if (retainerChains !== undefined && retainerChains.size > 0) {
    parts.push('');
    parts.push(formatRetainerChainsForLLM(retainerChains));
  }

  return parts.join('\n');
}

function buildLeakMarkdown(
  result: ThreeSnapshotDiffResult,
  retainerChains?: ReadonlyMap<string, readonly RetainerChain[]>,
): string {
  const lines = [
    '## Memory Leak Detection Results\n',
    `**Total new objects:** ${result.summary.totalNewObjects}`,
    `**Total new memory:** ${formatBytes(result.summary.totalNewSize)}`,
    `**Strong leak candidates:** ${result.summary.strongCandidateCount}`,
    `**Top leaking constructor:** \`${result.summary.topLeakingConstructor}\``,
    '',
  ];

  if (result.strongLeakCandidates.length > 0) {
    lines.push('### Strong Leak Candidates\n');
    lines.push('| Constructor | Delta Count | Delta Size | Growth Rate |');
    lines.push('|------------|-------------|------------|-------------|');

    const limit = Math.min(result.strongLeakCandidates.length, 10);
    for (let i = 0; i < limit; i++) {
      const c = result.strongLeakCandidates[i];
      const rate = c.growthRate === Infinity ? '∞' : `${(c.growthRate * 100).toFixed(0)}%`;
      lines.push(
        `| \`${c.constructor}\` | +${c.deltaCount} | +${formatBytes(c.deltaSizeBytes)} | ${rate} |`,
      );
    }
    lines.push('');
  }

  if (retainerChains !== undefined && retainerChains.size > 0) {
    lines.push(formatRetainerChainsForLLM(retainerChains));
  }

  return lines.join('\n');
}

function generateLeakSuggestions(result: ThreeSnapshotDiffResult): string[] {
  const suggestions: string[] = [];

  if (result.strongLeakCandidates.length === 0 && result.leakCandidates.length === 0) {
    suggestions.push('No memory leaks detected. The heap appears stable across all three snapshots.');
    return suggestions;
  }

  const top = result.strongLeakCandidates[0] ?? result.leakCandidates[0];
  if (top !== undefined) {
    suggestions.push(
      `Investigate \`${top.constructor}\`: ${top.deltaCount} new instances ` +
        `(${formatBytes(top.deltaSizeBytes)}) accumulated across the test action. ` +
        'Look for closures, event listeners, or cached data that grows unbounded.',
    );
  }

  if (result.retainerChains.length > 0) {
    suggestions.push(
      'Retainer chains are available — examine the retention path from leaked objects ' +
        'to GC roots. The chain shows exactly which references prevent garbage collection.',
    );
  }

  if (result.strongLeakCandidates.length > 5) {
    suggestions.push(
      'Multiple constructors show monotonic growth. This pattern often indicates ' +
        'a single root cause (e.g., a growing collection) rather than multiple independent leaks.',
    );
  }

  return suggestions;
}

// ─── Private: CPU Profile Formatting ─────────────────────────────────

function buildCpuMarkdown(profile: CpuProfileData): string {
  const lines = [
    '## CPU Profile Results\n',
    '| Metric | Value |',
    '|--------|-------|',
    `| Duration | ${formatMicroseconds(profile.duration)} |`,
    `| Samples | ${profile.sampleCount.toLocaleString()} |`,
    '',
  ];

  if (profile.topLevelCategories.length > 0) {
    lines.push('### Time by Category\n');
    lines.push('| Category | Time | % |');
    lines.push('|----------|------|---|');
    for (const cat of profile.topLevelCategories) {
      lines.push(`| ${cat.category} | ${formatMicroseconds(cat.totalTime)} | ${cat.percentage.toFixed(1)}% |`);
    }
    lines.push('');
  }

  if (profile.hotFunctions.length > 0) {
    lines.push('### Hot Functions\n');
    lines.push('| Function | Script | Self Time | Self % |');
    lines.push('|----------|--------|-----------|--------|');

    const limit = Math.min(profile.hotFunctions.length, 15);
    for (let i = 0; i < limit; i++) {
      const fn = profile.hotFunctions[i];
      const name = fn.functionName || '(anonymous)';
      const script = abbreviateScript(fn.scriptName);
      lines.push(
        `| \`${name}\` | ${script}:${fn.lineNumber} | ` +
          `${formatMicroseconds(fn.selfTime)} | ${fn.selfPercentage.toFixed(1)}% |`,
      );
    }
  }

  return lines.join('\n');
}

function generateCpuSuggestions(profile: CpuProfileData): string[] {
  const suggestions: string[] = [];

  if (profile.hotFunctions.length === 0) {
    suggestions.push('No hot functions detected. The profiling duration may be too short.');
    return suggestions;
  }

  const top = profile.hotFunctions[0];
  if (top.selfPercentage > 20) {
    suggestions.push(
      `\`${top.functionName || '(anonymous)'}\` consumes ${top.selfPercentage.toFixed(1)}% ` +
        `of CPU time at \`${abbreviateScript(top.scriptName)}:${top.lineNumber}\`. ` +
        'Consider optimizing this function or reducing call frequency.',
    );
  }

  // Check for GC pressure.
  const gcCategory = profile.topLevelCategories.find((c) => c.category === 'GC');
  if (gcCategory !== undefined && gcCategory.percentage > 10) {
    suggestions.push(
      `Garbage collection uses ${gcCategory.percentage.toFixed(1)}% of CPU time. ` +
        'This indicates high allocation rate — consider object pooling or reducing allocations in hot paths.',
    );
  }

  // Check for idle time (profiling during inactivity).
  const idleCategory = profile.topLevelCategories.find((c) => c.category === 'Idle');
  if (idleCategory !== undefined && idleCategory.percentage > 50) {
    suggestions.push(
      `${idleCategory.percentage.toFixed(0)}% of profiling time was idle. ` +
        'Ensure the profiled operation is actively running during capture.',
    );
  }

  return suggestions;
}

// ─── Private: Formatting Helpers ─────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatMicroseconds(us: number): string {
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

function abbreviateScript(url: string): string {
  if (!url || url === '(native)') return url;
  const lastSlash = url.lastIndexOf('/');
  return lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
}
