---
name: memory-leak-detector
description: Automated 3-snapshot technique for detecting memory leaks in Node.js applications
---

# Memory Leak Detector

Detect memory leaks using the automated 3-snapshot technique. This skill captures heap snapshots at defined intervals, diffs them, and identifies leaked objects with their retainer chains.

## Workflow

1. **Identify Target Process**
   - If the user provides a PID, connect via CDP to `localhost:9229` (or user-specified port)
   - If no PID, ask whether to profile an in-process module or launch a new process with `--inspect`
   - Verify the target is reachable

2. **Warm-Up Phase**
   - Instruct the user to perform the operation once to warm caches
   - Force GC via inspector: `HeapProfiler.collectGarbage`
   - Wait 2 seconds for stabilization

3. **Capture Baseline (Snapshot A)**
   - Use the `heap_snapshot_capture` tool with `{ label: "baseline" }`
   - Record file path and metadata

4. **Action Phase**
   - Ask the user to perform the suspected leaking operation
   - Wait for user confirmation that the action is complete

5. **Capture Post-Action (Snapshot B)**
   - Force GC, capture snapshot with `{ label: "post-action-1" }`

6. **Repeat Action**
   - Ask user to repeat the same operation
   - Force GC, capture **Snapshot C** with `{ label: "post-action-2" }`

7. **Analysis**
   - Use the `heap_snapshot_analyze` tool with all three snapshot paths
   - Review the diff output: growing objects, retainer chains, suspicious patterns
   - Present findings in a structured format with Perfetto trace link

8. **Root-Cause Investigation**
   - Examine the top retainer chains
   - Cross-reference with source code using `grep_search` and `read_file`
   - Provide specific code-level recommendations

## Principles
- **NEVER** modify the user's running process without confirmation
- Always force GC before captures to reduce false positives
- If a snapshot exceeds 100MB, warn the user and suggest filtering
- Present results with confidence levels (high/medium/low)
- Output Perfetto trace for visual exploration at ui.perfetto.dev
