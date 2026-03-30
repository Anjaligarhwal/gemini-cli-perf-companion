/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming V8 heap snapshot parser.
 *
 * Processes `.heapsnapshot` files incrementally through an
 * `AsyncIterable<Buffer>` interface, compatible with `fs.createReadStream`.
 *
 * Memory model comparison (F = file size):
 *   Batch parser:     ~3F (JSON string + parsed JS object + output arrays)
 *   Streaming parser: ~1.3F (output arrays + string table only)
 *
 * The parser exploits the known structure of V8 heap snapshots:
 *
 *   1. The small `snapshot` metadata object (~2 KB) is buffered and
 *      JSON.parsed conventionally.
 *   2. The `nodes` and `edges` flat integer arrays are extracted via
 *      direct digit accumulation — `value = value * 10 + (ch - 0x30)` —
 *      without intermediate string allocation.  This is ~10× faster than
 *      string-buffer + parseFloat for the 35M+ integers in large snapshots.
 *   3. The `strings` array is decoded with full JSON escape handling
 *      (backslash sequences, `\uXXXX`, surrogate pairs).
 *   4. All other sections (`trace_*`, `samples`, `locations`) are skipped
 *      via depth-tracked fast-forward.
 *
 * Output is identical to {@link parseHeapSnapshotFull} — structured nodes,
 * edges, reverse graph, and summary — enabling drop-in replacement for
 * large snapshot files.
 *
 * @module
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import type {
  ConstructorGroup,
  HeapEdge,
  HeapNode,
  HeapSnapshotMeta,
  HeapSnapshotSummary,
} from '../types.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';
import { formatBytes } from '../utils.js';
import { parseNodes, aggregateByConstructor } from './node-parser.js';
import { parseEdges, buildReverseGraph } from './edge-parser.js';
import type { ParseOptions, ParsedHeapSnapshot } from './heap-snapshot-parser.js';

// ─── Configuration ───────────────────────────────────────────────────

/** Options for the streaming parser, extending the batch parser options. */
export interface StreamingParseOptions extends ParseOptions {
  /** AbortSignal for cooperative cancellation. */
  readonly signal?: AbortSignal;
  /** Callback invoked on each chunk with (bytesProcessed, totalBytes). */
  readonly onProgress?: (bytesProcessed: number, totalBytes: number) => void;
  /**
   * Read stream chunk size in bytes.
   *
   * Larger values reduce syscall overhead; smaller values reduce peak
   * memory spikes and improve cancellation responsiveness.
   * @defaultValue 262_144 (256 KB)
   */
  readonly chunkSize?: number;
}

/** Default maximum file size: 1 GB (higher than batch parser for streaming). */
const DEFAULT_MAX_FILE_SIZE_BYTES = 1_073_741_824;

/** Default RSS warning threshold: 512 MB. */
const DEFAULT_MEMORY_PRESSURE_THRESHOLD = 536_870_912;

/** Default number of top constructors in the summary. */
const DEFAULT_TOP_N = 20;

/** Default read stream high-water mark: 256 KB. */
const DEFAULT_CHUNK_SIZE = 262_144;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Parse a `.heapsnapshot` file using incremental streaming.
 *
 * For files under ~100 MB, the batch parser (`parseHeapSnapshotFull`) is
 * sufficient.  For larger files (100 MB–1 GB), this streaming parser
 * reduces peak memory from ~3× file size to ~1.3× the output size.
 *
 * @param filePath - Absolute path to the `.heapsnapshot` file.
 * @param options  - Parser configuration and resource limits.
 * @returns Full parsed snapshot identical to the batch parser output.
 * @throws {PerfCompanionError} On file-size violation, abort, read error,
 *   or invalid snapshot format.
 */
export async function parseHeapSnapshotStreaming(
  filePath: string,
  options?: StreamingParseOptions,
): Promise<ParsedHeapSnapshot> {
  const maxFileSize = options?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const pressureThreshold =
    options?.memoryPressureThreshold ?? DEFAULT_MEMORY_PRESSURE_THRESHOLD;
  const topN = options?.topN ?? DEFAULT_TOP_N;
  const signal = options?.signal;
  const onProgress = options?.onProgress;
  const onWarning = options?.onWarning;
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const startTime = performance.now();
  const startRss = process.memoryUsage().rss;

  // Check cancellation before any I/O.
  if (signal?.aborted) {
    throw new PerfCompanionError(
      `Parse aborted: ${signal.reason ?? 'signal already aborted'}`,
      PerfErrorCode.PARSE_FAILED,
      /* recoverable= */ true,
    );
  }

  // ── Guard: file existence and size ─────────────────────────────────
  const fileStat = await stat(filePath).catch(
    (err: NodeJS.ErrnoException) => {
      throw new PerfCompanionError(
        `Cannot stat snapshot file: ${err.message}`,
        err.code === 'ENOENT'
          ? PerfErrorCode.FILE_NOT_FOUND
          : PerfErrorCode.PARSE_FAILED,
        /* recoverable= */ false,
      );
    },
  );

  if (fileStat.size > maxFileSize) {
    throw new PerfCompanionError(
      `Snapshot file is ${formatBytes(fileStat.size)} which exceeds the ` +
        `${formatBytes(maxFileSize)} limit.`,
      PerfErrorCode.SNAPSHOT_TOO_LARGE,
      /* recoverable= */ false,
    );
  }

  const totalBytes = fileStat.size;

  // ── Stream and parse ───────────────────────────────────────────────
  const processor = new SnapshotStreamProcessor();
  const stream = createReadStream(filePath, { highWaterMark: chunkSize });
  const decoder = new TextDecoder('utf-8');
  let bytesProcessed = 0;
  let pressureWarned = false;

  try {
    for await (const rawChunk of stream) {
      if (signal?.aborted) {
        stream.destroy();
        throw new PerfCompanionError(
          `Parse aborted: ${signal.reason ?? 'aborted'}`,
          PerfErrorCode.PARSE_FAILED,
          /* recoverable= */ true,
        );
      }

      const chunk = rawChunk as Buffer;
      // TextDecoder with stream:true handles multi-byte sequences
      // that span chunk boundaries.
      const text = decoder.decode(chunk, { stream: true });
      processor.processChunk(text);

      bytesProcessed += chunk.length;

      if (onProgress !== undefined) {
        onProgress(bytesProcessed, totalBytes);
      }

      if (!pressureWarned && onWarning && process.memoryUsage().rss > pressureThreshold) {
        const rssMb = (process.memoryUsage().rss / 1_048_576).toFixed(0);
        onWarning(
          `[perf-companion] Streaming parser memory pressure: RSS=${rssMb} MB`,
        );
        pressureWarned = true;
      }
    }

    // Flush any trailing bytes from the TextDecoder.
    const tail = decoder.decode(new Uint8Array(0), { stream: false });
    if (tail.length > 0) {
      processor.processChunk(tail);
    }

    processor.finalize();
  } catch (err) {
    if (err instanceof PerfCompanionError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PerfCompanionError(
      `Streaming parse failed: ${message}`,
      PerfErrorCode.PARSE_FAILED,
      /* recoverable= */ false,
    );
  }

  // ── Extract collected data ─────────────────────────────────────────
  const meta = processor.getMeta();
  const strings = processor.getStrings();
  const flatNodes = processor.getFlatNodes();
  const flatEdges = processor.getFlatEdges();

  // ── Structured decoding (reuses batch parser modules) ──────────────
  const nodes = parseNodes(flatNodes, meta, strings);
  const edges = parseEdges(flatEdges, nodes, meta, strings);
  const reverseGraph = buildReverseGraph(edges);

  // ── Summary ────────────────────────────────────────────────────────
  const summary = buildStreamingSummary(
    nodes,
    strings,
    edges,
    topN,
    startTime,
    startRss,
  );

  return { meta, nodes, edges, strings, reverseGraph, summary };
}

// ─── Stream Processor ────────────────────────────────────────────────

/**
 * Which top-level section of the heapsnapshot we are currently processing.
 *
 * The processor scans for top-level JSON keys (`"snapshot"`, `"nodes"`,
 * `"edges"`, `"strings"`) and routes character processing to the
 * appropriate section handler.  Unrecognized keys are fast-forwarded
 * via depth tracking.
 */
const enum Section {
  /** Scanning for the next top-level key. */
  SCANNING = 0,
  /** Buffering the `snapshot` sub-object for conventional JSON.parse. */
  SNAPSHOT_OBJECT = 1,
  /** Extracting integers from the `nodes` flat array. */
  NODES_ARRAY = 2,
  /** Extracting integers from the `edges` flat array. */
  EDGES_ARRAY = 3,
  /** Extracting strings from the `strings` array. */
  STRINGS_ARRAY = 4,
  /** Skipping an unrecognized section via depth tracking. */
  SKIPPING = 5,
}

/**
 * Sub-state for JSON string awareness within each section.
 *
 * Structural characters (`{`, `}`, `[`, `]`) inside JSON strings must
 * not be interpreted as delimiters.  This enum tracks whether we are
 * currently inside a quoted string.
 */
const enum StringAwareness {
  NORMAL = 0,
  IN_STRING = 1,
  IN_STRING_ESCAPE = 2,
}

/**
 * Processes a V8 heap snapshot JSON stream chunk by chunk.
 *
 * Invariants:
 *   - The processor assumes a single top-level JSON object.
 *   - Each top-level key maps to exactly one section.
 *   - Sections are fully consumed before returning to SCANNING.
 *   - The `depth` field is always 1 when in SCANNING state (inside the
 *     root object body).
 */
class SnapshotStreamProcessor {
  // ── Section routing ────────────────────────────────────────────────
  private section = Section.SCANNING;

  // ── SCANNING state ─────────────────────────────────────────────────
  /** JSON nesting depth.  0 = outside root object, 1 = root body. */
  private depth = 0;
  /** String awareness for the SCANNING section. */
  private scanAwareness = StringAwareness.NORMAL;
  /** Whether the next string at depth 1 is expected to be an object key. */
  private expectingKey = false;
  /** Buffer for the current top-level key being read. */
  private keyBuffer = '';
  /** Whether we are actively reading characters into keyBuffer. */
  private readingKey = false;

  // ── SNAPSHOT_OBJECT state ──────────────────────────────────────────
  private snapshotBuffer = '';
  private snapshotDepth = 0;
  private snapshotAwareness = StringAwareness.NORMAL;

  // ── Integer extraction (NODES/EDGES) ───────────────────────────────
  private flatNodes: number[] = [];
  private flatEdges: number[] = [];
  /** Accumulator for the current integer being parsed from digits. */
  private intAccumulator = 0;
  /** Whether we have at least one digit in the current integer. */
  private hasInt = false;
  /** Whether the current integer is negative. */
  private intNegative = false;

  // ── String extraction (STRINGS) ────────────────────────────────────
  private strings: string[] = [];
  private stringBuffer = '';
  private inStringLiteral = false;
  private inStringEscape = false;
  private unicodeBuffer = '';
  private unicodeRemaining = 0;

  // ── SKIPPING state ─────────────────────────────────────────────────
  private skipDepth = 0;
  private skipAwareness = StringAwareness.NORMAL;

  // ── Parsed metadata ────────────────────────────────────────────────
  private snapshotMeta: HeapSnapshotMeta | undefined;

  // ── Result accessors ───────────────────────────────────────────────

  getMeta(): HeapSnapshotMeta {
    if (this.snapshotMeta === undefined) {
      throw new PerfCompanionError(
        'Snapshot metadata not found. File may be truncated or invalid.',
        PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
        /* recoverable= */ false,
      );
    }
    return this.snapshotMeta;
  }

  getFlatNodes(): number[] {
    return this.flatNodes;
  }
  getFlatEdges(): number[] {
    return this.flatEdges;
  }
  getStrings(): string[] {
    return this.strings;
  }

  // ── Main entry point ───────────────────────────────────────────────

  /**
   * Process a chunk of the UTF-8 decoded input stream.
   *
   * Chunks must be provided sequentially in file order.  Partial
   * multi-byte UTF-8 sequences at chunk boundaries should be handled
   * by the caller (e.g., via `TextDecoder` with `stream: true`).
   */
  processChunk(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);

      switch (this.section) {
        case Section.SCANNING:
          this.processScanChar(ch, text[i]);
          break;
        case Section.SNAPSHOT_OBJECT:
          this.processSnapshotChar(ch, text[i]);
          break;
        case Section.NODES_ARRAY:
          this.processIntArrayChar(ch, this.flatNodes);
          break;
        case Section.EDGES_ARRAY:
          this.processIntArrayChar(ch, this.flatEdges);
          break;
        case Section.STRINGS_ARRAY:
          this.processStringsChar(ch, text[i]);
          break;
        case Section.SKIPPING:
          this.processSkipChar(ch);
          break;
      }
    }
  }

  /**
   * Finalize the parse after all chunks have been processed.
   *
   * Flushes any pending integer value and validates that the required
   * `snapshot` metadata was found.
   */
  finalize(): void {
    // Flush a trailing integer if the stream ended mid-array.
    if (
      this.hasInt &&
      (this.section === Section.NODES_ARRAY ||
        this.section === Section.EDGES_ARRAY)
    ) {
      const target =
        this.section === Section.NODES_ARRAY
          ? this.flatNodes
          : this.flatEdges;
      target.push(
        this.intNegative ? -this.intAccumulator : this.intAccumulator,
      );
      this.hasInt = false;
    }

    if (this.snapshotMeta === undefined) {
      throw new PerfCompanionError(
        'Stream ended without a valid "snapshot" metadata object.',
        PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
        /* recoverable= */ false,
      );
    }
  }

  // ── SCANNING section handler ───────────────────────────────────────

  /**
   * Scan for top-level keys in the root JSON object.
   *
   * Tracks JSON nesting depth and string boundaries to correctly
   * identify structural characters.  When a top-level key is found
   * and its value begins (`{` or `[`), routes to the appropriate
   * section handler.
   */
  private processScanChar(ch: number, char: string): void {
    // Handle string-interior characters first.
    switch (this.scanAwareness) {
      case StringAwareness.IN_STRING:
        if (ch === 0x5c) {
          // backslash
          this.scanAwareness = StringAwareness.IN_STRING_ESCAPE;
          if (this.readingKey) this.keyBuffer += char;
        } else if (ch === 0x22) {
          // closing quote
          this.scanAwareness = StringAwareness.NORMAL;
          if (this.readingKey) {
            this.readingKey = false;
            // keyBuffer now holds the complete key.
          }
        } else {
          if (this.readingKey) this.keyBuffer += char;
        }
        return;

      case StringAwareness.IN_STRING_ESCAPE:
        this.scanAwareness = StringAwareness.IN_STRING;
        if (this.readingKey) this.keyBuffer += char;
        return;

      case StringAwareness.NORMAL:
        break; // Fall through to structural handling.
    }

    // ── Structural characters (outside strings) ──────────────────────

    if (ch === 0x22) {
      // Opening double quote.
      this.scanAwareness = StringAwareness.IN_STRING;
      if (this.depth === 1 && this.expectingKey) {
        this.readingKey = true;
        this.keyBuffer = '';
      }
      return;
    }

    if (ch === 0x7b) {
      // {
      this.depth++;
      if (this.depth === 1) {
        // Entered root object.
        this.expectingKey = true;
      } else if (this.depth === 2 && this.keyBuffer.length > 0) {
        // Object value for a top-level key.
        this.routeToSection(this.keyBuffer);
        return;
      }
      return;
    }

    if (ch === 0x7d) {
      // }
      this.depth--;
      return;
    }

    if (ch === 0x5b) {
      // [
      if (this.depth === 1 && this.keyBuffer.length > 0) {
        // Array value for a top-level key.
        this.routeToSection(this.keyBuffer);
        return;
      }
      return;
    }

    if (ch === 0x3a) {
      // colon after key
      this.expectingKey = false;
      return;
    }

    if (ch === 0x2c) {
      // comma
      if (this.depth === 1) {
        this.expectingKey = true;
        this.keyBuffer = '';
      }
      return;
    }
  }

  /**
   * Route to a section handler based on the detected top-level key.
   *
   * Initializes section-specific state and switches the main section
   * field to begin processing subsequent characters in the new section.
   */
  private routeToSection(key: string): void {
    switch (key) {
      case 'snapshot':
        this.section = Section.SNAPSHOT_OBJECT;
        this.snapshotBuffer = '{';
        this.snapshotDepth = 1;
        this.snapshotAwareness = StringAwareness.NORMAL;
        break;

      case 'nodes':
        this.section = Section.NODES_ARRAY;
        this.intAccumulator = 0;
        this.hasInt = false;
        this.intNegative = false;
        break;

      case 'edges':
        this.section = Section.EDGES_ARRAY;
        this.intAccumulator = 0;
        this.hasInt = false;
        this.intNegative = false;
        break;

      case 'strings':
        this.section = Section.STRINGS_ARRAY;
        this.inStringLiteral = false;
        this.inStringEscape = false;
        this.stringBuffer = '';
        this.unicodeRemaining = 0;
        break;

      default:
        // trace_function_infos, trace_tree, samples, locations.
        this.section = Section.SKIPPING;
        this.skipDepth = 1;
        this.skipAwareness = StringAwareness.NORMAL;
        break;
    }

    this.keyBuffer = '';
  }

  /**
   * Return to the SCANNING section after a section handler completes.
   *
   * Resets all scanning state to a known-good configuration: depth 1
   * (inside root object), expecting the next key after a comma.
   */
  private returnToScanning(): void {
    this.section = Section.SCANNING;
    this.scanAwareness = StringAwareness.NORMAL;
    this.depth = 1;
    this.expectingKey = true;
    this.keyBuffer = '';
    this.readingKey = false;
  }

  // ── SNAPSHOT_OBJECT section handler ────────────────────────────────

  /**
   * Buffer the `snapshot` sub-object for conventional JSON.parse.
   *
   * The snapshot metadata (~2 KB) is small enough to buffer entirely.
   * We track brace depth and string boundaries to find the matching
   * close brace, then parse the buffer to extract `meta`, `node_count`,
   * and `edge_count`.
   */
  private processSnapshotChar(ch: number, char: string): void {
    this.snapshotBuffer += char;

    switch (this.snapshotAwareness) {
      case StringAwareness.IN_STRING:
        if (ch === 0x5c) {
          this.snapshotAwareness = StringAwareness.IN_STRING_ESCAPE;
        } else if (ch === 0x22) {
          this.snapshotAwareness = StringAwareness.NORMAL;
        }
        return;

      case StringAwareness.IN_STRING_ESCAPE:
        this.snapshotAwareness = StringAwareness.IN_STRING;
        return;

      case StringAwareness.NORMAL:
        if (ch === 0x22) {
          this.snapshotAwareness = StringAwareness.IN_STRING;
        } else if (ch === 0x7b) {
          this.snapshotDepth++;
        } else if (ch === 0x7d) {
          this.snapshotDepth--;
          if (this.snapshotDepth === 0) {
            this.parseSnapshotBuffer();
            this.returnToScanning();
          }
        }
        return;
    }
  }

  /**
   * Parse the buffered snapshot JSON to extract metadata and counts.
   */
  private parseSnapshotBuffer(): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(this.snapshotBuffer) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PerfCompanionError(
        `Failed to parse snapshot metadata: ${msg}`,
        PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
        /* recoverable= */ false,
      );
    }

    // Release the buffer immediately.
    this.snapshotBuffer = '';

    // Extract and validate metadata.
    const meta = raw['meta'] as Record<string, unknown> | undefined;
    if (meta === undefined) {
      throw new PerfCompanionError(
        'snapshot object is missing "meta"',
        PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
        /* recoverable= */ false,
      );
    }

    const nodeFields = meta['node_fields'];
    const edgeFields = meta['edge_fields'];

    if (!Array.isArray(nodeFields) || !Array.isArray(edgeFields)) {
      throw new PerfCompanionError(
        'snapshot.meta must contain node_fields and edge_fields arrays',
        PerfErrorCode.INVALID_SNAPSHOT_FORMAT,
        /* recoverable= */ false,
      );
    }

    this.snapshotMeta = {
      nodeFields: nodeFields as string[],
      nodeTypes: (meta['node_types'] as Array<string | string[]>) ?? [],
      edgeFields: edgeFields as string[],
      edgeTypes: (meta['edge_types'] as Array<string | string[]>) ?? [],
      traceFunctionInfoFields:
        (meta['trace_function_info_fields'] as string[]) ?? [],
      traceNodeFields: (meta['trace_node_fields'] as string[]) ?? [],
      sampleFields: (meta['sample_fields'] as string[]) ?? [],
      locationFields: (meta['location_fields'] as string[]) ?? [],
    };
  }

  // ── INTEGER ARRAY section handler (nodes / edges) ──────────────────

  /**
   * Extract integers from a flat JSON array using direct digit
   * accumulation.
   *
   * For each digit character, the accumulator is updated in-place:
   *   `value = value * 10 + (charCode - 0x30)`
   *
   * This avoids creating intermediate strings for each of the millions
   * of integers in large snapshots.  V8 heap snapshot arrays contain
   * only non-negative integers; negative values are handled defensively.
   */
  private processIntArrayChar(ch: number, target: number[]): void {
    // Fast path: ASCII digit (0x30 = '0', 0x39 = '9').
    if (ch >= 0x30 && ch <= 0x39) {
      this.intAccumulator = this.intAccumulator * 10 + (ch - 0x30);
      this.hasInt = true;
      return;
    }

    // Minus sign (negative numbers — rare in V8 snapshots).
    if (ch === 0x2d) {
      this.intNegative = true;
      return;
    }

    // Value separator (comma) or whitespace: emit accumulated integer.
    if (
      ch === 0x2c ||
      ch === 0x20 ||
      ch === 0x09 ||
      ch === 0x0a ||
      ch === 0x0d
    ) {
      if (this.hasInt) {
        target.push(
          this.intNegative ? -this.intAccumulator : this.intAccumulator,
        );
        this.intAccumulator = 0;
        this.hasInt = false;
        this.intNegative = false;
      }
      return;
    }

    // Closing bracket: emit final integer and return to scanning.
    if (ch === 0x5d) {
      if (this.hasInt) {
        target.push(
          this.intNegative ? -this.intAccumulator : this.intAccumulator,
        );
        this.intAccumulator = 0;
        this.hasInt = false;
        this.intNegative = false;
      }
      this.returnToScanning();
      return;
    }
  }

  // ── STRINGS ARRAY section handler ──────────────────────────────────

  /**
   * Extract JSON strings from the `strings` array.
   *
   * Handles all JSON string escapes per RFC 8259 §7:
   *   - Simple escapes: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`
   *   - Unicode escapes: `\uXXXX`
   *   - Surrogate pairs: high surrogate followed by low surrogate are
   *     emitted as individual UTF-16 code units, which JavaScript
   *     natively represents as the combined code point.
   */
  private processStringsChar(ch: number, char: string): void {
    // ── Unicode escape continuation ──────────────────────────────────
    if (this.unicodeRemaining > 0) {
      this.unicodeBuffer += char;
      this.unicodeRemaining--;
      if (this.unicodeRemaining === 0) {
        const codePoint = parseInt(this.unicodeBuffer, 16);
        if (!isNaN(codePoint)) {
          this.stringBuffer += String.fromCharCode(codePoint);
        }
        this.unicodeBuffer = '';
      }
      return;
    }

    // ── Inside escape sequence ───────────────────────────────────────
    if (this.inStringEscape) {
      this.inStringEscape = false;
      switch (ch) {
        case 0x22:
          this.stringBuffer += '"';
          return; // \"
        case 0x5c:
          this.stringBuffer += '\\';
          return; // \\
        case 0x2f:
          this.stringBuffer += '/';
          return; // \/
        case 0x62:
          this.stringBuffer += '\b';
          return; // \b
        case 0x66:
          this.stringBuffer += '\f';
          return; // \f
        case 0x6e:
          this.stringBuffer += '\n';
          return; // \n
        case 0x72:
          this.stringBuffer += '\r';
          return; // \r
        case 0x74:
          this.stringBuffer += '\t';
          return; // \t
        case 0x75: // \uXXXX
          this.unicodeRemaining = 4;
          this.unicodeBuffer = '';
          return;
        default:
          // Unknown escape — pass through defensively.
          this.stringBuffer += char;
          return;
      }
    }

    // ── Inside string literal ────────────────────────────────────────
    if (this.inStringLiteral) {
      if (ch === 0x5c) {
        this.inStringEscape = true;
      } else if (ch === 0x22) {
        // Closing quote: emit the complete string.
        this.strings.push(this.stringBuffer);
        this.stringBuffer = '';
        this.inStringLiteral = false;
      } else {
        this.stringBuffer += char;
      }
      return;
    }

    // ── Between string literals ──────────────────────────────────────
    if (ch === 0x22) {
      // Opening quote.
      this.inStringLiteral = true;
      this.stringBuffer = '';
      return;
    }

    if (ch === 0x5d) {
      // Closing bracket: end of strings array.
      this.returnToScanning();
      return;
    }

    // Commas and whitespace between strings are ignored.
  }

  // ── SKIPPING section handler ───────────────────────────────────────

  /**
   * Skip an unrecognized section by tracking nesting depth.
   *
   * Correctly handles strings containing structural characters to avoid
   * premature depth changes.
   */
  private processSkipChar(ch: number): void {
    switch (this.skipAwareness) {
      case StringAwareness.IN_STRING:
        if (ch === 0x5c) {
          this.skipAwareness = StringAwareness.IN_STRING_ESCAPE;
        } else if (ch === 0x22) {
          this.skipAwareness = StringAwareness.NORMAL;
        }
        return;

      case StringAwareness.IN_STRING_ESCAPE:
        this.skipAwareness = StringAwareness.IN_STRING;
        return;

      case StringAwareness.NORMAL:
        if (ch === 0x22) {
          this.skipAwareness = StringAwareness.IN_STRING;
        } else if (ch === 0x7b || ch === 0x5b) {
          this.skipDepth++;
        } else if (ch === 0x7d || ch === 0x5d) {
          this.skipDepth--;
          if (this.skipDepth === 0) {
            this.returnToScanning();
          }
        }
        return;
    }
  }
}

// ─── Summary Construction ────────────────────────────────────────────

/**
 * Build a `HeapSnapshotSummary` from the parsed node/edge arrays.
 *
 * Identical logic to the batch parser's summary builder, extracted here
 * to avoid coupling the streaming parser to non-exported internals.
 */
function buildStreamingSummary(
  nodes: readonly HeapNode[],
  strings: readonly string[],
  edges: readonly HeapEdge[],
  topN: number,
  startTime: number,
  startRss: number,
): HeapSnapshotSummary {
  const constructorMap = aggregateByConstructor(nodes);

  let totalSize = 0;
  let detachedDomNodes = 0;

  for (let i = 0; i < nodes.length; i++) {
    totalSize += nodes[i].selfSize;
    if (nodes[i].detachedness > 0) {
      detachedDomNodes++;
    }
  }

  const topConstructors = buildTopConstructors(constructorMap, totalSize, topN);

  const endTime = performance.now();
  const endRss = process.memoryUsage().rss;

  return {
    totalSize,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    stringCount: strings.length,
    topConstructors,
    detachedDomNodes,
    parsingMemoryUsed: endRss - startRss,
    parseTimeMs: Math.round(endTime - startTime),
  };
}

/**
 * Sort constructor groups by total size and return the top N.
 */
function buildTopConstructors(
  constructorMap: Map<string, { count: number; totalSize: number }>,
  totalSize: number,
  topN: number,
): ConstructorGroup[] {
  const entries = Array.from(constructorMap.entries());
  const groups: ConstructorGroup[] = new Array<ConstructorGroup>(
    entries.length,
  );

  for (let i = 0; i < entries.length; i++) {
    const [ctor, data] = entries[i];
    groups[i] = {
      constructor: ctor,
      count: data.count,
      totalSize: data.totalSize,
      averageSize:
        data.count > 0 ? Math.round(data.totalSize / data.count) : 0,
      sizePercentage: totalSize > 0 ? (data.totalSize / totalSize) * 100 : 0,
    };
  }

  groups.sort((a, b) => b.totalSize - a.totalSize);

  if (groups.length <= topN) return groups;
  return groups.slice(0, topN);
}

