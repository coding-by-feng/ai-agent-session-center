// test/mqReader.test.js — Tests for JSONL parsing logic
// Since mqReader.js has heavy side effects (fs.watch, file I/O, process-level state),
// we test the JSONL parsing and line-splitting logic in isolation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].session_id, 'abc');
      assert.equal(errors.length, 0);
      assert.equal(partial, '');
    });

    it('parses multiple JSONL lines', () => {
      const chunk = '{"a":1}\n{"b":2}\n{"c":3}\n';
      const { parsed, errors, partial } = parseJsonlChunk('', chunk);
      assert.equal(parsed.length, 3);
      assert.equal(parsed[0].a, 1);
      assert.equal(parsed[1].b, 2);
      assert.equal(parsed[2].c, 3);
      assert.equal(errors.length, 0);
      assert.equal(partial, '');
    });

    it('handles partial line at end of buffer', () => {
      const chunk = '{"a":1}\n{"b":2}\n{"c":';
      const { parsed, errors, partial } = parseJsonlChunk('', chunk);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].a, 1);
      assert.equal(parsed[1].b, 2);
      assert.equal(partial, '{"c":');
    });

    it('completes a partial line from previous read', () => {
      // First read left a partial
      const partial1 = '{"session_id":"x",';
      // Second read completes it
      const chunk = '"hook_event_name":"Stop"}\n';
      const { parsed, errors, partial } = parseJsonlChunk(partial1, chunk);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].session_id, 'x');
      assert.equal(parsed[0].hook_event_name, 'Stop');
      assert.equal(partial, '');
    });

    it('handles empty chunk', () => {
      const { parsed, errors, partial } = parseJsonlChunk('', '');
      assert.equal(parsed.length, 0);
      assert.equal(errors.length, 0);
      assert.equal(partial, '');
    });

    it('handles chunk with only newlines', () => {
      const { parsed, errors, partial } = parseJsonlChunk('', '\n\n\n');
      assert.equal(parsed.length, 0);
      assert.equal(errors.length, 0);
      assert.equal(partial, '');
    });

    it('records errors for invalid JSON lines', () => {
      const chunk = '{"a":1}\nnot-json\n{"b":2}\n';
      const { parsed, errors, partial } = parseJsonlChunk('', chunk);
      assert.equal(parsed.length, 2);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].line.includes('not-json'));
    });

    it('handles lines with extra whitespace', () => {
      const chunk = '  {"a":1}  \n  {"b":2}  \n';
      const { parsed, errors, partial } = parseJsonlChunk('', chunk);
      assert.equal(parsed.length, 2);
      assert.equal(errors.length, 0);
    });
  });
});

describe('mqReader - module exports', () => {
  it('exports getMqStats', async () => {
    const { getMqStats } = await import('../server/mqReader.js');
    assert.equal(typeof getMqStats, 'function');
    const stats = getMqStats();
    assert.equal(typeof stats.linesProcessed, 'number');
    assert.equal(typeof stats.linesErrored, 'number');
    assert.equal(typeof stats.truncations, 'number');
    assert.equal(typeof stats.running, 'boolean');
    assert.equal(typeof stats.queueFile, 'string');
  });

  it('exports getQueueFilePath', async () => {
    const { getQueueFilePath } = await import('../server/mqReader.js');
    assert.equal(typeof getQueueFilePath, 'function');
    const path = getQueueFilePath();
    assert.ok(path.includes('queue.jsonl'));
  });
});
