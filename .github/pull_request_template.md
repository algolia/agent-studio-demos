## What

<!-- One or two lines. What does this change? -->

## Why

<!-- What was wrong, missing, or newly possible. Link an issue if there is one. -->

## Screenshots

<!-- Anything that changes the UI needs a before/after. Both themes if the change
     touches colour, spacing, or tokens — the demos ship light and dark. -->

## Checklist

- [ ] Ran it locally: `python3 -m http.server 8766 --directory public` and clicked through the affected demo
- [ ] If the React demo changed: ran `npm ci && npm run build:summary-card`
- [ ] No credentials committed — `public/shared/config.js` is still untracked, no key pasted into a source file, screenshot, or log
- [ ] `npx eslint .` passes
- [ ] `node --test tests/*.test.js` passes
- [ ] Touched a shared module (`tokens.css`, `md.js`)? Checked the other demos still render
- [ ] Added or changed a config field? `config.example.js` documents it, and it has a default in `app.js` so an older config keeps working
