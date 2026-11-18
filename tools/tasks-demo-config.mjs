#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   tasks-demo-config.mjs: point /tasks/query/ and /tasks/rerank/ at a
   live agent, and prove the call works before writing the config.

     node tools/tasks-demo-config.mjs [--write-config public/shared/config.js]
       [--dry-run] [--app ID] [--agent ID] [--index NAME] [--host URL]

   Defaults: the agentic-router demo agent (TDNMRH8LS3, index sephora),
   the EU host, and the app's search key from Vault:

     vault read -field=secret …/apps/TDNMRH8LS3/sephora_search_key

   SEARCH_KEY=… overrides the Vault read. Either way the key is read into
   this process only: it never reaches stdout, argv, or the log.

   Two required checks and one informational, all before a write:
     1. POST each page's task once (?cache=false) — the rewrite and a two-hit
        rerank. This is the call the browser makes, so it proves ACL, publish
        and schema at once, and it proves the rerank task did not drift into
        inventing ids.
     2. Search the index: the raw lane runs on the same key.
     3. GET the agent, best effort. A search-only key has no settings ACL, so a
        403 here is the key behaving correctly, not a failure; the task calls
        are the proof either way.

   Then the `tasks` block (host, appId, apiKey, agentId, index) replaces
   the existing one in the config file, or is appended. A --dry-run runs
   the checks and writes nothing. Production needs the same file pushed
   through the DEMO_CONFIG_JS repository variable, then a deploy:

     gh variable set DEMO_CONFIG_JS --repo algolia/agent-studio-demos \
       < public/shared/config.js

   That variable is the WHOLE file, so a local config.js that happens to
   hold fewer blocks than production would quietly delete them there.
   --from-deploy writes onto the deployed file instead: it fetches the
   live config.js, adds the tasks block to that, and refuses if the local
   file carries a block the deployed one does not (name only — no value
   is ever printed). Pass --force to write the local file regardless.
   ─────────────────────────────────────────────────────────────── */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VAULT_APP = "TDNMRH8LS3";
const DEFAULTS = {
  host: "https://agent-studio.eu.algolia.com",
  app: VAULT_APP,
  agent: "0a6e05ef-b94e-4ecd-8210-779cbd510005",
  index: "sephora",
  keyField: "sephora_search_key",
};
const TASKS = ["algolia_query_generation", "algolia_rerank"];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEPLOYED_URL = "https://agent-studio-demos.pages.dev/shared/config.js";

function parseArgs(argv) {
  const out = {
    ...DEFAULTS,
    writeConfig: path.join(repoRoot, "public/shared/config.js"),
    dryRun: false,
    fromDeploy: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--from-deploy") out.fromDeploy = true;
    else if (a === "--force") out.force = true;
    else if (a === "--write-config") out.writeConfig = path.resolve(argv[++i]);
    else if (a === "--app") out.app = argv[++i];
    else if (a === "--agent") out.agent = argv[++i];
    else if (a === "--index") out.index = argv[++i];
    else if (a === "--host") out.host = argv[++i].replace(/\/+$/, "");
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

/** The search key, in process only — env wins, else Vault. */
function readKey(cfg) {
  if (process.env.SEARCH_KEY) return process.env.SEARCH_KEY.trim();
  const secretPath = `secret/algolia/generative-ecom/conversational-ai/shared/apps/${cfg.app}/${cfg.keyField}`;
  return execFileSync("vault", ["read", "-field=secret", secretPath], { encoding: "utf8" }).trim();
}

async function call(cfg, key, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      "X-Algolia-Application-Id": cfg.app,
      "X-Algolia-API-Key": key,
      "Content-Type": "application/json",
      // Cloudflare 1010 bans anonymous signatures; the repo names itself.
      "User-Agent": "Algolia-Agent-Studio/1.0 (tasks demo config)",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(data && data.message) || ""}`.trim());
  return data;
}

/** Top-level block names of a config.js source. The file is a plain
 *  assignment, so it evaluates; only the key names are ever read out. Exported
 *  for tests: --from-deploy refuses a write that would drop a block. */
export function blockNames(source) {
  const win = {};
  new Function("window", source)(win);
  return Object.keys(win.DEMO_CONFIG || {});
}

const SECTION_START = /^([ \t]*)\/\/ tasks: begin .*$/m;
const MARKER = "// tasks: begin (tools/tasks-demo-config.mjs)";
const MARKER_END = "// tasks: end";

/** The tasks section of a config.js, replaced whole or appended as one.
 *
 *  The house convention (pii-provision, prefetch-albums-provision) is a marked
 *  assignment section after the base object, not an edit inside it: the base
 *  literal may be shorter than the file, and a hand-written block marked
 *  "(manual)" is a legal thing to find and upgrade. Exported for tests. */
export function withTasksBlock(source, fields) {
  const body = [
    MARKER,
    "window.DEMO_CONFIG.tasks = {",
    ...Object.entries(fields).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`),
    "};",
    MARKER_END,
  ].join("\n");
  const start = source.match(SECTION_START);
  if (!start) return `${source.replace(/\n*$/, "")}\n\n${body}\n`;
  const from = start.index;
  const rest = source.slice(from);
  const endLine = rest.indexOf(MARKER_END);
  if (endLine < 0) throw new Error("found a tasks section without its end marker — refusing to guess where it stops");
  const afterEnd = from + endLine + MARKER_END.length;
  const tail = source.slice(afterEnd).startsWith("\n") ? source.slice(afterEnd + 1) : source.slice(afterEnd);
  return `${source.slice(0, from)}${body}${tail}`;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const key = readKey(cfg);
  console.log(`agent ${cfg.agent} on ${cfg.host} (app ${cfg.app}, index ${cfg.index})`);

  // 1. both pages' tasks, called for real. One POST proves the ACL, the
  //    publish and the schema together, and it is the call the browser makes —
  //    reading the agent's config instead needs editSettings, which a browser
  //    key rightly lacks. Each page gets its own task proven, not inferred.
  const tasksUrl = `${cfg.host}/1/agents/${encodeURIComponent(cfg.agent)}/tasks?cache=false`;
  const t0 = Date.now();
  const rewrite = await call(cfg, key, "POST", tasksUrl, {
    task: "algolia_query_generation",
    input: { message: "glowy serum", agentContext: { facets: ["brand", "colors", "price"] } },
  });
  const states = (rewrite.output && rewrite.output.states) || [];
  console.log(`algolia_query_generation ok in ${Date.now() - t0} ms — ${states.length} state(s)`);
  if (!states.length) throw new Error("the rewrite task answered with no states");

  const pool = [
    { objectID: "check-a", name: "Ultra Glow Serum, vitamin C" },
    { objectID: "check-b", name: "Matte Velvet Lipstick" },
  ];
  const t1 = Date.now();
  const rerank = await call(cfg, key, "POST", tasksUrl, { task: "algolia_rerank", input: { query: "glow serum", hits: pool, topK: 2 } });
  const ranked = (rerank.output && rerank.output.rankedIds) || [];
  console.log(`algolia_rerank ok in ${Date.now() - t1} ms — ${ranked.length} ranked id(s)`);
  const foreign = ranked.filter((r) => !pool.some((h) => h.objectID === r.objectId));
  if (!ranked.length) throw new Error("the rerank task answered with no ids");
  if (foreign.length) throw new Error(`the rerank task invented ids: ${foreign.map((r) => r.objectId).join(", ")}`);

  // 2. the same key searches the index the raw lane shows.
  const found = await call(
    cfg,
    key,
    "POST",
    `https://${cfg.app.toLowerCase()}-dsn.algolia.net/1/indexes/${cfg.index}/query`,
    { params: "query=serum&hitsPerPage=1" },
  );
  console.log(`search ok: ${found.nbHits} hits for "serum"`);

  // 3. best effort, and only informative: reading the agent's own config needs
  //    a settings ACL the browser key does not carry, so a 403 here is the key
  //    behaving correctly. The two task calls above are the proof.
  try {
    const agent = await call(cfg, key, "GET", `${cfg.host}/1/agents/${encodeURIComponent(cfg.agent)}`);
    const have = Object.keys((agent.config && agent.config.tasks) || {});
    const missing = TASKS.filter((t) => !have.includes(t));
    console.log(`agent config tasks: ${have.join(", ") || "none"}${missing.length ? ` — missing ${missing.join(", ")}` : ""}`);
  } catch (e) {
    console.log(`agent config not readable with this key (${e.message}) — the live task calls stand`);
  }

  const fields = { host: cfg.host, appId: cfg.app, apiKey: key, agentId: cfg.agent, index: cfg.index };
  if (cfg.dryRun) {
    console.log("--dry-run: checks passed, nothing written");
    return;
  }
  // The variable replaces the whole file, so the base matters: --from-deploy
  // adds the block to what production serves today, never to a thinner local file.
  let source;
  if (cfg.fromDeploy) {
    const res = await fetch(DEPLOYED_URL, { headers: { "User-Agent": "Algolia-Agent-Studio/1.0 (tasks demo config)" } });
    if (!res.ok) throw new Error(`deployed config.js: HTTP ${res.status}`);
    source = await res.text();
    if (/DEMO_CONFIG\s*=\s*null/.test(source)) throw new Error("the deployed config is the key-less stub — run without --from-deploy");
    const have = blockNames(source);
    if (fs.existsSync(cfg.writeConfig)) {
      // `tasks` is excluded on purpose: it is the block being added, so the
      // local file having one the deployed one lacks is the point, not a loss.
      const extra = blockNames(fs.readFileSync(cfg.writeConfig, "utf8")).filter((k) => k !== "tasks" && !have.includes(k));
      if (extra.length && !cfg.force) {
        throw new Error(`the local file carries ${extra.join(", ")} the deployed one lacks — --force writes from the local file instead`);
      }
    }
    console.log(`based on the deployed config (${have.join(", ")})`);
  } else {
    source = fs.readFileSync(cfg.writeConfig, "utf8");
  }
  const next = withTasksBlock(source, fields);
  // The deploy's own check first, on the bytes about to be written: the file
  // must evaluate and hand back a tasks block with all five fields filled.
  const win = {};
  new Function("window", next)(win);
  const written = (win.DEMO_CONFIG || {}).tasks;
  const blank = Object.entries(written || {}).filter(([, v]) => !v).map(([k]) => k);
  if (!written || blank.length) throw new Error(`refusing to write: the tasks block would come back ${written ? `with ${blank.join(", ")} empty` : "missing"}`);
  fs.writeFileSync(cfg.writeConfig, next, { mode: 0o600 });
  console.log(`tasks section written to ${path.relative(repoRoot, cfg.writeConfig)}`);
  console.log("production: gh variable set DEMO_CONFIG_JS --repo algolia/agent-studio-demos < public/shared/config.js, then deploy");
}

// Only run when invoked, never when imported — the checks above hit the network.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`tasks-demo-config: ${e.message}`);
    process.exit(1);
  });
}
