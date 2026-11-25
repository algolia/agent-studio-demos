/* ───────────────────────────────────────────────────────────────
   shared/mic.js — a mic button inside a text input (Web Speech API).

     Mic.attach(input, { onFinal(text), lang })

   Interim words stream into the input as they are heard; the final
   result calls onFinal, which is where the page submits. Without
   SpeechRecognition (Firefox, most embedded views) attach does
   nothing, so the button never exists to disappoint anyone.
   Plain script: the pages that use it are classic and module alike.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const SR = global.SpeechRecognition || global.webkitSpeechRecognition;

  const CSS = `
.mic-wrap { position: relative; display: flex; flex: 1 1 0; min-width: 0; }
.mic-wrap > input[data-mic] { flex: 1; min-width: 0; padding-right: 2.75rem; }
.mic-btn {
  position: absolute; right: 0.35rem; top: 50%; transform: translateY(-50%);
  display: grid; place-items: center; width: 2rem; height: 2rem; padding: 0;
  border: 0; border-radius: 999px; background: transparent;
  color: var(--ink-3, currentColor); cursor: pointer;
}
.mic-btn:hover { color: var(--accent, currentColor); }
.mic-btn:focus-visible { outline: 2px solid var(--accent, currentColor); outline-offset: 1px; }
.mic-btn[aria-pressed="true"] {
  color: var(--accent, currentColor);
  background: var(--accent-soft, color-mix(in oklab, currentColor 14%, transparent));
  animation: mic-pulse 1.3s ease-out infinite;
}
.mic-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mic-btn svg { width: 1.1rem; height: 1.1rem; fill: currentColor; }
@keyframes mic-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--accent, currentColor) 45%, transparent); }
  100% { box-shadow: 0 0 0 0.7rem transparent; }
}
@media (prefers-reduced-motion: reduce) { .mic-btn[aria-pressed="true"] { animation: none; } }
`;

  const ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4Zm6-4a1 1 0 1 1 2 0 8 8 0 0 1-7 7.94V21h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.06A8 8 0 0 1 4 11a1 1 0 1 1 2 0 6 6 0 0 0 12 0Z"/></svg>';

  /** The words heard so far, and whether the last of them is final. */
  function transcript(results) {
    const list = Array.from(results || []);
    return {
      text: list.map((r) => (r[0] && r[0].transcript) || "").join("").trim(),
      final: list.length > 0 && list.every((r) => r.isFinal),
    };
  }

  function attach(input, { onFinal, lang } = {}) {
    if (!SR || !input || input.dataset.mic) return null;
    input.dataset.mic = "1";
    if (!document.getElementById("mic-css")) {
      const style = document.createElement("style");
      style.id = "mic-css";
      style.textContent = CSS;
      document.head.append(style);
    }
    const wrap = document.createElement("span");
    wrap.className = "mic-wrap";
    input.parentNode.insertBefore(wrap, input);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mic-btn";
    btn.setAttribute("aria-label", "Speak your query");
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = ICON;
    wrap.append(input, btn);

    let rec = null;
    const listening = () => btn.getAttribute("aria-pressed") === "true";
    const set = (on) => btn.setAttribute("aria-pressed", String(on));

    function start() {
      rec = new SR();
      rec.lang = lang || document.documentElement.lang || navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      let done = false;
      rec.onresult = (e) => {
        const { text, final } = transcript(e.results);
        if (!text) return;
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        if (final && !done) {
          done = true;
          rec.stop();
          if (onFinal) onFinal(text);
        }
      };
      rec.onerror = (e) => {
        set(false);
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          btn.disabled = true;
          btn.setAttribute("aria-label", "Microphone blocked");
        }
      };
      rec.onend = () => set(false);
      set(true);
      try {
        rec.start();
      } catch (e) {
        set(false);
      }
    }

    btn.addEventListener("click", () => (listening() ? rec.stop() : start()));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && listening()) rec.stop();
    });
    return btn;
  }

  global.Mic = { attach, transcript, supported: Boolean(SR) };
})(window);
