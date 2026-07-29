# Agent Studio public demos

Small, self-contained single-page demos of the [Algolia Agent Studio](https://www.algolia.com/doc/guides/algolia-ai/agent-studio) context APIs. No build step, no framework, no bundler — every demo is plain HTML, CSS and JavaScript served as static files.

Deployed at `https://agent-studio-demos.pages.dev/`, one demo per path.

| Demo | Path | Status |
| --- | --- | --- |
| Chat with a book | `/chat-with-book/` | Live |
| Infinite conversation | `/infinite-conversation/` | Coming soon (stub page) |

## Layout

```text
public/                     the deployable root — this is what Cloudflare Pages serves
  index.html                landing page, one card per demo
  shared/
    tokens.css              the design language: colors, fonts, spacing, base primitives
    md.js                   vendored sanitizing markdown renderer (window.renderMarkdown)
    config.example.js       template for local credentials — copy it, never edit it in place
    config.js               your real credentials (gitignored, never committed)
  chat-with-book/           index.html + app.js + style.css
  infinite-conversation/    index.html (stub)
```

Each demo links `../shared/tokens.css` first, then its own `style.css`. A demo's stylesheet never redeclares a token; the landing page uses nothing but `tokens.css`.

## Run it locally

```bash
# 1 · credentials — copy the template, then fill in your own values
cp public/shared/config.example.js public/shared/config.js
$EDITOR public/shared/config.js

# 2 · serve the deployable root (any static server works)
python3 -m http.server 8766 --bind 127.0.0.1 --directory public

# 3 · open it
# http://127.0.0.1:8766/
```

Open a file over `http://`, not `file://` — the demos load their config and shared modules with relative paths, which a `file://` origin blocks.

## How config works

`public/shared/config.js` defines a single global, `window.DEMO_CONFIG`, read once at startup. It carries:

- **`host`, `appId`, `apiKey`** — which Agent Studio deployment to call and with what credentials.
- **`models`** — the entries offered in the model picker: an agent id, a provider id, the model name, its context window, and a per-million-token price used by the cost meter.
- **`budgets`, `defaultBudget`, `compactAtRatio`, `keepLastMessages`** — the working budget the meter fills against, and when auto-compaction fires.
- Optional tuning for hierarchical folding — chunk size, fold depth, unfold limits. Everything has a default in `app.js`, so an older config keeps working.

`config.example.js` documents every field. It is committed; `config.js` is in `.gitignore` at every depth and must never be committed.

**These pages call the API directly from the browser** so the wire log can show you every request. That means the key is visible to anyone who opens devtools. Use a key scoped to exactly what the demo needs, and put a backend in front of it before shipping anything like this.

## Deploy to Cloudflare Pages

The site is static — `public/` is the build output, and there is no build command.

```bash
wrangler pages deploy public/
```

Pages project settings:

- **Build command** — none
- **Build output directory** — `public`
- **Root directory** — repository root

`public/shared/config.js` is gitignored, so it is not in the repo and will not appear in a Git-triggered build. A demo that loads without it does not break — it renders a short notice telling the reader to create the file — but it also does not demo anything, so a Git-triggered build alone will not give you a working public site.

Pick one of these instead:

- **Deploy from a working copy** (works today): `wrangler pages deploy public/` with your `config.js` in place. The file is uploaded even though it is untracked.
- **Generate it in a build step** from Cloudflare Pages environment variables, writing `public/shared/config.js` before the upload.
- **Commit a deploy-only config** under a path of its own, with a key scoped to nothing but these demos, and point the demos at it.

Whichever you choose, the key ends up readable in the browser. Scope it accordingly.

## Adding a demo

1. `mkdir public/<demo-slug>` and write an `index.html` that links `../shared/tokens.css`.
2. Reuse `../shared/md.js` and `../shared/config.js` rather than vendoring copies.
3. Add a card to `public/index.html` — pitch, status, and the endpoints it exercises.

## Unstable endpoints

The context APIs these demos use (`/1/unstable/context/trim`, `/1/unstable/context/compact`) are unstable and can change without notice.
