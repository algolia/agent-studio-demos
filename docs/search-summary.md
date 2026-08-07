# Search summary

The Search summary demo combines React InstantSearch with two published Agent
Studio agents:

1. InstantSearch retrieves the current results from the configured index.
2. The summary agent receives a compact representation of those hits and writes
   the inline overview and prompt suggestions. When the supplied hits directly
   answer the question, it uses that evidence without searching again. When the
   hit list is empty or the supplied evidence is incomplete, off-topic, or
   insufficient, it uses its configured Algolia Search tool against the same
   index before answering. If that first search returns no useful hits, the
   agent makes one separate broader search with related query variations. The
   inline card renders any fallback hits as a
   compact result carousel and labels them as AI-retrieved evidence, so they
   remain distinguishable from the direct InstantSearch results below. The
   follow-up side panel keeps its larger carousel.
3. Selecting a suggestion opens the InstantSearch Chat side panel. The follow-up
   agent receives only the question and uses its own Algolia search tool to
   retrieve fresh evidence.

## Configuration

Add this block to `public/shared/config.js`:

```js
summaryCard: {
  indexName: "support_algolia_rag",
  summaryAgentId: "YOUR_SUMMARY_AGENT_ID",
  followupAgentId: "YOUR_FOLLOWUP_AGENT_ID",
},
```

Use the existing top-level `appId`, `apiKey`, and `host` values. The browser key
must be search-only. Both agents should be published and configured with prompt
suggestions enabled. The summary agent should have an Algolia search tool bound
to the same index and be instructed to require direct answers from supplied hits:
keyword overlap is not enough, and definition questions require an explicit
definition or description. It should search when the supplied evidence is
missing or insufficient, then make one separate broader search if the first
search returns no useful hits. The follow-up agent should also have an Algolia
search tool bound to the same index.

## Build and run

```bash
npm ci
npm run build:summary-card
python3 -m http.server 8766 --bind 127.0.0.1 --directory public
```

Open <http://127.0.0.1:8766/summary-card/>. The source is under
`demos/summary-card/`; generated files under `public/summary-card/` are ignored.
