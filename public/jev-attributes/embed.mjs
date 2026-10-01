/* ───────────────────────────────────────────────────────────────
   embed.mjs — a small embedding model, run in a worker in this browser.

   transformers.js loads from jsDelivr, pinned to one exact file of one
   version, the model from the Hugging Face hub at one commit, once: the library keeps the files in the browser's
   Cache Storage, so a second visit downloads nothing. WebGPU when the
   browser offers it, WASM otherwise. The worker keeps inference off the
   main thread, so the other lanes' clocks are not held up by it.
   ─────────────────────────────────────────────────────────────── */

/*
   No SRI: a module worker loads the library with import(), which takes no
   integrity, and checking the bytes by hand would mean importing from a
   blob: URL, which the page's CSP would then have to allow. So the URL names the exact file
   of an exact version (jsDelivr serves versioned files immutable), and its
   hash as fetched on 2026-10-01 is kept here for an audit:
     dist/transformers.min.js  sha384-qgXJ7dcf8bYoYbel57c9rhOd7qRdLSraaF9XvjXERQll0Pf5e/HV8CDccvn3xgTp
   The model is pinned to a commit of its repo, not `main`.
*/
export const EMBED = {
  lib: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js",
  model: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dtype: "q8",
  file: "onnx/model_quantized.onnx",
  approxBytes: 23e6,
};

/**
 * onState({ status, loaded, total, device, cached, error }) on every change.
 * status: idle → loading → ready, or error. load() is idempotent.
 */
export function createEmbedder(onState = () => {}, { device, prime = [] } = {}) {
  let worker = null;
  let readyP = null;
  let seq = 0;
  const waiting = new Map();
  const state = { status: "idle", loaded: 0, total: 0, device: null, cached: null, error: null };
  const set = (patch) => { Object.assign(state, patch); onState({ ...state }); };
  const cache = new Map();

  function start() {
    if (readyP) return readyP;
    readyP = new Promise((ok, fail) => {
      worker = new Worker(new URL("./embed-worker.mjs", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        if (data.type === "progress") set({ loaded: data.loaded, total: data.total });
        else if (data.type === "cached") set({ cached: data.cached });
        else if (data.type === "ready") {
          // texts every question compares against (the section descriptions) are embedded once, as part of the load
          embedNow(prime).then(() => { set({ status: "ready", device: data.device }); ok(); }, fail);
        }
        else if (data.type === "vectors") { const w = waiting.get(data.id); waiting.delete(data.id); if (w) w.ok(data.vectors); }
        else if (data.type === "error") {
          const w = data.id !== undefined && waiting.get(data.id);
          if (w) { waiting.delete(data.id); w.fail(new Error(data.message)); return; }
          set({ status: "error", error: data.message });
          fail(new Error(data.message));
        }
      };
      worker.onerror = (e) => { set({ status: "error", error: e.message || "worker failed" }); fail(new Error(e.message || "worker failed")); };
      set({ status: "loading" });
      worker.postMessage({ type: "load", ...EMBED, device });
    });
    readyP.catch(() => {});
    return readyP;
  }

  async function embedNow(texts) {
    const todo = [...new Set(texts.filter((t) => !cache.has(t)))];
    if (!todo.length) return;
    const id = seq++;
    const vecs = await new Promise((ok, fail) => { waiting.set(id, { ok, fail }); worker.postMessage({ type: "embed", id, texts: todo }); });
    todo.forEach((t, i) => cache.set(t, vecs[i]));
  }

  return {
    model: EMBED.model,
    state: () => ({ ...state }),
    load: start,
    ready: start,
    /** unit vectors, one per text; a text seen before is not embedded twice */
    async embed(texts) {
      await start();
      await embedNow(texts);
      return texts.map((t) => cache.get(t));
    },
  };
}
