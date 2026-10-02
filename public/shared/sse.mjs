/* ───────────────────────────────────────────────────────────────
   sse.mjs — split a server-sent-events byte stream into parsed payloads.

   Pure: no DOM, no fetch. Every demo that reads a stream feeds its chunks in
   here — main-demo's ai-sdk-5 completions, the jev-attributes proxy, and the
   proxy's own read of the LLM's OpenAI-shaped stream.
   ─────────────────────────────────────────────────────────────── */

/** split an SSE byte stream into parsed `data:` payloads */
export function createSseParser(onEvent) {
  const dec = new TextDecoder();
  let buf = "";
  const flushLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") { onEvent({ type: "[DONE]" }); return; }
    let evt;
    try { evt = JSON.parse(payload); } catch (_) { return; }
    if (evt && typeof evt === "object") onEvent(evt);
  };
  return {
    push(chunk) {
      buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) flushLine(line.replace(/\r$/, ""));
    },
    end() { if (buf) flushLine(buf); buf = ""; },
  };
}
