/* ───────────────────────────────────────────────────────────────
   embed-worker.mjs — the embedding model, off the main thread.

     in   { type: "load", lib, model, revision, dtype, file }   once
          { type: "embed", id, texts }
     out  progress { loaded, total } · cached { cached } · ready { device }
          vectors { id, vectors } · error { id?, message }

   The question and the section names are embedded here, in this browser;
   nothing leaves it but the model download.
   ─────────────────────────────────────────────────────────────── */

let extract = null;

/** WebGPU on a real GPU; a software fallback adapter is slower than WASM, so it counts as none */
async function pickDevice(want) {
  if (want === "wasm") return "wasm";
  try {
    const a = self.navigator && self.navigator.gpu ? await self.navigator.gpu.requestAdapter() : null;
    const fallback = a && (a.isFallbackAdapter || (a.info && a.info.isFallbackAdapter));
    if (a && !fallback) return "webgpu";
  } catch (_) { /* no adapter */ }
  return "wasm";
}

async function isCached(model, revision, file) {
  try {
    const c = await self.caches.open("transformers-cache");
    return Boolean(await c.match(`https://huggingface.co/${model}/resolve/${revision}/${file}`));
  } catch (_) { return null; }
}

async function load({ lib, model, revision, dtype, file, device: want }) {
  const { pipeline, env } = await import(lib);
  env.allowLocalModels = false;
  // the runtime's own files load straight from jsDelivr: its cache would re-import them from blob: URLs, which the page's CSP refuses
  env.useWasmCache = false;
  self.postMessage({ type: "cached", cached: await isCached(model, revision, file) });
  const files = new Map();
  const progress = (p) => {
    if (p.status !== "progress" && p.status !== "done") return;
    const f = files.get(p.file) || { loaded: 0, total: 0 };
    if (Number.isFinite(p.total) && p.total > 0) f.total = p.total;
    f.loaded = p.status === "done" ? f.total || f.loaded : (p.loaded || f.loaded);
    files.set(p.file, f);
    let loaded = 0; let total = 0;
    for (const x of files.values()) { loaded += x.loaded; total += x.total; }
    self.postMessage({ type: "progress", loaded, total });
  };
  let device = await pickDevice(want);
  try {
    extract = await pipeline("feature-extraction", model, { revision, device, dtype, progress_callback: progress });
  } catch (err) {
    if (device !== "webgpu") throw err;
    device = "wasm";
    extract = await pipeline("feature-extraction", model, { revision, device, dtype, progress_callback: progress });
  }
  // one throwaway call, so kernel compilation lands in the load, not in the first question
  await extract(["warm up"], { pooling: "mean", normalize: true });
  self.postMessage({ type: "ready", device });
}

self.onmessage = async ({ data }) => {
  if (data.type === "load") {
    try { await load(data); } catch (err) { self.postMessage({ type: "error", message: String(err && err.message || err) }); }
    return;
  }
  if (data.type === "embed") {
    try {
      const out = await extract(data.texts, { pooling: "mean", normalize: true });
      self.postMessage({ type: "vectors", id: data.id, vectors: out.tolist() });
    } catch (err) {
      self.postMessage({ type: "error", id: data.id, message: String(err && err.message || err) });
    }
  }
};
