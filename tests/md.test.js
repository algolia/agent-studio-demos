/* md.js renders model output into a live page, so its escaping is the demo's
   only line of defence. These tests hold that line, plus enough of the happy
   path to notice if a regex refactor quietly stops rendering. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRenderMarkdown } = require("./load.js");

const render = loadRenderMarkdown();

/* md.js's promise: every tag in the output was emitted by md.js itself. So the
   check is not "no <script>" — it is that the set of tag names in the output is
   a subset of what the renderer is allowed to produce. Anything the model wrote
   comes back as escaped text, `onerror=` included: harmless as characters,
   readable to the reader, and never a tag. */
const EMITTED_TAGS = new Set([
  "p", "a", "code", "pre", "strong", "em", "del", "blockquote", "hr",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
]);

const tagsIn = (html) => [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());

test("a script tag in the source cannot become a script tag in the output", () => {
  const out = render('Try this: <script>alert("xss")</script> and <img src=x onerror=alert(1)>');
  for (const tag of tagsIn(out)) {
    assert.ok(EMITTED_TAGS.has(tag), `output carries a <${tag}> md.js never emits: ${out}`);
  }
  assert.ok(!/<script/i.test(out), `output contains a script tag: ${out}`);
  assert.ok(!/<img/i.test(out), `output contains an img tag: ${out}`);
  // the dangerous characters are gone; the words remain as words
  assert.match(out, /&lt;script&gt;/, "the literal text should still be readable");
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/, "escaped, not stripped");
});

test("markup smuggled inside markdown structure is escaped too", () => {
  const out = render(['# <script>x</script>', "", "- <b onclick=y>item</b>", "", "> <iframe></iframe>"].join("\n"));
  for (const tag of tagsIn(out)) {
    assert.ok(EMITTED_TAGS.has(tag), `output carries a <${tag}> md.js never emits: ${out}`);
  }
  assert.ok(!/<(script|b|iframe)\b/i.test(out), `raw markup survived: ${out}`);
});

test("link targets are allow-listed to http, https and mailto", () => {
  const js = render("[click me](javascript:alert(1))");
  assert.ok(!/javascript:/i.test(js), `a javascript: URL made it into an href: ${js}`);
  assert.ok(!/<a /.test(js), "a refused target should render as plain text, not a link");
  assert.match(js, /click me/, "the label is kept even when the target is refused");

  const data = render("[x](data:text/html;base64,PHNjcmlwdD4=)");
  assert.ok(!/<a /.test(data), `a data: URL was linked: ${data}`);

  const ok = render("[docs](https://www.algolia.com/doc)");
  assert.match(ok, /<a href="https:\/\/www\.algolia\.com\/doc"[^>]*>docs<\/a>/);
  assert.match(ok, /rel="noopener noreferrer"/, "external links need rel=noopener");
});

test("bold, italic and inline code render", () => {
  assert.match(render("**loud**"), /<strong>loud<\/strong>/);
  assert.match(render("_quiet_"), /<em>quiet<\/em>/);
  assert.match(render("call `render()` first"), /<code>render\(\)<\/code>/);
});

test("a fenced block keeps its contents literal", () => {
  const out = render(["```js", 'const a = "**not bold**";', "```"].join("\n"));
  assert.match(out, /<pre data-lang="js"><code>/);
  assert.ok(!/<strong>/.test(out), `markdown was applied inside a code fence: ${out}`);
  assert.match(out, /\*\*not bold\*\*/, "the asterisks should survive verbatim");
  assert.match(out, /&quot;/, "quotes inside a fence are still escaped");
});

test("headings and lists render, and a bare URL autolinks", () => {
  const out = render(["## Findings", "", "- first", "- second", "", "See https://example.com/x now"].join("\n"));
  assert.match(out, /<h4>Findings<\/h4>/, "## collapses onto h4 — the page owns h1..h3");
  assert.match(out, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
  assert.match(out, /<a href="https:\/\/example\.com\/x"/, "a bare URL should become a link");
});

test("nothing at all is a safe input", () => {
  assert.equal(render(""), "");
  assert.equal(render(null), "");
  assert.equal(render(undefined), "");
});
