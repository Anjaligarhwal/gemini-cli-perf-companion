---
name: cpu-profiler
description: CPU profiling with flame graph output in Perfetto trace format
---

# CPU Profiler

Profile CPU usage and identify hot functions using the Node.js Inspector Profiler API. Results are output in Perfetto-compatible trace format for visualization.

## Workflow

1. **Identify Target**
   - Determine if profiling the current process or a remote target
   - For remote: verify CDP connection at specified host:port

2. **Configure Profiling**
   - Set sampling interval (default: 1ms)
   - Set profiling duration (user-specified, max 60 seconds)

3. **Start Profiling**
   - Use `cpu_profile_capture` tool with configured options
   - Wait for specified duration

4. **Stop and Collect**
   - Stop the profiler and collect the profile data
   - Parse into structured CPU profile format

5. **Analysis**
   - Use `cpu_profile_analyze` tool on the captured profile
   - Identify top-N hot functions by self time
   - Generate flame graph data in Perfetto format
   - If baseline provided, compute statistical regression

6. **Reporting**
   - Present hot functions with file:line references
   - Cross-reference with source code
   - Suggest optimization targets
   - Provide Perfetto trace file for ui.perfetto.dev
