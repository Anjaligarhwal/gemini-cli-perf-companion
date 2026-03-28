# Gemini CLI Performance & Memory Investigation Companion

**GSoC 2026 Prototype** for [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) — Issue [#23365](https://github.com/google-gemini/gemini-cli/issues/23365)

A production-grade analysis engine for terminal-integrated performance and memory investigation. Captures V8 heap snapshots and CPU profiles, runs the 3-snapshot leak detection algorithm, extracts retainer chains, and formats results for both LLM reasoning and Perfetto visualization.

**185 tests** across 12 test files — all passing.

## Architecture

```
src/
├── types.ts                           # 30+ interfaces (HeapNode, RetainerChain, PerfettoTraceEvent, etc.)
├── errors.ts                          # PerfCompanionError with 9 error codes + recoverable flag
├── validation.ts                      # Input validation utilities
│
├── parse/                             # V8 format decoders
│   ├── heap-snapshot-parser.ts        # Two-phase parser: summary + full (512MB guard, RSS monitoring)
│   ├── node-parser.ts                 # Flat integer array → HeapNode[] via snapshot.meta
│   └── edge-parser.ts                 # Flat integer array → HeapEdge[] with fromNode resolution
│
├── analyze/                           # Analysis engines
│   ├── three-snapshot-diff.ts         # A→B→C leak detection with constructor-level diffing
│   ├── noise-filter.ts                # 5-layer filter: monotonic growth, min-count, constructor
│   │                                  #   exclusion, growth-rate threshold, size floor
│   ├── retainer-chain-extractor.ts    # BFS through reverse heap graph → GC root paths
│   └── cpu-profile-analyzer.ts        # Hot function ranking, GC pressure, category breakdowns
│
├── capture/                           # Data collection
│   ├── heap-snapshot-capture.ts       # Self (node:inspector) + remote (CDP) heap capture
│   ├── cpu-profile-capture.ts         # V8 Profiler.start/stop with duration control
│   └── cdp-client.ts                  # Zero-dependency CDP WebSocket client (RFC 6455)
│                                      #   Uses only node:http + node:crypto
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
├── demo.ts                            # End-to-end demo with synthetic leak
│
└── __tests__/                         # 185 tests across 12 files
    ├── three-snapshot-diff.test.ts    # Diff algorithm + LLM formatting
    ├── perfetto-formatter.test.ts     # Trace generation + retainer chain events
    ├── noise-filter.test.ts           # All 5 filter layers
    ├── retainer-chain-extractor.test.ts  # BFS, cycles, partial chains, formatting
    ├── cpu-profile-analyzer.test.ts   # Hot functions, GC pressure, categories
    ├── heap-snapshot-parser.test.ts   # Full + summary parse, error handling
    ├── node-parser.test.ts            # Flat array decoding, edge cases
    ├── edge-parser.test.ts            # Edge resolution, type mapping
    ├── cdp-client.test.ts             # Mock WebSocket server, CDP protocol
    ├── llm-analysis-bridge.test.ts    # All 3 analysis modes + merge
    ├── integration-pipeline.test.ts   # End-to-end: parse → diff → chains → format
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
npm test          # 185 tests
npm run build     # TypeScript compilation
npm run demo      # End-to-end leak detection demo
```

## Test Coverage

```
 Test Files  12 passed (12)
      Tests  185 passed (185)
   Duration  567ms

 cdp-client.test.ts              11 tests  — WebSocket connect, CDP send/receive, events, disconnect
 cpu-profile-analyzer.test.ts    20 tests  — Hot functions, GC pressure, categories, edge cases
 edge-parser.test.ts             11 tests  — Edge resolution, type mapping, boundary conditions
 heap-snapshot-parser.test.ts    13 tests  — Full/summary parse, file guards, error handling
 integration-pipeline.test.ts     3 tests  — End-to-end parse → diff → chains → Perfetto
 llm-analysis-bridge.test.ts     22 tests  — Heap/leak/CPU analysis + merge results
 node-parser.test.ts             16 tests  — Flat array decoding, type resolution, detachedness
 noise-filter.test.ts            13 tests  — All 5 filter layers, combinations, edge cases
 perfetto-formatter.test.ts      20 tests  — Trace events, retainer chains, leak markers
 retainer-chain-extractor.test.ts 19 tests — BFS, cycles, partial chains, multi-constructor
 three-snapshot-diff.test.ts     16 tests  — Diff algorithm, sorting, LLM output
 tool-definitions.test.ts        21 tests  — Schema validation, cross-tool consistency
```

## Related

- **PR [#23536](https://github.com/google-gemini/gemini-cli/pull/23536)** — Test coverage for `HighWaterMarkTracker` in gemini-cli's telemetry subsystem
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
