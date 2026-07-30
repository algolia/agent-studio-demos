# CLAUDE.md

Public demos of the Agent Studio context APIs. Plain HTML/CSS/JS, zero
dependencies, no build step. Push to `main` deploys to Cloudflare Pages.

Three gates, run all of them locally before pushing:

```bash
npx eslint .
node --test tests/*.test.js
node scripts/check-copy.js
```

## Writing rules — CI enforces these

One question before every sentence: **could this be a visual state instead?**
Usually yes — then build it, don't write it. A state changing on screen is
understood without a caption; a caption without the state change is homework.

- Budgets: 400 visible words per page, grade 9 as a ceiling, 40 words per
  tooltip, 50 per JS string run. `check-copy.js --verbose` names offenders.
- Most copy lives in JS template literals, not HTML. The gate scans both.
- **The conversation is exempt.** Text sent to or from the model is literature,
  not page voice. Bracket model-facing prompts in JS with
  `/* check-copy: off */ … /* check-copy: on */`. Nothing else is exempt.
- Tooltips are lead line + one thought (≤40 words) + formula in the code slot.
  HTML: `data-tip` + `data-tip-h`. JS: `tip(node, body, code, { heading })`.
  One `**bold**` per plain tip, on the number or term that matters.
- Numbers lead; prose follows. Estimates say ≈. A number nobody can check is
  decoration.
- Wraps are instructed, not proofread: `text-wrap` rules live in
  shared/tokens.css; em-dashes and number–unit pairs are glued by
  `check-copy.js --fix` (`&nbsp;` in HTML, `\u00a0` in JS — run it, never hand-write them).
  A short phrase that must hold together gets `<span class="nb">` — authored,
  sparingly; CSS cannot know a phrase is one thought.
- When the gate goes red, reread the sentence — don't delete commas, don't
  widen the budget, don't exempt.

Rationale and examples: `docs/_DESIGN.md`. Read it before any copy work.

## Code rules

- The tooltip engine is duplicated in both `app.js` files — change both or
  neither. Everything under `shared/` serves both demos; test both pages.
- `shared/meter.js` is pure (cost in, view model out) and its honesty rules are
  contract: negative savings shown as negative, impossible mode never subtracts.
  `tests/meter.test.js` is the spec.
- `public/shared/config.js` is gitignored and holds real keys; tests read
  `config.example.js`. Any browser-side Algolia key must be search-only ACL.
- No frameworks, no package.json, no version-suffixed files. Improve in place;
  git is the versioning layer.
