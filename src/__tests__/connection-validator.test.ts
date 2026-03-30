/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join, resolve, normalize } from 'node:path';

import {
  validateConnectionTarget,
  validateCdpMethod,
  isAllowedCdpEvent,
  validateOutputPath,
  scanForSensitiveData,
} from '../security/connection-validator.js';
import { PerfCompanionError, PerfErrorCode } from '../errors.js';

// ─── validateConnectionTarget ───────────────────────────────────────

describe('validateConnectionTarget', () => {
  describe('loopback enforcement', () => {
    it('should accept 127.0.0.1', () => {
      expect(() => validateConnectionTarget('127.0.0.1', 9229)).not.toThrow();
    });

    it('should accept ::1 (IPv6 loopback)', () => {
      expect(() => validateConnectionTarget('::1', 9229)).not.toThrow();
    });

    it('should accept [::1] (bracketed IPv6)', () => {
      expect(() => validateConnectionTarget('[::1]', 9229)).not.toThrow();
    });

    it('should accept localhost', () => {
      expect(() => validateConnectionTarget('localhost', 9229)).not.toThrow();
    });

    it('should accept case-insensitive localhost', () => {
      expect(() => validateConnectionTarget('LOCALHOST', 9229)).not.toThrow();
      expect(() => validateConnectionTarget('Localhost', 9229)).not.toThrow();
    });

    it('should reject non-loopback IPv4 addresses', () => {
      expect(() => validateConnectionTarget('192.168.1.1', 9229)).toThrow(
        PerfCompanionError,
      );
      expect(() => validateConnectionTarget('10.0.0.1', 9229)).toThrow(
        PerfCompanionError,
      );
      expect(() => validateConnectionTarget('0.0.0.0', 9229)).toThrow(
        PerfCompanionError,
      );
    });

    it('should reject public IP addresses', () => {
      expect(() => validateConnectionTarget('8.8.8.8', 9229)).toThrow(
        PerfCompanionError,
      );
      expect(() => validateConnectionTarget('142.250.80.46', 9229)).toThrow(
        PerfCompanionError,
      );
    });

    it('should reject hostnames that are not localhost', () => {
      expect(() =>
        validateConnectionTarget('my-server.local', 9229),
      ).toThrow(PerfCompanionError);
      expect(() =>
        validateConnectionTarget('evil.com', 9229),
      ).toThrow(PerfCompanionError);
    });

    it('should reject DNS rebinding attempts', () => {
      // An attacker could register a domain that resolves to 127.0.0.1.
      // We validate the raw string, not DNS resolution.
      expect(() =>
        validateConnectionTarget('localhost.evil.com', 9229),
      ).toThrow(PerfCompanionError);
      expect(() =>
        validateConnectionTarget('127.0.0.1.evil.com', 9229),
      ).toThrow(PerfCompanionError);
    });

    it('should provide actionable error messages', () => {
      try {
        validateConnectionTarget('192.168.1.100', 9229);
      } catch (err) {
        expect((err as PerfCompanionError).code).toBe(
          PerfErrorCode.INVALID_PARAMS,
        );
        expect((err as PerfCompanionError).message).toContain('non-loopback');
        expect((err as PerfCompanionError).message).toContain('127.0.0.1');
        expect((err as PerfCompanionError).recoverable).toBe(false);
      }
    });
  });

  describe('port range validation', () => {
    it('should accept standard inspector port 9229', () => {
      expect(() => validateConnectionTarget('127.0.0.1', 9229)).not.toThrow();
    });

    it('should accept user-space ports (1024–65535)', () => {
      expect(() => validateConnectionTarget('127.0.0.1', 1024)).not.toThrow();
      expect(() => validateConnectionTarget('127.0.0.1', 3000)).not.toThrow();
      expect(() => validateConnectionTarget('127.0.0.1', 8080)).not.toThrow();
      expect(() =>
        validateConnectionTarget('127.0.0.1', 65535),
      ).not.toThrow();
    });

    it('should reject privileged ports (1–1023)', () => {
      expect(() => validateConnectionTarget('127.0.0.1', 22)).toThrow(
        PerfCompanionError,
      );
      expect(() => validateConnectionTarget('127.0.0.1', 80)).toThrow(
        PerfCompanionError,
      );
      expect(() => validateConnectionTarget('127.0.0.1', 443)).toThrow(
        PerfCompanionError,
      );
      expect(() => validateConnectionTarget('127.0.0.1', 1023)).toThrow(
        PerfCompanionError,
      );
    });

    it('should reject port 0', () => {
      expect(() => validateConnectionTarget('127.0.0.1', 0)).toThrow(
        PerfCompanionError,
      );
    });

    it('should reject negative ports', () => {
      expect(() => validateConnectionTarget('127.0.0.1', -1)).toThrow(
        PerfCompanionError,
      );
    });

    it('should reject ports above 65535', () => {
      expect(() => validateConnectionTarget('127.0.0.1', 65536)).toThrow(
        PerfCompanionError,
      );
      expect(() => validateConnectionTarget('127.0.0.1', 100000)).toThrow(
        PerfCompanionError,
      );
    });

    it('should reject non-integer ports', () => {
      expect(() => validateConnectionTarget('127.0.0.1', 9229.5)).toThrow(
        PerfCompanionError,
      );
      expect(() => validateConnectionTarget('127.0.0.1', NaN)).toThrow(
        PerfCompanionError,
      );
    });

    it('should provide actionable error for privileged ports', () => {
      try {
        validateConnectionTarget('127.0.0.1', 443);
      } catch (err) {
        expect((err as PerfCompanionError).message).toContain('1024');
        expect((err as PerfCompanionError).message).toContain('65535');
        expect((err as PerfCompanionError).message).toContain('9229');
      }
    });
  });
});

// ─── validateCdpMethod ──────────────────────────────────────────────

describe('validateCdpMethod', () => {
  describe('allowed methods', () => {
    it('should allow HeapProfiler methods', () => {
      expect(() => validateCdpMethod('HeapProfiler.enable')).not.toThrow();
      expect(() => validateCdpMethod('HeapProfiler.disable')).not.toThrow();
      expect(() =>
        validateCdpMethod('HeapProfiler.takeHeapSnapshot'),
      ).not.toThrow();
      expect(() =>
        validateCdpMethod('HeapProfiler.collectGarbage'),
      ).not.toThrow();
      expect(() =>
        validateCdpMethod('HeapProfiler.startSampling'),
      ).not.toThrow();
      expect(() =>
        validateCdpMethod('HeapProfiler.stopSampling'),
      ).not.toThrow();
    });

    it('should allow Profiler (CPU) methods', () => {
      expect(() => validateCdpMethod('Profiler.enable')).not.toThrow();
      expect(() => validateCdpMethod('Profiler.disable')).not.toThrow();
      expect(() => validateCdpMethod('Profiler.start')).not.toThrow();
      expect(() => validateCdpMethod('Profiler.stop')).not.toThrow();
      expect(() =>
        validateCdpMethod('Profiler.setSamplingInterval'),
      ).not.toThrow();
    });

    it('should allow safe Runtime methods', () => {
      expect(() => validateCdpMethod('Runtime.getHeapUsage')).not.toThrow();
    });

    it('should allow NodeTracing methods', () => {
      expect(() => validateCdpMethod('NodeTracing.start')).not.toThrow();
      expect(() => validateCdpMethod('NodeTracing.stop')).not.toThrow();
      expect(() =>
        validateCdpMethod('NodeTracing.getCategories'),
      ).not.toThrow();
    });
  });

  describe('blocked methods', () => {
    it('should block Runtime.evaluate (code execution)', () => {
      expect(() => validateCdpMethod('Runtime.evaluate')).toThrow(
        PerfCompanionError,
      );
    });

    it('should block Runtime.callFunctionOn (code execution)', () => {
      expect(() => validateCdpMethod('Runtime.callFunctionOn')).toThrow(
        PerfCompanionError,
      );
    });

    it('should block Runtime.compileScript', () => {
      expect(() => validateCdpMethod('Runtime.compileScript')).toThrow(
        PerfCompanionError,
      );
    });

    it('should block Debugger domain methods', () => {
      expect(() => validateCdpMethod('Debugger.enable')).toThrow(
        PerfCompanionError,
      );
      expect(() => validateCdpMethod('Debugger.setBreakpoint')).toThrow(
        PerfCompanionError,
      );
    });

    it('should block NodeWorker domain methods', () => {
      expect(() => validateCdpMethod('NodeWorker.enable')).toThrow(
        PerfCompanionError,
      );
      expect(() =>
        validateCdpMethod('NodeWorker.sendMessageToWorker'),
      ).toThrow(PerfCompanionError);
    });

    it('should block IO domain (file access)', () => {
      expect(() => validateCdpMethod('IO.read')).toThrow(PerfCompanionError);
    });

    it('should block unknown methods', () => {
      expect(() => validateCdpMethod('Custom.dangerousMethod')).toThrow(
        PerfCompanionError,
      );
    });

    it('should provide domain name in error messages', () => {
      try {
        validateCdpMethod('Runtime.evaluate');
      } catch (err) {
        expect((err as PerfCompanionError).message).toContain('Runtime');
        expect((err as PerfCompanionError).message).toContain(
          'Runtime.evaluate',
        );
        expect((err as PerfCompanionError).code).toBe(
          PerfErrorCode.INVALID_PARAMS,
        );
      }
    });
  });
});

// ─── isAllowedCdpEvent ──────────────────────────────────────────────

describe('isAllowedCdpEvent', () => {
  it('should allow HeapProfiler events', () => {
    expect(
      isAllowedCdpEvent('HeapProfiler.addHeapSnapshotChunk'),
    ).toBe(true);
    expect(
      isAllowedCdpEvent('HeapProfiler.reportHeapSnapshotProgress'),
    ).toBe(true);
  });

  it('should allow Profiler events', () => {
    expect(isAllowedCdpEvent('Profiler.consoleProfileStarted')).toBe(true);
  });

  it('should block Debugger events', () => {
    expect(isAllowedCdpEvent('Debugger.paused')).toBe(false);
    expect(isAllowedCdpEvent('Debugger.scriptParsed')).toBe(false);
  });

  it('should block Runtime events besides allowed domains', () => {
    // Runtime domain is allowed for events too.
    expect(isAllowedCdpEvent('Runtime.consoleAPICalled')).toBe(true);
  });

  it('should block unknown domain events', () => {
    expect(isAllowedCdpEvent('Network.requestWillBeSent')).toBe(false);
    expect(isAllowedCdpEvent('Page.loadEventFired')).toBe(false);
  });

  it('should handle malformed event method names', () => {
    expect(isAllowedCdpEvent('')).toBe(false);
    expect(isAllowedCdpEvent('nodomain')).toBe(false);
  });
});

// ─── validateOutputPath ─────────────────────────────────────────────

describe('validateOutputPath', () => {
  it('should accept paths within system temp directory', () => {
    const safePath = join(tmpdir(), 'gemini-perf', 'snapshot.heapsnapshot');
    expect(() => validateOutputPath(safePath)).not.toThrow();
  });

  it('should accept paths exactly matching the temp directory', () => {
    expect(() => validateOutputPath(tmpdir())).not.toThrow();
  });

  it('should reject paths outside allowed roots', () => {
    expect(() => validateOutputPath('/etc/passwd')).toThrow(
      PerfCompanionError,
    );
    expect(() => validateOutputPath('C:\\Windows\\System32\\config')).toThrow(
      PerfCompanionError,
    );
  });

  it('should reject path traversal attempts', () => {
    const traversal = join(tmpdir(), '..', '..', 'etc', 'shadow');
    expect(() => validateOutputPath(traversal)).toThrow(PerfCompanionError);
  });

  it('should accept custom allowed roots', () => {
    const customRoot = join(tmpdir(), 'my-project');
    const outputPath = join(customRoot, 'snapshots', 'test.heapsnapshot');

    expect(() =>
      validateOutputPath(outputPath, [customRoot]),
    ).not.toThrow();
  });

  it('should reject paths that share a prefix but are not children', () => {
    // e.g., if allowed root is "/tmp/safe", "/tmp/safe-extra/file" should fail.
    const root = join(tmpdir(), 'safe');
    const trickPath = join(tmpdir(), 'safe-extra', 'file');

    expect(() => validateOutputPath(trickPath, [root])).toThrow(
      PerfCompanionError,
    );
  });

  it('should normalize paths before validation', () => {
    // Path with redundant segments should still validate.
    const safePath = join(tmpdir(), 'a', '..', 'b', 'snapshot.heapsnapshot');
    expect(() => validateOutputPath(safePath)).not.toThrow();
  });

  it('should provide actionable error messages', () => {
    try {
      validateOutputPath('/usr/local/bin/bad');
    } catch (err) {
      expect((err as PerfCompanionError).message).toContain('outside');
      expect((err as PerfCompanionError).message).toContain('Allowed roots');
      expect((err as PerfCompanionError).code).toBe(
        PerfErrorCode.INVALID_PARAMS,
      );
    }
  });
});

// ─── scanForSensitiveData ───────────────────────────────────────────

describe('scanForSensitiveData', () => {
  it('should return clean report for safe strings', () => {
    const strings = [
      'LeakyCache',
      'EventEmitter',
      '(GC roots)',
      'listener',
      'Object',
    ];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(false);
    expect(report.flaggedCount).toBe(0);
    expect(report.totalStrings).toBe(5);
  });

  it('should detect API keys', () => {
    const strings = [
      'normal string',
      'api_key=sk-1234567890abcdef',
      'another normal string',
    ];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.flaggedCount).toBe(1);
    expect(report.findings.get('API key (generic)')).toBe(1);
  });

  it('should detect Bearer tokens', () => {
    const strings = [
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test',
    ];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.findings.has('Bearer token')).toBe(true);
  });

  it('should detect AWS access keys', () => {
    const strings = ['AKIAIOSFODNN7EXAMPLE12'];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.findings.has('AWS access key')).toBe(true);
  });

  it('should detect private key markers', () => {
    const strings = ['-----BEGIN RSA PRIVATE KEY-----'];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.findings.has('Private key marker')).toBe(true);
  });

  it('should detect JWT tokens', () => {
    const strings = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.findings.has('JWT token')).toBe(true);
  });

  it('should detect connection strings', () => {
    const strings = ['mongodb://user:pass@host:27017/db'];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.findings.has('Connection string')).toBe(true);
  });

  it('should detect GitHub tokens', () => {
    const strings = ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.findings.has('GitHub token')).toBe(true);
  });

  it('should detect Google API keys', () => {
    const strings = ['AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.findings.has('Google API key')).toBe(true);
  });

  it('should detect password fields', () => {
    const strings = ['password=supersecret123'];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(true);
    expect(report.findings.has('Password field')).toBe(true);
  });

  it('should count multiple findings across different categories', () => {
    const strings = [
      'api_key=sk-abcdef1234567890',
      'Bearer eyJhbGciOiJIUzI1NiJ9.test',
      'password=hunter2abc',
      'safe string without secrets',
    ];

    const report = scanForSensitiveData(strings);

    expect(report.flaggedCount).toBe(3);
    expect(report.findings.size).toBe(3);
  });

  it('should skip strings shorter than 8 characters', () => {
    const strings = ['key=val', 'api=x', 'short'];

    const report = scanForSensitiveData(strings);

    expect(report.hasSensitiveData).toBe(false);
  });

  it('should handle empty string array', () => {
    const report = scanForSensitiveData([]);

    expect(report.totalStrings).toBe(0);
    expect(report.flaggedCount).toBe(0);
    expect(report.hasSensitiveData).toBe(false);
  });
});
