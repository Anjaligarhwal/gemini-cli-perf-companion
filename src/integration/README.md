# gemini-cli Integration Layer

This directory contains production-ready `BaseDeclarativeTool` implementations
that plug the perf-companion engine into gemini-cli's tool system.

## Files

| File | Tool Name | Kind | Description |
|------|-----------|------|-------------|
| `tool-definitions.ts` | — | — | JSON schemas and name constants for all 4 tools |
| `heap-snapshot-capture-tool.ts` | `heap_snapshot_capture` | Execute | Capture V8 heap snapshots (self/remote) |
| `heap-snapshot-analyze-tool.ts` | `heap_snapshot_analyze` | Read | Parse and analyze .heapsnapshot files |
| `cpu-profile-capture-tool.ts` | `cpu_profile_capture` | Execute | Record V8 CPU profiles (self/remote) |
| `cpu-profile-analyze-tool.ts` | `cpu_profile_analyze` | Read | Analyze .cpuprofile for hot functions |

## Registration (config.ts)

During GSoC integration, these tools are registered in
`packages/core/src/config/config.ts` alongside existing tools:

```typescript
// After existing tool registrations...
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

## Architecture

```
Gemini Agent Loop
  │
  ├─ heap_snapshot_capture  ──→  CaptureHeapSnapshot engine
  │                               ├─ self mode: node:inspector/promises
  │                               └─ remote mode: CdpClient (WebSocket)
  │
  ├─ heap_snapshot_analyze  ──→  HeapSnapshotParser + DiffEngine
  │                               ├─ summary: single-snapshot stats
  │                               ├─ diff: two-snapshot comparison
  │                               └─ leak-detect: retainer chains + 3-snapshot
  │
  ├─ cpu_profile_capture    ──→  CpuProfileCapture engine
  │                               ├─ self mode: Profiler.start/stop
  │                               └─ remote mode: CdpClient
  │
  └─ cpu_profile_analyze    ──→  CpuProfileParser + LLM bridge
                                  ├─ hot function ranking
                                  ├─ category breakdown (GC/Idle/User)
                                  └─ Perfetto trace export
```

## Design Decisions

1. **Kind.Execute for captures, Kind.Read for analysis** — captures write files
   (side effects), analysis only reads existing files (safe for auto-approval).

2. **Localhost-only for remote capture** — security constraint: CDP WebSocket
   connections are restricted to `127.0.0.1`, `localhost`, and `::1`.

3. **ToolResult.data for structured metadata** — file paths, sizes, and
   suggestion arrays are passed via `data` so downstream tools can chain
   (e.g., capture → analyze pipeline).

4. **LLM context vs display separation** — `llmContent` is dense text
   optimized for Gemini reasoning; `returnDisplay` is markdown for terminal.
