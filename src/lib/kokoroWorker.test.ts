import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guards the ONNX runtime wiring in kokoroWorker.ts.
 *
 * transformers.js defaults `wasmPaths` to a jsDelivr URL on import, which makes
 * onnxruntime-web dynamically import its WASM glue from the CDN — the cause of
 * "no available backend found ... Failed to fetch dynamically imported module"
 * whenever the CDN is unreachable, and a silent violation of this feature's
 * offline promise. The override only avoids that dynamic import when it is an
 * *object* carrying `wasm` alone: a plain string is treated as a URL prefix and
 * sends ORT straight back to fetching the glue remotely.
 */

// Keep the ~2MB kokoro-js / transformers graph out of the test.
vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: vi.fn() } }));

const env = { backends: { onnx: { wasm: {} as Record<string, unknown> } } };
vi.mock('@huggingface/transformers', () => ({ env }));

async function loadWorkerModule(): Promise<void> {
  vi.resetModules();
  env.backends.onnx.wasm = {};
  await import('./kokoroWorker');
}

describe('kokoroWorker — ONNX runtime must not depend on a CDN', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('overrides the wasm path on import, before any model load', async () => {
    await loadWorkerModule();
    expect(env.backends.onnx.wasm.wasmPaths).toBeDefined();
  });

  it('points at a local, same-origin binary rather than a remote CDN', async () => {
    await loadWorkerModule();
    const { wasm } = env.backends.onnx.wasm.wasmPaths as { wasm: string };

    expect(typeof wasm).toBe('string');
    expect(wasm).toMatch(/ort-wasm-simd-threaded\.jsep.*\.wasm$/);
    expect(wasm).not.toMatch(/^https?:\/\//);
    expect(wasm).not.toContain('jsdelivr');
  });

  it('uses object form with no `mjs` or prefix, so ORT keeps its embedded glue', async () => {
    await loadWorkerModule();
    const paths = env.backends.onnx.wasm.wasmPaths as Record<string, unknown>;

    // A string here would be read as a URL prefix and re-enable the remote
    // `import()` of ort-wasm-simd-threaded.jsep.mjs — the original bug.
    expect(typeof paths).toBe('object');
    expect(paths.mjs).toBeUndefined();
    expect(Object.keys(paths)).toEqual(['wasm']);
  });

  it('leaves the runtime untouched when the onnx backend is absent', async () => {
    vi.resetModules();
    // @ts-expect-error — deliberately modelling a transformers build with no wasm backend
    env.backends.onnx = {};
    await expect(import('./kokoroWorker')).resolves.toBeDefined();
    env.backends.onnx = { wasm: {} };
  });
});
