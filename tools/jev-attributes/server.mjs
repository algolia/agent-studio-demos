#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   server.mjs — the jev-attributes demo: static files plus a tiny proxy.

     node tools/jev-attributes/server.mjs            # http://127.0.0.1:8795/jev-attributes/
     PORT=8800 node tools/jev-attributes/server.mjs

   The browser never holds a key. It posts a question to /api/run and reads
   one server-sent-events stream back, in this order:

     search   the records Algolia returned (names only)
     lane     full lane starts at once, on the whole records
     jev      Jev's P(yes) per section (and per field, at depth "fields")
     lane     filtered lane starts, on the stripped records
     delta    answer text, per lane, as it streams
     done     per lane: the API's own token usage, first token, total
     end

   Both lanes get the same hits, the same system prompt and the same model;
   the only difference is which attributes the records keep. Times are
   milliseconds since the request arrived.

   Keys: tools/jev-attributes/keys.mjs (Algolia, Jev) and the maintainer's
   Vault login (Enablers). None is ever written to a response or a log.
   ─────────────────────────────────────────────────────────────── */

import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, describe } from "./keys.mjs";
import { search } from "./algolia.mjs";
import { ask, JEV_MODEL } from "./jev.mjs";
import { complete, LLM_MODEL } from "./llm.mjs";
import {
  sectionQuestions, fieldQuestions, pickSections, pickFields, fieldsIn, strip, full, weigh, messages,
} from "../../public/jev-attributes/attrs.mjs";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const PORT = Number(process.env.PORT || 8795);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_QUESTION = 300;
const MAX_BODY = 4096;

const algolia = load("algolia");
const jev = load("jev");
const searchKeys = { app: algolia.ESCI_APP, key: algolia.ESCI_READ };

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon",
};

/** public/ only, never a config file: this server is not where keys are served from */
function serveStatic(req, res) {
  const u = new URL(req.url, "http://x");
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || /(^|\/)config\.js$/.test(rel)) return send(res, 404, "not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!err && st.isDirectory()) { res.writeHead(301, { Location: `${u.pathname}/` }); return res.end(); }
      return send(res, 404, "not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** one lane: build its prompt, stream it, report the API's numbers */
async function runLane(emit, lane, question, records, startedAt, signal) {
  const w = weigh(records);
  emit("lane", { lane, phase: "start", t: startedAt(), keys: w.keys, chars: w.chars });
  const t0 = startedAt();
  try {
    const r = await complete(messages(question, records), (text) => emit("delta", { lane, text }), { signal, cacheSalt: randomUUID() });
    emit("done", { lane, usage: r.usage, ttft: r.ttft, total: r.total, model: r.model, startedAt: t0 });
  } catch (err) {
    emit("error", { lane, message: err.message });
  }
}

async function run(req, res) {
  let input;
  try { input = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { error: "bad JSON" }, "application/json"); }
  const question = String((input && input.question) || "").trim().slice(0, MAX_QUESTION);
  const depth = input && input.depth === "fields" ? "fields" : "sections";
  if (!question) return send(res, 400, { error: "empty question" }, "application/json");

  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const ctl = new AbortController();
  res.on("close", () => ctl.abort(new Error("client went away")));
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const emit = (type, data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, t: now(), ...data })}\n\n`); };

  try {
    const s = await search(searchKeys, question);
    emit("search", { index: s.index, backend: s.backend, ms: s.ms, hits: s.hits.map((h) => ({ objectID: h.objectID, name: h.name })) });
    if (!s.hits.length) { emit("end", {}); return res.end(); }

    const fullLane = runLane(emit, "full", question, s.hits.map(full), now, ctl.signal);

    const filteredLane = (async () => {
      const r1 = await ask(jev.JEV_API_KEY, question, sectionQuestions());
      const sections = pickSections(r1.answers);
      emit("jev", { stage: "sections", ms: r1.ms, model: r1.model, usage: r1.usage, rows: sections });
      let keep = sections.filter((x) => x.picked).map((x) => x.name);
      let jevMs = r1.ms;
      if (depth === "fields") {
        const fields = fieldsIn(s.hits, keep);
        const r2 = await ask(jev.JEV_API_KEY, question, fieldQuestions(fields));
        const rows = pickFields(fields, r2.answers);
        emit("jev", { stage: "fields", ms: r2.ms, model: r2.model, usage: r2.usage, rows });
        keep = rows.filter((x) => x.picked).map((x) => x.key);
        jevMs += r2.ms;
      }
      emit("jevDone", { ms: jevMs });
      await runLane(emit, "filtered", question, s.hits.map((h) => strip(h, keep)), now, ctl.signal);
    })().catch((err) => emit("error", { lane: "filtered", message: err.message }));

    await Promise.all([fullLane, filteredLane]);
  } catch (err) {
    emit("error", { message: err.message });
  }
  emit("end", {});
  res.end();
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/run" && req.method === "POST") return void run(req, res);
  if (u.pathname === "/api/status") {
    return send(res, 200, {
      jev: { model: JEV_MODEL, ready: Boolean(jev.JEV_API_KEY) },
      llm: { model: LLM_MODEL },
      search: { ready: Boolean(searchKeys.app && searchKeys.key) },
    }, "application/json");
  }
  if (u.pathname === "/") { res.writeHead(302, { Location: "/jev-attributes/" }); return res.end(); }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`jev-attributes on http://${HOST}:${PORT}/jev-attributes/ (pid ${process.pid})`);
  console.log(`keys: ${describe(algolia)}, ${describe(jev)}; LLM ${LLM_MODEL} via Vault`);
});
