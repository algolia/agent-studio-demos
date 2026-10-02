/* ───────────────────────────────────────────────────────────────
   fixture.mjs — a replayed ai-sdk-5 stream, for when no backend answers.

   The events are written in the exact shapes the backend emits
   (rag/utils/ai_sdk/v5/stream.py): start, start-step, tool-input-*,
   tool-output-available, text-*, finish-step, finish, [DONE]. The timings
   are made up and the page labels every fixture turn as a replay, so no
   number it shows can pass for a measurement.
   ─────────────────────────────────────────────────────────────── */

const swatch = (hue, glyph) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">` +
    `<rect width="120" height="120" fill="hsl(${hue} 55% 88%)"/>` +
    `<circle cx="60" cy="56" r="30" fill="hsl(${hue} 50% 58%)"/>` +
    `<text x="60" y="108" font-family="sans-serif" font-size="14" text-anchor="middle" fill="hsl(${hue} 40% 30%)">${glyph}</text>` +
    `</svg>`);

/* check-copy: off */
export const FIXTURE_HITS = [
  { objectID: "fx-1", name: "Trailrunner 3 running shoe", brand: "Northpeak", price: 89, image: swatch(210, "trail"),
    description: "Light trail shoe with a rock plate and a grippy lug sole." },
  { objectID: "fx-2", name: "Cityglide road shoe", brand: "Stride", price: 74, image: swatch(20, "road"),
    description: "Cushioned daily trainer for pavement miles." },
  { objectID: "fx-3", name: "Tempo Lite racer", brand: "Stride", price: 99, image: swatch(340, "race"),
    description: "Low-drop racer with a carbon-infused plate." },
  { objectID: "fx-4", name: "Ridge GTX hiker", brand: "Northpeak", price: 95, image: swatch(120, "hike"),
    description: "Waterproof mid-cut for wet trails." },
  { objectID: "fx-5", name: "Everyday knit sneaker", brand: "Loop", price: 59, image: swatch(270, "knit"),
    description: "Breathable knit upper, machine washable." },
  { objectID: "fx-6", name: "Recovery slide", brand: "Loop", price: 35, image: swatch(45, "slide"),
    description: "Soft foam slide for after the run." },
];

const INTRO = "Three picks under $100, grouped by where you'll run.";
const GROUPS = [
  { title: "Trail", why: "grip and protection off-road",
    results: [{ objectID: "fx-1", why: "rock plate, aggressive lugs" }, { objectID: "fx-4", why: "waterproof for wet trails" }] },
  { title: "Road", why: "cushion for pavement miles",
    results: [{ objectID: "fx-2", why: "soft daily trainer" }, { objectID: "fx-3", why: "fast on race day" }] },
];
const ANSWER = [
  "Here are three strong options under $100. ",
  "For trails, the **Trailrunner 3** ($89) has the best grip. ",
  "On roads, the **Cityglide** ($74) is the comfortable everyday pick, ",
  "and the **Tempo Lite** ($99) is the one to race in.",
];
/* check-copy: on */

/**
 * The event script for one turn. With `prefetch` on, the search ran before
 * the model was called, so the first model step goes straight to grouping
 * the hits. The backend streams that search as a regular tool call and
 * result, its call id starting with `prefetch_`, before the first model step.
 *
 * `missed` plays the other outcome: the prefetched hits were poor, so the
 * model searched anyway and prefetch cost time instead of saving it. The
 * replay treats a question with a budget or an age as one (see `prefetchMisses`).
 */
export function fixtureEvents({ prefetch = false, query = "", missed = false } = {}) {
  const ev = [];
  let t = 160;
  const at = (dt, e) => { t += dt; ev.push([t, e]); };
  at(0, { type: "start", messageId: "fx-msg" });
  if (prefetch) {
    const id = "prefetch_fx";
    at(0, { type: "tool-input-available", toolCallId: id, toolName: "algolia_search_index",
      input: { index: "products", query: query || "running shoes under 100" } });
    at(0, { type: "tool-output-available", toolCallId: id,
      output: { hits: FIXTURE_HITS, nbHits: FIXTURE_HITS.length } });
  }
  // the prefetched search runs before the model's first call, and costs its time either way
  at(prefetch ? 60 : 10, { type: "start-step" });
  if (!prefetch || missed) {
    at(620, { type: "tool-input-start", toolCallId: "fx-call-search", toolName: "algolia_search_index" });
    at(60, { type: "tool-input-delta", toolCallId: "fx-call-search", inputTextDelta: "{\"query\":" });
    at(40, { type: "tool-input-available", toolCallId: "fx-call-search", toolName: "algolia_search_index",
      input: { index: "products", query: query || "running shoes under 100" } });
    at(380, { type: "tool-output-available", toolCallId: "fx-call-search",
      output: { hits: FIXTURE_HITS, nbHits: FIXTURE_HITS.length, queryID: "fx-query" } });
    at(10, { type: "finish-step" });
    at(10, { type: "start-step" });
  }
  const groupStart = !prefetch || missed ? 700 : 540;
  at(groupStart, { type: "tool-input-start", toolCallId: "fx-call-group", toolName: "algolia_grouped_results" });
  // the model writes this payload token by token, and the widget draws it as it grows
  const raw = JSON.stringify({ intro: INTRO, groups: GROUPS });
  const step = Math.ceil(raw.length / 6);
  for (let i = 0; i < raw.length; i += step) {
    at(60, { type: "tool-input-delta", toolCallId: "fx-call-group", inputTextDelta: raw.slice(i, i + step) });
  }
  at(60, { type: "tool-input-available", toolCallId: "fx-call-group", toolName: "algolia_grouped_results",
    input: { intro: INTRO, groups: GROUPS } });
  at(30, { type: "tool-output-available", toolCallId: "fx-call-group", output: { status: "success" } });
  at(10, { type: "finish-step" });
  at(10, { type: "start-step" });
  at(480, { type: "text-start", id: "fx-text" });
  for (const d of ANSWER) at(90, { type: "text-delta", id: "fx-text", delta: d });
  at(20, { type: "text-end", id: "fx-text" });
  at(10, { type: "finish-step" });
  at(10, { type: "finish" });
  ev.push([t + 5, "[DONE]"]);
  return ev;
}

/**
 * A question with a budget or an age in it: as a raw sentence it finds almost
 * nothing in the products index, so the replay has the model search again.
 */
export function prefetchMisses(query) {
  return /\b(under|budget)\b|\byears? old\b/i.test(String(query || ""));
}

/** a fetch that answers every completions call with the script above */
export function createFixtureFetch({ prefetch = false } = {}) {
  return async function fixtureFetch(url, init = {}) {
    let query = "";
    try {
      const body = JSON.parse(init.body || "{}");
      const last = (body.messages || []).filter((m) => m.role === "user").pop();
      query = last ? (last.parts || []).filter((p) => p.type === "text").map((p) => p.text).join(" ") : "";
    } catch (_) { /* no body */ }
    const script = fixtureEvents({ prefetch, query, missed: prefetch && prefetchMisses(query) });
    const signal = init.signal;
    const enc = new TextEncoder();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(script[0][0]);
    const stream = new ReadableStream({
      async start(ctl) {
        let prev = script[0][0];
        for (const [t, e] of script) {
          if (signal && signal.aborted) { ctl.close(); return; }
          await wait(Math.max(0, t - prev));
          prev = t;
          const payload = e === "[DONE]" ? "[DONE]" : JSON.stringify(e);
          ctl.enqueue(enc.encode(`data: ${payload}\n\n`));
        }
        ctl.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
    });
  };
}
