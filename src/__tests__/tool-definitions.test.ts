/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  HEAP_SNAPSHOT_CAPTURE_TOOL_NAME,
  HEAP_SNAPSHOT_ANALYZE_TOOL_NAME,
  CPU_PROFILE_CAPTURE_TOOL_NAME,
  CPU_PROFILE_ANALYZE_TOOL_NAME,
  HEAP_SNAPSHOT_CAPTURE_DEFINITION,
  HEAP_SNAPSHOT_ANALYZE_DEFINITION,
  CPU_PROFILE_CAPTURE_DEFINITION,
  CPU_PROFILE_ANALYZE_DEFINITION,
} from '../integration/tool-definitions.js';

// ─── Schema Validation Helpers ───────────────────────────────────────

interface JsonSchema {
  type: string;
  properties?: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

function assertValidToolSchema(
  name: string,
  definition: { base: { name: string; description: string; parametersJsonSchema: unknown } },
): void {
  // Name matches.
  expect(definition.base.name).toBe(name);

  // Description is non-empty.
  expect(definition.base.description.length).toBeGreaterThan(20);

  // Schema is an object type.
  const schema = definition.base.parametersJsonSchema as JsonSchema;
  expect(schema.type).toBe('object');
  expect(schema.properties).toBeDefined();

  // Every required field exists in properties.
  if (schema.required) {
    for (const field of schema.required) {
      expect(schema.properties).toHaveProperty(field);
    }
  }

  // Every property has a type and description.
  for (const [key, prop] of Object.entries(schema.properties!)) {
    expect(prop.type, `${name}.${key} should have a type`).toBeDefined();
    expect(prop.description, `${name}.${key} should have a description`).toBeDefined();
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Tool Definitions', () => {
  describe('tool names', () => {
    it('should use snake_case naming convention matching gemini-cli', () => {
      expect(HEAP_SNAPSHOT_CAPTURE_TOOL_NAME).toBe('heap_snapshot_capture');
      expect(HEAP_SNAPSHOT_ANALYZE_TOOL_NAME).toBe('heap_snapshot_analyze');
      expect(CPU_PROFILE_CAPTURE_TOOL_NAME).toBe('cpu_profile_capture');
      expect(CPU_PROFILE_ANALYZE_TOOL_NAME).toBe('cpu_profile_analyze');
    });

    it('should have unique tool names', () => {
      const names = [
        HEAP_SNAPSHOT_CAPTURE_TOOL_NAME,
        HEAP_SNAPSHOT_ANALYZE_TOOL_NAME,
        CPU_PROFILE_CAPTURE_TOOL_NAME,
        CPU_PROFILE_ANALYZE_TOOL_NAME,
      ];
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('heap_snapshot_capture schema', () => {
    it('should have a valid schema structure', () => {
      assertValidToolSchema(
        HEAP_SNAPSHOT_CAPTURE_TOOL_NAME,
        HEAP_SNAPSHOT_CAPTURE_DEFINITION,
      );
    });

    it('should require the target parameter', () => {
      const schema = HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.parametersJsonSchema;
      expect(schema.required).toContain('target');
    });

    it('should define target as enum of self/remote', () => {
      const props = HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.parametersJsonSchema.properties;
      expect(props.target.enum).toEqual(['self', 'remote']);
    });

    it('should include remote connection parameters', () => {
      const props = HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.parametersJsonSchema.properties;
      expect(props.host).toBeDefined();
      expect(props.port).toBeDefined();
      expect(props.port.type).toBe('number');
    });

    it('should include capture options', () => {
      const props = HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.parametersJsonSchema.properties;
      expect(props.force_gc).toBeDefined();
      expect(props.force_gc.type).toBe('boolean');
      expect(props.timeout_ms).toBeDefined();
      expect(props.timeout_ms.type).toBe('number');
    });
  });

  describe('heap_snapshot_analyze schema', () => {
    it('should have a valid schema structure', () => {
      assertValidToolSchema(
        HEAP_SNAPSHOT_ANALYZE_TOOL_NAME,
        HEAP_SNAPSHOT_ANALYZE_DEFINITION,
      );
    });

    it('should require snapshot_path and mode', () => {
      const schema = HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.parametersJsonSchema;
      expect(schema.required).toContain('snapshot_path');
      expect(schema.required).toContain('mode');
    });

    it('should define mode as enum of analysis types', () => {
      const props = HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.parametersJsonSchema.properties;
      expect(props.mode.enum).toEqual(['summary', 'diff', 'leak-detect']);
    });

    it('should include optional baseline_path for diff modes', () => {
      const props = HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.parametersJsonSchema.properties;
      expect(props.baseline_path).toBeDefined();
      expect(props.baseline_path.type).toBe('string');
    });

    it('should support output format selection', () => {
      const props = HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.parametersJsonSchema.properties;
      expect(props.output_format.enum).toEqual(['markdown', 'json', 'perfetto']);
    });
  });

  describe('cpu_profile_capture schema', () => {
    it('should have a valid schema structure', () => {
      assertValidToolSchema(
        CPU_PROFILE_CAPTURE_TOOL_NAME,
        CPU_PROFILE_CAPTURE_DEFINITION,
      );
    });

    it('should require the target parameter', () => {
      const schema = CPU_PROFILE_CAPTURE_DEFINITION.base.parametersJsonSchema;
      expect(schema.required).toContain('target');
    });

    it('should include duration parameter', () => {
      const props = CPU_PROFILE_CAPTURE_DEFINITION.base.parametersJsonSchema.properties;
      expect(props.duration_ms).toBeDefined();
      expect(props.duration_ms.type).toBe('number');
    });
  });

  describe('cpu_profile_analyze schema', () => {
    it('should have a valid schema structure', () => {
      assertValidToolSchema(
        CPU_PROFILE_ANALYZE_TOOL_NAME,
        CPU_PROFILE_ANALYZE_DEFINITION,
      );
    });

    it('should require profile_path', () => {
      const schema = CPU_PROFILE_ANALYZE_DEFINITION.base.parametersJsonSchema;
      expect(schema.required).toContain('profile_path');
    });

    it('should support output format including perfetto', () => {
      const props = CPU_PROFILE_ANALYZE_DEFINITION.base.parametersJsonSchema.properties;
      expect(props.output_format.enum).toContain('perfetto');
    });
  });

  describe('cross-tool consistency', () => {
    it('should use consistent parameter naming across capture tools', () => {
      const heapProps = Object.keys(
        HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.parametersJsonSchema.properties,
      );
      const cpuProps = Object.keys(
        CPU_PROFILE_CAPTURE_DEFINITION.base.parametersJsonSchema.properties,
      );

      // Shared parameters should exist in both.
      const shared = ['target', 'host', 'port', 'label', 'output_dir'];
      for (const param of shared) {
        expect(heapProps, `heap capture should have ${param}`).toContain(param);
        expect(cpuProps, `cpu capture should have ${param}`).toContain(param);
      }
    });

    it('should use consistent output_format enum across analyze tools', () => {
      const heapFormats =
        HEAP_SNAPSHOT_ANALYZE_DEFINITION.base.parametersJsonSchema.properties.output_format.enum;
      const cpuFormats =
        CPU_PROFILE_ANALYZE_DEFINITION.base.parametersJsonSchema.properties.output_format.enum;

      expect(heapFormats).toEqual(cpuFormats);
    });

    it('all descriptions should mention their counterpart tool', () => {
      // Capture tools should reference their analyze counterpart.
      expect(HEAP_SNAPSHOT_CAPTURE_DEFINITION.base.description).toContain(
        'heap_snapshot_analyze',
      );
      expect(CPU_PROFILE_CAPTURE_DEFINITION.base.description).toContain(
        'cpu_profile_analyze',
      );
    });
  });
});
