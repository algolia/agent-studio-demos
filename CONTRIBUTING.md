# Contributing

Small demos, small rules. There is no build step and no dependency to install — a
clone, a config file and a static server are the whole setup.

## Run it locally

```bash
# 1 · credentials — copy the template, then fill in your own values
cp public/shared/config.example.js public/shared/config.js
$EDITOR public/shared/config.js

# 2 · serve the deployable root
python3 -m http.server 8766 --directory public

# 3 · open http://127.0.0.1:8766/
```

Serve over `http://`, never open the file over `file://` — the demos load their
config and shared modules with relative paths, which a `file://` origin blocks.

`config.example.js` documents every field. Each demo degrades honestly without a
config: it renders a notice telling the reader to create the file rather than
failing silently.

## Never commit config.js

`public/shared/config.js` holds credentials and is gitignored at every depth. The
same goes for anything else that carries a key: no key in a source file, in a
screenshot, in a pasted log, or in a commit message.

These pages call the Agent Studio API straight from the browser so the wire log
can show every request, which means whatever key you configure is readable by
anyone who opens devtools. Use a key scoped to exactly what the demo needs, and
put a backend in front of it before shipping anything like this.

## The two gates

CI runs exactly these, and so should you before pushing:

```bash
npx eslint public/ tests/ eslint.config.js   # flat config, zero dependencies
node --test tests/*.test.js                  # node:test, no framework
```

Both are green on a clean checkout with no `config.js` present — the tests read
`config.example.js`, and eslint ignores the real config. If a gate passes for you
and fails in CI, the likeliest cause is something in your working copy that is not
in the repo.

`eslint.config.js` writes its rules out by name instead of extending
`eslint:recommended`, because `@eslint/js` is not resolvable when eslint arrives
through `npx` with no local `node_modules`. Add globals to the list there rather
than sprinkling `/* global */` comments.

## Adding a demo

1. `mkdir public/<demo-slug>` and write an `index.html` that links
   `../shared/tokens.css` first, then its own `style.css`.
2. Reuse `../shared/md.js` and `../shared/config.js` rather than vendoring copies.
3. A demo's stylesheet never redeclares a token from `tokens.css`.
4. Add a card to `public/index.html`: pitch, status, and the endpoints it exercises.

## Adding a config field

Give it a default in the demo's `app.js` so an older `config.js` keeps working,
document it in `config.example.js`, and — if the deployed site needs it — remember
that production reads the whole file from the `DEMO_CONFIG_JS` repository
variable, so that variable has to be refreshed too:

```bash
gh variable set DEMO_CONFIG_JS --repo algolia/agent-studio-demos \
  < public/shared/config.js
```

## PR flow

1. Branch off `main`.
2. Run both gates locally.
3. Open a PR — the template asks for what/why, screenshots for anything visual,
   and the checklist above.
4. CI runs lint and tests on the PR. A merge to `main` deploys to
   <https://agent-studio-demos.pages.dev/> on its own.

## Unstable endpoints

The context APIs these demos use (`/1/unstable/context/trim`,
`/1/unstable/context/compact`) are unstable and can change without notice. When
one moves, fixing the demo is the fix — there is no compatibility layer to write.
