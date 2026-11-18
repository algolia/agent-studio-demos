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

   Three checks, in order, all required before a write:
     1. GET the agent — its config carries the tasks the pages call.
     2. POST /tasks algolia_query_generation once (?cache=false): the key
        really carries the ACL, and the agent is published with them.
     3. Search the index: the pages show the raw lane on the same key.

   Then the `tasks` block (host, appId, apiKey, agentId, index) replaces
   the existing one in the config file, or is appended. A --dry-run runs
   the checks and writes nothing. Production needs the same file pushed
   through the DEMO_CONFIG_JS repository variable, then a deploy:

     gh variable set DEMO_CONFIG_JS --repo algolia/agent-studio-demos \
       < public/shared/config.js
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

function parseArgs(argv) {
  const out = { ...DEFAULTS, writeConfig: path.join(repoRoot, "public/shared/config.js"), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
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

/** Replace the tasks block, or append it before the closing `};`. Exported for
 *  tests — the rest of this file reaches the network and Vault. */
export function withTasksBlock(source, block) {
  const start = source.search(/^ {2}tasks:\s*\{/m);
  if (start >= 0) {
    let depth = 0;
    let end = -1;
    for (let i = source.indexOf("{", start); i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}" && (depth -= 1) === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) throw new Error("found a tasks block but could not find its end");
    // The old block's trailing comma sits past its brace; the new one carries its own.
    const tail = source.slice(end).startsWith(",") ? source.slice(end + 1) : source.slice(end);
    return source.slice(0, start) + block + tail;
  }
  const close = source.lastIndexOf("};");
  if (close < 0) throw new Error("config.js has no closing }; — refusing to guess");
  return `${source.slice(0, close)}${block}\n${source.slice(close)}`;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const key = readKey(cfg);
  console.log(`agent ${cfg.agent} on ${cfg.host} (app ${cfg.app}, index ${cfg.index})`);

  // 1. the agent carries the task configs.
  const agent = await call(cfg, key, "GET", `${cfg.host}/1/agents/${cfg.agent}`);
  const have = Object.keys((agent.config && agent.config.tasks) || {});
  const missing = TASKS.filter((t) => !have.includes(t));
  console.log(`config tasks: ${have.join(", ") || "none"}${missing.length ? ` — missing ${missing.join(", ")}` : ""}`);
  if (missing.length) throw new Error("apply the task configs first (prototype/agentic-router/apply_tasks.py), then publish");

  // 2. one real task call: the ACL, the publish, and the schema, at once.
  const t0 = Date.now();
  const run = await call(cfg, key, "POST", `${cfg.host}/1/agents/${cfg.agent}/tasks?cache=false`, {
    task: "algolia_query_generation",
    input: { message: "glowy serum", agentContext: { facets: ["brand", "colors", "price"] } },
  });
  const states = (run.output && run.output.states) || [];
  console.log(`query rewrite ok in ${Date.now() - t0} ms — ${states.length} state(s)`);
  if (!states.length) throw new Error("the task answered with no states");

  // 3. the same key searches the index the raw lane shows.
  const found = await call(
    cfg,
    key,
    "POST",
    `https://${cfg.app.toLowerCase()}-dsn.algolia.net/1/indexes/${cfg.index}/query`,
    { params: "query=serum&hitsPerPage=1" },
  );
  console.log(`search ok: ${found.nbHits} hits for "serum"`);

  const block = [
    "  tasks: {",
    `    host: ${JSON.stringify(cfg.host)},`,
    `    appId: ${JSON.stringify(cfg.app)},`,
    `    apiKey: ${JSON.stringify(key)},`,
    `    agentId: ${JSON.stringify(cfg.agent)},`,
    `    index: ${JSON.stringify(cfg.index)},`,
    "  },"].join("\n");
  if (cfg.dryRun) {
    console.log("--dry-run: checks passed, nothing written");
    return;
  }
  const source = fs.readFileSync(cfg.writeConfig, "utf8");
  const next = withTasksBlock(source, block);
  fs.writeFileSync(cfg.writeConfig, next, { mode: 0o600 });
  new Function(next.replace("window.DEMO_CONFIG", "const DEMO_CONFIG")); // the deploy's own parse check
  console.log(`tasks block written to ${path.relative(repoRoot, cfg.writeConfig)}`);
  console.log("production: gh variable set DEMO_CONFIG_JS --repo algolia/agent-studio-demos < public/shared/config.js, then deploy");
}

// Only run when invoked, never when imported — the checks above hit the network.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`tasks-demo-config: ${e.message}`);
    process.exit(1);
  });
}
