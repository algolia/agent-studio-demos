#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────
   demo-config.mjs: write one block of DEMO_CONFIG onto an existing config.js,
   field by field, into a new file. For updating the deployed variable
   without ever echoing a value.

     node tools/demo-config.mjs --block default --from <deployed config.js>
       --out <new file> [--fields <json file> | --copy-from <block>]

   --from       the file to start from (the deployed copy, saved locally)
   --out        where the merged file goes (chmod 600; never the --from file,
                never an existing file unless --overwrite)
   --fields     a JSON file of {field: value} merged INTO the block
   --copy-from  fill the block from another block of --from (default from tasks)
   Existing fields of the block survive unless the new source sets them.
   Prints block and field NAMES only, never a value.
   ─────────────────────────────────────────────────────────────── */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evaluate = (source) => {
  const win = {};
  new Function("window", source)(win);
  return win.DEMO_CONFIG || {};
};

/** `source` with window.DEMO_CONFIG.<name> set to `fields`: a marked section, replaced whole when it exists */
export function withBlock(source, name, fields) {
  const start = `// ${name}: begin`;
  const end = `// ${name}: end`;
  const body = [`${start} (tools/demo-config.mjs)`, `window.DEMO_CONFIG.${name} = {`,
    ...Object.entries(fields).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`), "};", end].join("\n");
  const from = source.search(new RegExp(`^[ \\t]*${start}.*$`, "m"));
  if (from < 0) return `${source.replace(/\n*$/, "")}\n\n${body}\n`;
  const stop = source.indexOf(end, from);
  if (stop < 0) throw new Error(`a ${name} section without its end marker: refusing to guess where it stops`);
  return `${source.slice(0, from)}${body}${source.slice(stop + end.length).replace(/^\n/, "\n")}`.replace(/\n*$/, "\n");
}

/** the block's merged fields, and the names that came from the new source */
export function mergeBlock(config, name, incoming) {
  const old = config[name] && typeof config[name] === "object" ? config[name] : {};
  const fields = { ...old, ...incoming };
  const blank = Object.keys(fields).filter((k) => fields[k] === "" || fields[k] == null);
  if (blank.length) throw new Error(`refusing to write: ${name} would have ${blank.join(", ")} empty`);
  return fields;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--overwrite") out.overwrite = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function main() {
  const a = args(process.argv.slice(2));
  if (!a.block || !a.from || !a.out || (!a.fields && !a["copy-from"])) {
    throw new Error("usage: --block <name> --from <file> --out <file> (--fields <json> | --copy-from <block>)");
  }
  const [from, out] = [path.resolve(a.from), path.resolve(a.out)];
  if (from === out) throw new Error("--out must not be the --from file");
  if (fs.existsSync(out) && !a.overwrite) throw new Error("--out exists; pass --overwrite to replace it");
  const source = fs.readFileSync(from, "utf8");
  const config = evaluate(source);
  let incoming;
  if (a.fields) incoming = JSON.parse(fs.readFileSync(path.resolve(a.fields), "utf8"));
  else {
    incoming = config[a["copy-from"]];
    if (!incoming || typeof incoming !== "object") throw new Error(`--from has no ${a["copy-from"]} block`);
  }
  const fields = mergeBlock(config, a.block, incoming);
  const next = withBlock(source, a.block, fields);
  const check = evaluate(next);
  if (Object.keys(fields).some((k) => check[a.block][k] !== fields[k])) throw new Error("the merged file does not read back as written");
  const lost = Object.keys(config).filter((k) => k !== a.block && !(k in check));
  if (lost.length) throw new Error(`refusing to write: it would drop ${lost.join(", ")}`);
  fs.writeFileSync(out, next, { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.log(`${a.block}: ${Object.keys(fields).join(", ")}`);
  console.log(`blocks kept: ${Object.keys(check).join(", ")}`);
  console.log(`written to ${out} (mode 600); values not printed`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`demo-config: ${e.message}`);
    process.exit(1);
  }
}
