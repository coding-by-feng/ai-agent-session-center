// test/mqReader.test.js — Tests for JSONL parsing logic
// Since mqReader.js has heavy side effects (fs.watch, file I/O, process-level state),
// we test the JSONL parsing and line-splitting logic in isolation.
import { describe, it, expect } from 'vitest';

// Simulate the core JSONL line-splitting logic from mqReader.readNewLines
function parseJsonlChunk(partialLine, chunk) {
  const combined = partialLine + chunk;
  const lines = combined.split('\n');
  const newPartial = lines.pop(); // last element is partial or ''
  const parsed = [];
  const errors = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch (err) {
      errors.push({ line: trimmed, error: err.message });
    }
  }

  return { parsed, errors, partial: newPartial };
}

describe('mqReader - JSONL parsing', () => {
  describe('parseJsonlChunk', () => {
    it('parses a single complete JSONL line', () => {
      const { parsed, errors, partial } = parseJsonlChunk('', '{"session_id":"abc","hook_event_name":"SessionStart"}\n');
      expect(parsed.length).toBe(1);
      expect(parsed[0].session_id).toBe('abc');
      expect(errors.length).toBe(0);
      expect(partial).toBe('');
    });

    it('parses multiple JSONL lines', () => {
      const chunk = '{"a":1}\n{"b":2}\n{"c":3}\n';
      const { parsed, errors, partial } = parseJsonlChunk('', chunk);
      expect(parsed.length).toBe(3);
      expect(parsed[0].a).toBe(1);
      expect(parsed[1].b).toBe(2);
      expect(parsed[2].c).toBe(3);
      expect(errors.length).toBe(0);
      expect(partial).toBe('');
    });

    it('handles partial line at end of buffer', () => {
      const chunk = '{"a":1}\n{"b":2}\n{"c":';
      const { parsed, errors, partial } = parseJsonlChunk('', chunk);
      expect(parsed.length).toBe(2);
      expect(parsed[0].a).toBe(1);
      expect(parsed[1].b).toBe(2);
      expect(partial).toBe('{"c":');
    });

    it('completes a partial line from previous read', () => {
      // First read left a partial
      const partial1 = '{"session_id":"x",';
      // Second read completes it
      const chunk = '"hook_event_name":"Stop"}\n';
      const { parsed, errors, partial } = parseJsonlChunk(partial1, chunk);
      expect(parsed.length).toBe(1);
      expect(parsed[0].session_id).toBe('x');
      expect(parsed[0].hook_event_name).toBe('Stop');
      expect(partial).toBe('');
    });

    it('handles empty chunk', () => {
      const { parsed, errors, partial } = parseJsonlChunk('', '');
      expect(parsed.length).toBe(0);
      expect(errors.length).toBe(0);
      expect(partial).toBe('');
    });

    it('handles chunk with only newlines', () => {
      const { parsed, errors, partial } = parseJsonlChunk('', '\n\n\n');
      expect(parsed.length).toBe(0);
      expect(errors.length).toBe(0);
      expect(partial).toBe('');
    });

    it('records errors for invalid JSON lines', () => {
      const chunk = '{"a":1}\nnot-json\n{"b":2}\n';
      const { parsed, errors, partial } = parseJsonlChunk('', chunk);
      expect(parsed.length).toBe(2);
      expect(errors.length).toBe(1);
      expect(errors[0].line).toContain('not-json');
    });

    it('handles lines with extra whitespace', () => {
      const chunk = '  {"a":1}  \n  {"b":2}  \n';
      const { parsed, errors, partial } = parseJsonlChunk('', chunk);
      expect(parsed.length).toBe(2);
      expect(errors.length).toBe(0);
    });
  });
});

describe('mqReader - module exports', () => {
  it('exports getMqStats', async () => {
    const { getMqStats } = await import('../server/mqReader.js');
    expect(typeof getMqStats).toBe('function');
    const stats = getMqStats();
    expect(typeof stats.linesProcessed).toBe('number');
    expect(typeof stats.linesErrored).toBe('number');
    expect(typeof stats.truncations).toBe('number');
    expect(typeof stats.running).toBe('boolean');
    expect(typeof stats.queueFile).toBe('string');
  });

  it('exports getQueueFilePath', async () => {
    const { getQueueFilePath } = await import('../server/mqReader.js');
    expect(typeof getQueueFilePath).toBe('function');
    const path = getQueueFilePath();
    expect(path).toContain('queue.jsonl');
  });
});
