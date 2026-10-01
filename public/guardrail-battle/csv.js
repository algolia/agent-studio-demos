/* ───────────────────────────────────────────────────────────────
   csv.js → window.GuardrailCsv

   The guardrail exam as a CSV, both ways, in the browser only. A file the
   reader picks is read with FileReader and parsed here; nothing is uploaded.

     message,expected,category,note

   `expected` is allowed or blocked. `category` and `note` are optional.
   Pure functions, no DOM: tests/guardrail-csv.test.js loads these bytes.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const COLUMNS = ["message", "expected", "category", "note"];
  const MAX_ROWS = 2000;
  const MAX_MESSAGE_CHARS = 4000;

  /** RFC 4180: quoted fields, doubled quotes, CRLF or LF, a leading BOM */
  function parse(text) {
    const s = String(text).replace(/^﻿/, "");
    const rows = [];
    let row = [], field = "", quoted = false, i = 0;
    while (i < s.length) {
      const c = s[i];
      if (quoted) {
        if (c === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (c === '"') { quoted = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"' && field === "") { quoted = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r" && s[i + 1] === "\n") i++;
      if (c === "\n" || c === "\r") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ""));
  }

  const quote = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  /** rows of objects → CSV text, columns in the order given */
  function toCsv(rows, columns) {
    return [columns.join(",")].concat(rows.map((r) => columns.map((c) => quote(r[c])).join(","))).join("\r\n") + "\r\n";
  }

  /**
   * Header row required, matched without regard to case or spaces. Returns
   * { cases, errors, total }: a row with a problem is reported, never guessed.
   */
  function validate(table) {
    const errors = [];
    if (!table.length) return { cases: [], errors: ["The file is empty."], total: 0 };
    const head = table[0].map((h) => h.trim().toLowerCase());
    const col = Object.fromEntries(COLUMNS.map((c) => [c, head.indexOf(c)]));
    for (const c of ["message", "expected"]) {
      if (col[c] < 0) errors.push(`Missing the "${c}" column.`);
    }
    if (errors.length) return { cases: [], errors, total: table.length - 1 };
    const body = table.slice(1);
    if (body.length > MAX_ROWS) errors.push(`Only the first ${MAX_ROWS} rows are read.`);
    const cases = [];
    body.slice(0, MAX_ROWS).forEach((r, k) => {
      const line = k + 2;
      const message = (r[col.message] || "").trim();
      const expected = (r[col.expected] || "").trim().toLowerCase();
      if (!message) { errors.push(`Row ${line}: no message.`); return; }
      if (message.length > MAX_MESSAGE_CHARS) { errors.push(`Row ${line}: message over ${MAX_MESSAGE_CHARS} characters.`); return; }
      if (expected !== "allowed" && expected !== "blocked") {
        errors.push(`Row ${line}: expected must be allowed or blocked.`);
        return;
      }
      cases.push({
        message, expected,
        category: col.category >= 0 ? (r[col.category] || "").trim() : "",
        note: col.note >= 0 ? (r[col.note] || "").trim() : "",
      });
    });
    return { cases, errors, total: body.length };
  }

  global.GuardrailCsv = { COLUMNS, MAX_ROWS, MAX_MESSAGE_CHARS, parse, toCsv, validate };
})(window);
