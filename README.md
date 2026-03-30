# Gemini CLI Performance & Memory Investigation Companion

**GSoC 2026 Prototype** for [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) — Issue [#23365](https://github.com/google-gemini/gemini-cli/issues/23365)

A production-grade analysis engine for terminal-integrated performance and memory investigation. Captures V8 heap snapshots and CPU profiles, runs the 3-snapshot leak detection algorithm, extracts retainer chains, and formats results for both LLM reasoning and Perfetto visualization.

**301 tests** across 15 test suites — all passing.

## Architecture

```
src/
├── types.ts                           # 30+ interfaces (HeapNode, RetainerChain, PerfettoTraceEvent, etc.)
├── errors.ts                          # PerfCompanionError with 9 error codes + recoverable flag
├── validation.ts                      # Input validation utilities
│
├── parse/                             # V8 format decoders
│   ├── heap-snapshot-parser.ts        # Two-phase batch parser (512MB guard, RSS monitoring)
│   ├── streaming-snapshot-parser.ts   # Streaming parser: ~1.3x memory vs ~3x for batch
│   │                                  #   Direct digit accumulation, chunk-boundary safe
│   ├── node-parser.ts                 # Flat integer array → HeapNode[] via snapshot.meta
│   └── edge-parser.ts                 # Flat integer array → HeapEdge[] with fromNode resolution
│
├── analyze/                           # Analysis engines
│   ├── three-snapshot-diff.ts         # A→B→C leak detection with constructor-level diffing
│   ├── noise-filter.ts                # 5-layer filter: monotonic growth, min-count, constructor
│   │                                  #   exclusion, growth-rate threshold, size floor
│   ├── retainer-chain-extractor.ts    # BFS through reverse heap graph → GC root paths
│   ├── root-cause-classifier.ts       # Automatic leak classification into 5 categories:
│   │                                  #   event listener, unbounded cache, closure capture,
│   │                                  #   global reference, timer/interval
│   └── cpu-profile-analyzer.ts        # Hot function ranking, GC pressure, category breakdowns
│
├── security/                          # Security boundary
│   └── connection-validator.ts        # Loopback-only host enforcement, privileged port
│                                      #   rejection, CDP method allowlist, output path
│                                      #   traversal prevention, sensitive data scanner
│
├── capture/                           # Data collection
│   ├── heap-snapshot-capture.ts       # Self (node:inspector) + remote (CDP) heap capture
│   ├── cpu-profile-capture.ts         # V8 Profiler.start/stop with duration control
│   └── cdp-client.ts                  # Zero-dependency CDP WebSocket client (RFC 6455)
│                                      #   Uses only node:http + node:crypto
│                                      #   Node.js 18-22+ inspector discovery
│
├── format/                            # Output formatters
│   └── perfetto-formatter.ts          # Chrome Trace Event JSON for ui.perfetto.dev
│
├── bridge/                            # gemini-cli integration layer
│   └── llm-analysis-bridge.ts         # ToolResult output contract:
│                                      #   llmContent (dense, for Gemini reasoning)
│                                      #   returnDisplay (markdown, for terminal)
│
├── integration/                       # BaseDeclarativeTool implementations
│   ├── tool-definitions.ts            # JSON schemas matching gemini-cli's coreTools.ts pattern
│   ├── heap-snapshot-capture-tool.ts  # Kind.Execute — captures write files
│   ├── heap-snapshot-analyze-tool.ts  # Kind.Read — analysis is read-only
│   ├── cpu-profile-capture-tool.ts    # Kind.Execute
│   └── cpu-profile-analyze-tool.ts    # Kind.Read
│
├── demo.ts                            # End-to-end demo with synthetic leak (self-capture)
├── demo-external.ts                   # External process profiling demo via CDP
│                                      #   Spawns leaky server with --inspect, captures
│                                      #   remotely, runs full pipeline
├── dogfood-gemini-cli.ts              # Profiles real gemini-cli startup heap via CDP
│                                      #   89MB snapshot, streaming parse, security scan
│
└── __tests__/                         # 301 tests across 15 suites
    ├── three-snapshot-diff.test.ts    # Diff algorithm + LLM formatting
    ├── perfetto-formatter.test.ts     # Trace generation + retainer chain events
    ├── noise-filter.test.ts           # All 5 filter layers
    ├── retainer-chain-extractor.test.ts  # BFS, cycles, partial chains, formatting
    ├── cpu-profile-analyzer.test.ts   # Hot functions, GC pressure, categories
    ├── heap-snapshot-parser.test.ts   # Full + summary parse, error handling
    ├── streaming-snapshot-parser.test.ts # Batch/stream parity, chunk boundaries, escapes
    ├── node-parser.test.ts            # Flat array decoding, edge cases
    ├── edge-parser.test.ts            # Edge resolution, type mapping
    ├── cdp-client.test.ts             # Mock WebSocket server, CDP protocol
    ├── llm-analysis-bridge.test.ts    # All 3 analysis modes + merge
    ├── connection-validator.test.ts   # Loopback, ports, CDP allowlist, path traversal
    ├── root-cause-classifier.test.ts  # 5 categories, confidence, LLM formatting
    ├── integration-pipeline.test.ts   # 21 end-to-end: parse → diff → chains → format
    └── tool-definitions.test.ts       # Schema validation, cross-tool consistency
```

## Key Technical Decisions

### Zero-Dependency CDP Client (`src/capture/cdp-client.ts`)

Profiles **external** `node --inspect` processes over WebSocket without adding dependencies to gemini-cli. Implements RFC 6455 framing (masking, ping/pong, close handshake) using only `node:http` and `node:crypto`. This is the critical differentiator: most profiling tools only support in-process capture.

### 5-Layer Noise Filter (`src/analyze/noise-filter.ts`)

Raw heap diffs produce hundreds of false positives. The filter chain eliminates noise:

1. **Monotonic growth** — Only objects with A < B < C (strict increase across all 3 snapshots)
2. **Minimum count** — Filters objects with fewer than N new instances
3. **Constructor exclusion** — Removes V8 internals (`(system)`, `(sliced string)`, etc.)
4. **Growth rate threshold** — Requires >10% growth relative to baseline
5. **Size floor** — Ignores constructors below a minimum byte threshold

### Retainer Chain Extraction (`src/analyze/retainer-chain-extractor.ts`)

BFS from leaked objects through the reverse heap graph to find the retention path to GC roots. Answers the question: "**why** can't this object be garbage collected?" — not just "what leaked."

### Streaming Heap Snapshot Parser (`src/parse/streaming-snapshot-parser.ts`)

Processes `.heapsnapshot` files incrementally via `AsyncIterable<Buffer>`, reducing peak memory from ~3× file size (batch) to ~1.3× (streaming). Uses direct digit accumulation (`value = value * 10 + (ch - 0x30)`) for the flat integer arrays instead of string intermediaries — ~10× faster than `parseFloat` for the 35M+ integers in large snapshots. Full JSON escape handling for the string table, cooperative cancellation via `AbortSignal`, and progress callbacks.

### Root Cause Classification Engine (`src/analyze/root-cause-classifier.ts`)

Classifies each leak into one of 5 categories based on retainer chain pattern matching:
- **Event Listener** — `_events` / `EventEmitter` in the chain → fix: `removeListener()`
- **Unbounded Cache** — `Map` / `Set` with no eviction → fix: TTL/LRU policy
- **Closure Capture** — V8 closure type with context edges → fix: null captured refs
- **Global Reference** — reachable from `global` / module scope → fix: instance lifecycle
- **Timer/Interval** — `Timeout` / `Timer` never cleared → fix: `clearInterval()`

Each classification includes a confidence score, explanation, and suggested fix pattern for the LLM agent.

### Security Model (`src/security/connection-validator.ts`)

Defense-in-depth boundary for CDP remote profiling:
- **Loopback enforcement** — Only `127.0.0.1`, `::1`, `localhost` (raw string check, no DNS)
- **Port range** — Rejects privileged ports 1–1023
- **CDP method allowlist** — Only HeapProfiler, Profiler, NodeTracing; blocks `Runtime.evaluate`
- **Output path validation** — Prevents `../` traversal
- **Sensitive data scanner** — Detects API keys, JWTs, AWS keys, connection strings in snapshot string tables

### BaseDeclarativeTool Integration (`src/integration/`)

4 tools following the exact pattern from `gemini-cli`'s `ReadFileTool` and `WebFetchTool`:

| Tool | Kind | Purpose |
|------|------|---------|
| `heap_snapshot_capture` | Execute | Capture via node:inspector or CDP WebSocket |
| `heap_snapshot_analyze` | Read | Parse, diff, leak-detect with retainer chains |
| `cpu_profile_capture` | Execute | Record V8 CPU profiles (self/remote) |
| `cpu_profile_analyze` | Read | Hot functions, GC pressure, Perfetto export |

Registration in `config.ts`:
```typescript
maybeRegister(HeapSnapshotCaptureTool, () =>
  registry.registerTool(new HeapSnapshotCaptureTool(this, this.messageBus)),
);
```

## Quick Start

```bash
npm install
npx vitest run                # Run all 301 tests
npm run build                 # TypeScript compilation
npx tsx src/demo.ts           # Self-capture leak detection demo
npx tsx src/demo-external.ts  # External process profiling demo (CDP)
npx tsx src/dogfood-gemini-cli.ts  # Profile real gemini-cli (dogfood)
```

### Self-Capture Demo (`demo.ts`)
Simulates a server-side memory leak (unbounded `SessionStore`), captures 3 heap snapshots from the current process, runs the diff + retainer chain pipeline, and generates a Perfetto trace.

### External Process Demo (`demo-external.ts`)
Spawns a leaky HTTP server as a child process with `--inspect=9230`, connects via CDP WebSocket, captures 3 snapshots remotely, parses via the streaming parser, runs leak detection with root cause classification, and generates a Perfetto trace. Demonstrates the core workflow: profiling a process the user is not running inside of.

### Dogfood Demo (`dogfood-gemini-cli.ts`)
Profiles the actual gemini-cli process — the tool's intended target. Launches `gemini-cli --version` with `--inspect=9230`, captures a heap snapshot during module initialization, runs streaming parse + heap summary analysis + security scan, and generates a Perfetto trace. Proves the tool handles real 89MB production snapshots.

## Dogfood: Profiling Real Gemini CLI

The tool profiles **its own intended target** — the actual gemini-cli process, not a toy leak.

```bash
npx tsx src/dogfood-gemini-cli.ts    # Requires gemini-cli built at ../gemini-cli/
```

Launches `gemini-cli --version` with `--inspect=9230`, connects via CDP WebSocket, captures a heap snapshot during startup, and runs the full analysis pipeline.

**Results from gemini-cli v0.36.0-nightly:**

| Metric | Value |
|--------|-------|
| Snapshot size | 89.1 MB |
| Capture time | 2.9s |
| Parse time (streaming) | 1.7s |
| Heap nodes | 885,800 |
| Heap edges | 4,111,751 |
| String table entries | 156,964 |
| Total heap size | 109.4 MB |
| Detached DOM nodes | 1,894 (from Ink/React terminal UI) |
| Sensitive strings detected | 9 (API key patterns, passwords) |

**Top constructors by retained size:**

| Constructor | % of heap |
|-------------|-----------|
| `(string)` | 30.4% |
| `(code)` | 16.4% |
| `(native)` | 16.0% |
| `(array)` | 14.6% |

The streaming parser handled an 89 MB production heap snapshot in 1.7 seconds — validating that the architecture scales beyond synthetic test cases. The 1,894 detached DOM nodes are real findings from gemini-cli's Ink/React terminal rendering layer.

## Test Coverage

```
 Test Files  15 passed (15)
      Tests  301 passed (301)
   Duration  ~1.1s

 cdp-client.test.ts                 11 tests — WebSocket connect, CDP send/receive, events
 connection-validator.test.ts       57 tests — Loopback, ports, CDP allowlist, path traversal, PII scan
 cpu-profile-analyzer.test.ts       20 tests — Hot functions, GC pressure, categories
 edge-parser.test.ts                11 tests — Edge resolution, type mapping, boundary conditions
 heap-snapshot-parser.test.ts       13 tests — Full/summary parse, file guards, error handling
 streaming-snapshot-parser.test.ts  20 tests — Batch/stream parity, chunk boundaries, escapes, abort
 integration-pipeline.test.ts       21 tests — End-to-end: multi-constructor, closure, detached DOM,
                                               streaming, security, Perfetto, LLM output constraints
 llm-analysis-bridge.test.ts        22 tests — Heap/leak/CPU analysis + merge results
 node-parser.test.ts                16 tests — Flat array decoding, type resolution, detachedness
 noise-filter.test.ts               13 tests — All 5 filter layers, combinations, edge cases
 perfetto-formatter.test.ts         20 tests — Trace events, retainer chains, leak markers
 retainer-chain-extractor.test.ts   19 tests — BFS, cycles, partial chains, multi-constructor
 root-cause-classifier.test.ts      21 tests — 5 categories, confidence scoring, LLM formatting
 three-snapshot-diff.test.ts        16 tests — Diff algorithm, sorting, LLM output
 tool-definitions.test.ts           21 tests — Schema validation, cross-tool consistency
```

## Integration Path into gemini-cli

This prototype is standalone by design — all analysis engines, parsers, and formatters work independently. During GSoC, these modules integrate into `gemini-cli`'s monorepo at exact locations:

### File Placement Map

```
gemini-cli/packages/core/src/
├── tools/
│   ├── heap-snapshot-capture.ts    ← src/integration/heap-snapshot-capture-tool.ts
│   ├── heap-snapshot-analyze.ts    ← src/integration/heap-snapshot-analyze-tool.ts
│   ├── cpu-profile-capture.ts      ← src/integration/cpu-profile-capture-tool.ts
│   ├── cpu-profile-analyze.ts      ← src/integration/cpu-profile-analyze-tool.ts
│   └── definitions/
│       └── coreTools.ts            ← add 4 tool definitions from tool-definitions.ts
│
├── perf-companion/                 ← NEW directory (analysis engine)
│   ├── parse/
│   │   ├── streaming-snapshot-parser.ts
│   │   ├── node-parser.ts
│   │   └── edge-parser.ts
│   ├── analyze/
│   │   ├── three-snapshot-diff.ts
│   │   ├── noise-filter.ts
│   │   ├── retainer-chain-extractor.ts
│   │   └── root-cause-classifier.ts
│   ├── capture/
│   │   ├── cdp-client.ts
│   │   └── heap-snapshot-capture.ts
│   ├── format/
│   │   └── perfetto-formatter.ts
│   ├── bridge/
│   │   └── llm-analysis-bridge.ts
│   ├── security/
│   │   └── connection-validator.ts
│   ├── types.ts
│   └── errors.ts
│
└── config/
    └── config.ts                   ← add maybeRegister() calls (4 lines)
```

### Registration (4 lines in `config.ts`)

```typescript
// In packages/core/src/config/config.ts, alongside existing tool registrations:
maybeRegister(HeapSnapshotCaptureTool, () =>
  registry.registerTool(new HeapSnapshotCaptureTool(this, this.messageBus)),
);
maybeRegister(HeapSnapshotAnalyzeTool, () =>
  registry.registerTool(new HeapSnapshotAnalyzeTool(this, this.messageBus)),
);
maybeRegister(CpuProfileCaptureTool, () =>
  registry.registerTool(new CpuProfileCaptureTool(this, this.messageBus)),
);
maybeRegister(CpuProfileAnalyzeTool, () =>
  registry.registerTool(new CpuProfileAnalyzeTool(this, this.messageBus)),
);
```

### Tool Definition Registration (in `coreTools.ts`)

```typescript
// In packages/core/src/tools/definitions/coreTools.ts:
export { HEAP_SNAPSHOT_CAPTURE_DEFINITION } from '../heap-snapshot-capture.js';
export { HEAP_SNAPSHOT_ANALYZE_DEFINITION } from '../heap-snapshot-analyze.js';
export { CPU_PROFILE_CAPTURE_DEFINITION } from '../cpu-profile-capture.js';
export { CPU_PROFILE_ANALYZE_DEFINITION } from '../cpu-profile-analyze.js';
```

### Why Standalone First

- **Zero runtime dependencies** — nothing to add to gemini-cli's `package.json`
- **No import conflicts** — the `perf-companion/` directory is self-contained
- **Testable independently** — 301 tests run without gemini-cli checkout
- **Integration is mechanical** — copy files, add 4 `maybeRegister()` calls, update imports

The integration tools (`src/integration/`) already extend `BaseDeclarativeTool` and follow the exact pattern of `ReadFileTool` and `WebFetchTool`. The `@ts-nocheck` annotations exist because those imports (`../config/config.js`, `../confirmation-bus/message-bus.js`) resolve only when placed inside the gemini-cli monorepo.

## Upstream Contributions

- **PR [#23587](https://github.com/google-gemini/gemini-cli/pull/23587)** — Bug fix: `ProceedAlwaysAndSave` incorrectly mapped to `REJECT` instead of `AUTO_ACCEPT` in telemetry, plus 8 unit tests for `getDecisionFromOutcome` *(status/need-issue)*
- **PR [#23536](https://github.com/google-gemini/gemini-cli/pull/23536)** — 13 edge-case tests for `HighWaterMarkTracker` in gemini-cli's telemetry subsystem
- **Issue [#23365](https://github.com/google-gemini/gemini-cli/issues/23365)** — GSoC project: Terminal-Integrated Performance & Memory Investigation Companion

## Technology

- **TypeScript 5.3** — Strict mode, ES2022 target, NodeNext modules
- **Node.js 20+** — `node:inspector/promises`, `node:http`, `node:crypto`
- **Vitest** — Fast test runner with native ESM support
- **Zero external runtime dependencies** — Only devDependencies (vitest, typescript)

## License

Apache License 2.0

## Author

Anjali Garhwal — GSoC 2026 Applicant
