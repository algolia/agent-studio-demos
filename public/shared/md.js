/* ───────────────────────────────────────────────────────────────
   md.js — the small part of Markdown a chat answer actually uses.

   Vendored rather than pulled from a CDN: this page already asks you to trust
   it with an API key, and a third-party script tag is one more thing that could
   change under it. No dependencies, no build step, ~150 lines.

   Safety model, in order and not negotiable:
     1. the whole source is HTML-escaped first, so nothing the model wrote can
        become markup;
     2. Markdown structure is then rendered *on top of* the escaped text, which
        means every tag in the output was emitted by this file;
     3. link and image targets are allow-listed to http, https and mailto.

   Supported: ATX headings, fenced and indented-free code, inline code, bold,
   italic, strikethrough, links, autolinks, blockquotes, horizontal rules,
   ordered and unordered lists with one level of nesting, paragraphs.
   Deliberately absent: tables, raw HTML, reference links, footnotes.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** only schemes a demo page has any business following */
  function safeUrl(raw) {
    const url = String(raw).trim().replace(/&amp;/g, "&");
    if (/^(https?:\/\/|mailto:)/i.test(url)) return escapeHtml(url);
    if (/^[/#]/.test(url)) return escapeHtml(url);
    return null;
  }

  /**
   * Inline spans over already-escaped text. Code spans are lifted out first and
   * put back last, so a backticked `**star**` stays literal.
   */
  function inline(text) {
    // NUL-delimited placeholders: no answer text contains one, so putting the
    // code spans back cannot collide with the model's own numbers
    const codes = [];
    let out = text.replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });

    out = out
      // [label](target)
      .replace(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, href) => {
        const url = safeUrl(href);
        return url
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label || url}</a>`
          : label || m;
      })
      // bare http(s) URL, not already inside an href
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (m, pre, href) => {
        const url = safeUrl(href);
        return url ? `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${href}</a>` : m;
      })
      .replace(/\*\*\*([^\s*][^*]*?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^\s*][^*]*?)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^\s_][^_]*?)__/g, "<strong>$1</strong>")
      .replace(/(^|[^\w*])\*([^\s*][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^\w_])_([^\s_][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");

    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  }

  const BULLET = /^(\s*)[-*+]\s+(.*)$/;
  const NUMBER = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;

  function render(src) {
    const lines = escapeHtml(String(src == null ? "" : src)).split(/\r?\n/);
    const html = [];
    // open list contexts: { tag, indent }
    const lists = [];
    let para = [];
    let quote = [];
    let fence = null;   // accumulated code lines while inside a fence
    let fenceLang = "";
    let blank = false;  // a blank line ends lazy continuation of a list item

    const flushPara = () => {
      if (!para.length) return;
      html.push(`<p>${inline(para.join(" ").trim())}</p>`);
      para = [];
    };
    const flushQuote = () => {
      if (!quote.length) return;
      html.push(`<blockquote>${inline(quote.join(" ").trim())}</blockquote>`);
      quote = [];
    };
    /** a sublist belongs inside its parent <li>, so closing one may owe a </li> */
    const popList = () => {
      const l = lists.pop();
      html.push(`</${l.tag}>${l.inLi ? "</li>" : ""}`);
    };
    const openList = (tag, indent) => {
      let inLi = false;
      const last = html.length - 1;
      if (lists.length && last >= 0 && /<\/li>$/.test(html[last])) {
        html[last] = html[last].replace(/<\/li>$/, "");
        inLi = true;
      }
      lists.push({ tag, indent, inLi });
      html.push(`<${tag}>`);
    };
    const closeLists = (toIndent) => {
      while (lists.length && lists[lists.length - 1].indent >= toIndent) popList();
    };
    const closeAll = () => { flushPara(); flushQuote(); closeLists(0); };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");

      /* fenced code — everything inside is literal */
      const fenceMark = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
      if (fenceMark) {
        if (fence === null) {
          closeAll();
          fence = [];
          fenceLang = fenceMark[2] || "";
        } else {
          html.push(`<pre${fenceLang ? ` data-lang="${fenceLang}"` : ""}><code>${fence.join("\n")}</code></pre>`);
          fence = null;
          fenceLang = "";
        }
        continue;
      }
      if (fence !== null) { fence.push(line); continue; }

      if (!line.trim()) { flushPara(); flushQuote(); blank = true; continue; }
      const wasBlank = blank;
      blank = false;

      /* horizontal rule */
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeAll();
        html.push("<hr>");
        continue;
      }

      /* ATX heading */
      const head = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (head) {
        closeAll();
        // The page's own h1..h3 are taken, so a bubble heading starts at h4. Models
        // habitually open at ## or ###, so the first three depths collapse onto h4
        // rather than burying the answer's main heading at h6.
        const level = Math.min(Math.max(head[1].length - 2, 1) + 3, 6);
        html.push(`<h${level}>${inline(head[2].trim())}</h${level}>`);
        continue;
      }

      /* blockquote */
      const bq = line.match(/^\s*&gt;\s?(.*)$/);
      if (bq) {
        flushPara();
        closeLists(0);
        quote.push(bq[1]);
        continue;
      }
      flushQuote();

      /* list item, ordered or not */
      const bullet = line.match(BULLET);
      const number = bullet ? null : line.match(NUMBER);
      if (bullet || number) {
        flushPara();
        const indent = (bullet ? bullet[1] : number[1]).replace(/\t/g, "  ").length;
        const tag = bullet ? "ul" : "ol";
        const body = bullet ? bullet[2] : number[3];
        // a deeper indent nests; a shallower one closes back out
        while (lists.length && lists[lists.length - 1].indent > indent) popList();
        const top = lists[lists.length - 1];
        if (!top || top.indent < indent) openList(tag, indent);
        else if (top.tag !== tag) { popList(); openList(tag, indent); }
        html.push(`<li>${inline(body)}</li>`);
        continue;
      }

      /* a plain line continues the paragraph, or — unless a blank line broke the
         run — the last list item */
      if (lists.length && !wasBlank) {
        const last = html.length - 1;
        if (/^<li>/.test(html[last])) {
          html[last] = html[last].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
          continue;
        }
      }
      closeLists(0);
      para.push(line.trim());
    }

    if (fence !== null) {
      html.push(`<pre${fenceLang ? ` data-lang="${fenceLang}"` : ""}><code>${fence.join("\n")}</code></pre>`);
    }
    closeAll();
    return html.join("");
  }

  global.renderMarkdown = render;
})(window);
