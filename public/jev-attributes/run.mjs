/* ───────────────────────────────────────────────────────────────
   run.mjs — one question, a full lane and one lane per engine.

   No DOM. The page hands it a transport, the keys it holds, a search and,
   when the embedding engine is on, an embedder; it reports what happens as
   events, each stamped with milliseconds since the run began:

     search      the hits (whole records), the index, the time
     lane        a lane's prompt is built: attribute and character counts
     engine      an engine starts deciding (after its model, if any, is loaded)
     pick        an engine's rows for one stage: sections, then fields
     picked      the engine is done: what it keeps, its time, its tokens
     delta       answer text, per lane, as it streams
     done        the answering LLM's own usage, first token, total
     skip        a lane that cannot run, and why (a key it needs is missing)
     error       per lane, or for the run
     end

   Every lane sends the same model the same hits and the same system
   prompt; the only difference is which attributes the records keep.
   ─────────────────────────────────────────────────────────────── */

import {
  sectionState, sectionQuestions, compactSectionQuestions, compactFieldQuestions, fieldState, fieldQuestions,
  pickSections, pickFields, mainConfidence, fieldsIn, strip, full, weigh, messages,
} from "./attrs.mjs";
import {
  engine, keywordSections, keywordFields, embedSections, embedFields, sectionDocs, fieldDocs,
  pickerSectionMessages, pickerFieldMessages, pickerSectionRows, pickerFieldRows,
} from "./engines.mjs";
import { systemOne, chat, chatOnce, ANSWER_MODEL } from "./client.mjs";

const salt = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

/** which System One request each target gets: the levers suit Jev; Laya keeps ~512 tokens a question */
const REQUEST = {
  jev: {
    sections: (q) => ({ state: sectionState(q), questions: sectionQuestions() }),
    fields: (q, fields) => ({ state: fieldState(q, fields), questions: fieldQuestions(fields) }),
  },
  laya: {
    sections: (q) => ({ state: { question: q }, questions: compactSectionQuestions() }),
    fields: (q, fields) => ({ state: { question: q }, questions: compactFieldQuestions(fields) }),
  },
};

/** the engines' stage logic: sections(ctx) and fields(ctx, keys) → { rows, ms, model, usage, confidence } */
const STAGES = {
  async systemOneSections(target, ctx) {
    const r = REQUEST[target].sections(ctx.question);
    const a = await systemOne(ctx.post, target, r.state, r.questions, { keys: ctx.keys, signal: ctx.signal });
    const rows = pickSections(a.answers).map((x) => ({ ...x, score: x.p }));
    return { rows, ms: a.ms, model: a.model, usage: a.usage, confidence: mainConfidence(a.answers) };
  },
  async systemOneFields(target, ctx, fields) {
    const r = REQUEST[target].fields(ctx.question, fields);
    const a = await systemOne(ctx.post, target, r.state, r.questions, { keys: ctx.keys, signal: ctx.signal });
    const rows = pickFields(fields, a.answers).map((x) => ({ ...x, score: x.p }));
    return { rows, ms: a.ms, model: a.model, usage: a.usage };
  },
};

const ENGINE_RUN = {
  jev: {
    sections: (ctx) => STAGES.systemOneSections("jev", ctx),
    fields: (ctx, fields) => STAGES.systemOneFields("jev", ctx, fields),
  },
  laya: {
    sections: (ctx) => STAGES.systemOneSections("laya", ctx),
    fields: (ctx, fields) => STAGES.systemOneFields("laya", ctx, fields),
  },
  keyword: {
    sections: async (ctx) => { const t0 = performance.now(); const rows = keywordSections(ctx.question, ctx.hits); return { rows, ms: performance.now() - t0 }; },
    fields: async (ctx, fields) => { const t0 = performance.now(); const rows = keywordFields(ctx.question, ctx.hits, fields); return { rows, ms: performance.now() - t0 }; },
  },
  embed: {
    async sections(ctx) {
      const t0 = performance.now();
      const [q, ...docs] = await ctx.embedder.embed([ctx.question, ...sectionDocs()]);
      return { rows: embedSections(q, docs), ms: performance.now() - t0, model: ctx.embedder.model };
    },
    async fields(ctx, fields) {
      const t0 = performance.now();
      const [q, ...docs] = await ctx.embedder.embed([ctx.question, ...fieldDocs(fields)]);
      return { rows: embedFields(q, fields, docs), ms: performance.now() - t0, model: ctx.embedder.model };
    },
  },
  llm: {
    async sections(ctx) {
      const r = await chatOnce(ctx.post, pickerSectionMessages(ctx.question), { keys: ctx.keys, signal: ctx.signal });
      return { rows: pickerSectionRows(r.text), ms: r.ms, model: r.model, usage: r.usage };
    },
    async fields(ctx, fields) {
      const r = await chatOnce(ctx.post, pickerFieldMessages(ctx.question, fields), { keys: ctx.keys, signal: ctx.signal });
      return { rows: pickerFieldRows(r.text, fields), ms: r.ms, model: r.model, usage: r.usage };
    },
  },
};

/** the key a lane is missing, or null. `local` means the proxy holds every key. */
export function missingKey(id, { local, keys }) {
  if (local) return null;
  if (!keys.enablers) return "enablers";
  const need = id === "full" ? null : engine(id).needs;
  return need && !keys[need] ? need : null;
}

/**
 * Run one question. `opts`: { question, depth, engines, post, keys, local,
 * search, embedder, emit, signal }. Resolves when every lane is done.
 */
export async function run(opts) {
  const { question, depth, engines, post, keys = {}, local = false, search, embedder, emit, signal } = opts;
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const ev = (type, data = {}) => emit({ type, t: now(), ...data });

  let s;
  try {
    s = await search(question);
  } catch (err) {
    ev("error", { message: err.message });
    ev("end");
    return;
  }
  ev("search", { index: s.index, backend: s.backend, ms: s.ms, hits: s.hits });
  if (!s.hits.length) { ev("end"); return; }

  const answer = async (lane, records) => {
    const w = weigh(records);
    ev("lane", { lane, keys: w.keys, chars: w.chars });
    const startedAt = now();
    try {
      const r = await chat(post, messages(question, records), {
        model: ANSWER_MODEL, keys, signal, cacheSalt: salt(), onDelta: (text) => ev("delta", { lane, text }),
      });
      ev("done", { lane, usage: r.usage, ttft: r.ttft, total: r.total, model: r.model, startedAt });
    } catch (err) {
      if (!(signal && signal.aborted)) ev("error", { lane, message: err.message });
    }
  };

  const laneFor = async (id) => {
    const missing = missingKey(id, { local, keys });
    const ctx = { question, hits: s.hits, post, keys, embedder, signal };
    const impl = ENGINE_RUN[id];
    try {
      if (id === "embed") {
        ev("load", { lane: id });
        await embedder.ready();
      }
      ev("engine", { lane: id });
      const t = now();
      const r1 = await impl.sections(ctx);
      ev("pick", { lane: id, stage: "sections", ...r1 });
      let keep = r1.rows.filter((x) => x.picked).map((x) => x.name);
      const tokens = [r1.usage && r1.usage.inputTokens].filter(Number.isFinite);
      if (depth === "fields") {
        const fields = fieldsIn(s.hits, keep);
        if (fields.length) {
          const r2 = await impl.fields(ctx, fields);
          ev("pick", { lane: id, stage: "fields", ...r2 });
          keep = r2.rows.filter((x) => x.picked).map((x) => x.key);
          if (r2.usage && Number.isFinite(r2.usage.inputTokens)) tokens.push(r2.usage.inputTokens);
        }
      }
      ev("picked", { lane: id, keep, ms: now() - t, engineTokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) : null });
      if (missing) { ev("skip", { lane: id, need: missing }); return; }
      await answer(id, s.hits.map((h) => strip(h, keep)));
    } catch (err) {
      if (!(signal && signal.aborted)) ev("error", { lane: id, message: err.message });
    }
  };

  const lanes = [];
  const fullMissing = missingKey("full", { local, keys });
  if (fullMissing) ev("skip", { lane: "full", need: fullMissing });
  else lanes.push(answer("full", s.hits.map(full)));
  for (const id of engines) {
    // an engine whose own call needs a key the visitor has not given does not run at all
    const need = engine(id).needs;
    if (!local && need && !keys[need]) { ev("skip", { lane: id, need }); continue; }
    lanes.push(laneFor(id));
  }
  await Promise.all(lanes);
  ev("end");
}

