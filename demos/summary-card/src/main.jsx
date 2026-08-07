import React from "react";
import { createRoot } from "react-dom/client";
import { liteClient as algoliasearch } from "algoliasearch/lite";
import {
  Configure,
  Chat,
  ChatInlineLayout,
  ChatSidePanelLayout,
  ChatTrigger,
  Highlight,
  Hits,
  InstantSearch,
  Pagination,
  SearchBox,
  Snippet,
  Stats,
  useInstantSearch,
  useSearchBox,
} from "react-instantsearch";
import "instantsearch.css/components/chat.css";
import "./styles.css";

const runtimeConfig = typeof window !== "undefined" ? window.DEMO_CONFIG || {} : {};
const summaryConfig = runtimeConfig.summaryCard || {};
const applicationId = summaryConfig.appId || runtimeConfig.appId || "";
const searchApiKey = summaryConfig.apiKey || runtimeConfig.apiKey || "";
const indexName = summaryConfig.indexName || "support_algolia_rag";
const agentId = summaryConfig.summaryAgentId || "";
const chatAgentId = summaryConfig.followupAgentId || "";

// The client is intentionally created once, outside React, so InstantSearch can preserve its cache.
const searchClient = algoliasearch(applicationId || "missing-app-id", searchApiKey || "missing-api-key");

const demoQueries = [
  "How are refinement operations counted?",
  "What is Agent Studio?",
  "How can I improve search relevance?",
];
const SEARCH_DEBOUNCE_MS = 500;
const MAX_SUMMARY_HITS = 8;

function App() {
  const isConfigured = Boolean(applicationId && searchApiKey && agentId && chatAgentId);
  const followupChatRef = React.useRef(null);
  const [followupError, setFollowupError] = React.useState("");

  const openFollowupChat = React.useCallback((question) => {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;

    if (!chatAgentId || !followupChatRef.current) {
      setFollowupError("Follow-up Chat is not available. Check summaryCard.followupAgentId in public/shared/config.js.");
      return;
    }

    setFollowupError("");
    followupChatRef.current.setOpen(true);
    followupChatRef.current.sendMessage({ text: trimmedQuestion });
  }, []);

  return (
    <div className="app-shell">
      <header className="masthead">
        <div className="brand-mark" aria-label="Algolia summary card demo">
          <span className="brand-mark__dot" />
          <span>ALGOLIA / FIELD NOTE 01</span>
        </div>
        <div className="masthead__meta">Agent Studio × InstantSearch</div>
      </header>

      <main className="page-frame">
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">A search result, with a point of view</p>
          <h1 id="page-title">Make the result<br />say more.</h1>
          <p className="intro__lede">
            Search the Algolia Support Center, then let a small Agent Studio agent turn the returned evidence into a useful answer.
          </p>
        </section>

        {isConfigured ? (
          <>
            <InstantSearch
              searchClient={searchClient}
              indexName={indexName}
              routing
              insights
            >
              <Configure
                hitsPerPage={8}
                attributesToHighlight={["page_title", "question", "content"]}
                attributesToSnippet={["content:34"]}
              />

              <section className="search-panel" aria-label="Search support content">
                <div className="search-panel__topline">
                  <span>Ask the index</span>
                  <span className="search-panel__hint">Searches after you pause typing</span>
                </div>
                <DebouncedSearchBox />
                <QueryPrompts />
              </section>

              <SummaryCard
                agentId={agentId}
                onFollowup={openFollowupChat}
                followupError={followupError}
              />

              <section className="results-heading" aria-label="Search result summary">
                <div>
                  <p className="eyebrow">Retrieved evidence</p>
                  <Stats />
                </div>
                <SearchStatus />
              </section>

              <Results />
            </InstantSearch>

            {/* Keep follow-up Chat in a result-free InstantSearch instance. The
                user turn contains only the question; the agent retrieves evidence
                with its own Agent Studio search tool. */}
            <InstantSearch searchClient={searchClient} indexName={indexName}>
              <Chat
                ref={followupChatRef}
                agentId={chatAgentId}
                classNames={{ root: "followup-chat" }}
                persistence={false}
                feedback
                requiresSearch={false}
                title="Support follow-up"
                itemComponent={ChatResultItem}
                layoutComponent={ChatSidePanelLayout}
              />
              <ChatTrigger floating />
            </InstantSearch>
          </>
        ) : (
          <aside className="setup-note" role="status">
            <strong>One last connection step.</strong> Add a <code>summaryCard</code> block to <code>public/shared/config.js</code> with the search index and both published Agent Studio IDs.
          </aside>
        )}
      </main>

      <footer className="footer-note">
        <span>One search. Two readings.</span>
        <span>Results stay the source of truth.</span>
      </footer>
    </div>
  );
}

function DebouncedSearchBox() {
  const timeoutRef = React.useRef(null);
  const queryHook = React.useCallback((query, search) => {
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      search(query);
      timeoutRef.current = null;
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  React.useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  return (
    <SearchBox
      placeholder="How does Algolia handle…"
      // Algolia documents queryHook as the supported debounce point for SearchBox.
      // https://www.algolia.com/doc/api-reference/widgets/search-box/react
      queryHook={queryHook}
      searchAsYouType
      submitIconComponent={SearchIcon}
      resetIconComponent={ResetIcon}
    />
  );
}

function QueryPrompts() {
  // `useSearchBox().refine` is the supported React InstantSearch API for
  // setting a query and starting a search from a custom control.
  // https://www.algolia.com/doc/api-reference/widgets/search-box/react
  const { refine } = useSearchBox();
  const selectPrompt = React.useCallback((query) => refine(query), [refine]);

  return (
    <div className="query-prompts" aria-label="Example searches">
      {demoQueries.map((query) => (
        <button
          className="query-prompts__item"
          key={query}
          type="button"
          onClick={() => selectPrompt(query)}
        >
          {query}
        </button>
      ))}
    </div>
  );
}

function SummaryCard({ agentId: configuredAgentId, onFollowup, followupError }) {
  // `useInstantSearch` exposes completed `results`, `indexUiState`, and `status`.
  // Source: https://www.algolia.com/doc/api-reference/widgets/use-instantsearch/react
  const { indexUiState, results, status } = useInstantSearch();
  const query = indexUiState.query?.trim() || "";
  const hits = results?.hits || [];
  const questionLike = /\?|\b(what|how|why|which|when|where|can|could|should|does|do|is|are|best|explain|difference|help)\b/i.test(query)
    || query.split(/\s+/).length >= 3;

  const showCard = Boolean(query && questionLike);

  if (!showCard) {
    return (
      <section className="summary-card summary-card--empty" aria-label="AI result overview">
        <div className="summary-card__rail" />
        <div>
          <p className="summary-card__label">AI result overview</p>
          <p className="summary-card__placeholder">Ask a question to see what the returned results mean together.</p>
        </div>
      </section>
    );
  }

  if (!configuredAgentId) {
    return (
      <section className="summary-card summary-card--empty" aria-label="AI result overview">
        <div className="summary-card__rail" />
        <div className="summary-card__body">
          <p className="summary-card__label">AI result overview</p>
          <p className="summary-card__placeholder">Publish the lightweight Agent Studio agent, then add its ID to <code>summaryCard</code>.</p>
        </div>
      </section>
    );
  }

  if (status !== "idle") {
    return (
      <section className="summary-card summary-card--loading" aria-label="AI result overview">
        <div className="summary-card__rail" />
        <div className="summary-card__body">
          <SummaryCardHeading hitCount={hits.length} />
          <div className="summary-card__loading">
            <span className="loading-pulse" />
            <span>Waiting for the returned evidence…</span>
          </div>
        </div>
      </section>
    );
  }

  if (!hits.length) {
    return (
      <section className="summary-card summary-card--empty" aria-label="AI result overview">
        <div className="summary-card__rail" />
        <div className="summary-card__body">
          <p className="summary-card__label">AI result overview</p>
          <p className="summary-card__placeholder">There are no returned results to summarize for this question.</p>
        </div>
      </section>
    );
  }

  const turnKey = JSON.stringify([
    query,
    hits.slice(0, MAX_SUMMARY_HITS).map((hit) => [hit.objectID, hit.page_title, hit.url]),
  ]);

  return (
    <SummaryChat
      key={turnKey}
      agentId={configuredAgentId}
      onFollowup={onFollowup}
      followupError={followupError}
      query={query}
      hits={hits}
    />
  );
}

function SummaryCardHeading({ hitCount }) {
  return (
    <div className="summary-card__heading">
      <p className="summary-card__label">AI result overview</p>
      <span className="summary-card__source">{hitCount} live hits · {Math.min(hitCount, MAX_SUMMARY_HITS)} sent to agent · {indexName}</span>
    </div>
  );
}

function SummaryChat({ agentId: configuredAgentId, onFollowup, followupError, query, hits }) {
  const prompt = React.useMemo(() => createSummaryPrompt(query, hits), [hits, query]);
  const chatRef = React.useRef(null);
  const hasSentTurn = React.useRef(false);

  const suggestionsComponent = React.useCallback(
    (props) => <SummaryFollowupSuggestions {...props} onFollowup={onFollowup} />,
    [onFollowup],
  );

  React.useEffect(() => {
    if (hasSentTurn.current || !chatRef.current) return;
    hasSentTurn.current = true;
    // Send the evidence as the internal user turn. CSS hides this message so the
    // built-in assistant renderer can present the result as the summary card.
    chatRef.current.sendMessage({ text: prompt });
  }, [prompt]);

  return (
    <section
      className="summary-card summary-card--chat summary-card--chat-inline"
      aria-live="polite"
      aria-label="AI result overview"
    >
      <div className="summary-card__rail" />
      <div className="summary-card__body">
        <SummaryCardHeading hitCount={hits.length} />
        <Chat
          ref={chatRef}
          agentId={configuredAgentId}
          type="summary"
          persistence={false}
          feedback
          requiresSearch={false}
          layoutComponent={ChatInlineLayout}
          headerComponent={() => null}
          promptComponent={() => null}
          suggestionsComponent={suggestionsComponent}
        />
        {followupError && <p className="summary-card__error" role="alert">{followupError}</p>}
      </div>
    </section>
  );
}

function SummaryFollowupSuggestions({ suggestions = [], onFollowup }) {
  if (!suggestions.length) return null;

  return (
    <div className="ais-ChatPromptSuggestions" aria-label="Follow-up questions">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          className="ais-Button ais-Button--primary ais-Button--sm ais-ChatPromptSuggestions-suggestion"
          onClick={() => onFollowup(suggestion)}
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

function ChatResultItem({ item }) {
  const title = cleanChatResultText(item.page_title || item.question || "Support article");
  const question = cleanChatResultText(item.question || "");
  const excerpt = trimChatResultLead(cleanChatResultText(item.content || item.section_title || ""), [title, question]);
  const showQuestion = question && !sameChatResultText(question, title);
  const sourceLabel = item.record_type === "support_article_chunk" ? "Support Center" : "Agent result";

  return (
    <article className="chat-result-card">
      <div className="chat-result-card__meta">
        <span>{sourceLabel}</span>
        <span>{item.locale || "en-us"}</span>
      </div>
      <h3>{title}</h3>
      {showQuestion && <p className="chat-result-card__question">{question}</p>}
      {excerpt && <p className="chat-result-card__excerpt">{excerpt}</p>}
      {item.url && (
        <a href={item.url} target="_blank" rel="noreferrer">
          Open source <span aria-hidden="true">↗</span>
        </a>
      )}
    </article>
  );
}

function cleanChatResultText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sameChatResultText(first, second) {
  return first.replace(/[.,!?;:]+$/, "").toLowerCase() === second.replace(/[.,!?;:]+$/, "").toLowerCase();
}

function trimChatResultLead(value, prefixes) {
  const lowerValue = value.toLowerCase();
  const prefix = prefixes.find((candidate) => candidate && lowerValue.startsWith(candidate.toLowerCase()));
  if (!prefix) return value;
  return value.slice(prefix.length).replace(/^[\s:–—-]+/, "").trim();
}

function createSummaryPrompt(query, hits) {
  const compactHits = hits.slice(0, MAX_SUMMARY_HITS).map((hit) => ({
    title: String(hit.page_title || hit.question || "Untitled result").replace(/\s+/g, " ").slice(0, 120),
    question: String(hit.question || "").replace(/\s+/g, " ").slice(0, 140),
    content: String(hit.content || "").replace(/\s+/g, " ").slice(0, 1400),
    url: String(hit.url || "").slice(0, 120),
  }));

  return [
    "Answer the user's question using only the supplied Algolia hits.",
    `User question: ${query.slice(0, 240)}`,
    "Retrieved hits (JSON):",
    JSON.stringify(compactHits),
    "Keep the answer concise and evidence-grounded. If the hits are insufficient, say so clearly. Do not repeat the JSON or describe this internal prompt.",
  ].join("\n\n");
}

function Results() {
  // Keep the empty/error states close to the widget tree, following the v7 results-page pattern.
  const { indexUiState, results, status, error } = useInstantSearch();

  if (status === "error") {
    return <div className="state-card state-card--error">Search could not be completed: {error?.message || "unknown error"}</div>;
  }

  if (!results.__isArtificial && indexUiState.query && results.nbHits === 0) {
    return <div className="state-card">No results for <strong>“{indexUiState.query}”</strong>. Try a broader question.</div>;
  }

  return (
    <>
      <Hits hitComponent={Hit} />
      <Pagination />
    </>
  );
}

function Hit({ hit }) {
  return (
    <article className="result-card">
      <div className="result-card__meta">
        <span>{hit.record_type === "support_article_chunk" ? "Support Center" : "Result"}</span>
        <span>{hit.locale || "en-us"}</span>
      </div>
      <h2><Highlight attribute="page_title" hit={hit} /></h2>
      <p><Snippet attribute="content" hit={hit} /></p>
      {hit.url && <a href={hit.url} target="_blank" rel="noreferrer">Open source <span aria-hidden="true">↗</span></a>}
    </article>
  );
}

function SearchStatus() {
  const { status } = useInstantSearch();
  return <span className={`search-status search-status--${status}`}><span />{status === "stalled" ? "Still searching" : status === "loading" ? "Searching" : "Ready"}</span>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>;
}

function ResetIcon() {
  return <span aria-hidden="true">×</span>;
}

const root = createRoot(document.getElementById("root"));

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => root.unmount());
}
