/* ───────────────────────────────────────────────────────────────
   i18n.js — the page chrome in eight languages.

   ── What this file is, and what it deliberately is not ───────────
   English is not in here. Every English string on the chat-with-a-book page
   still lives where it always did — in the markup, or in a template literal in
   app.js — which is what keeps it inside `scripts/check-copy.js`'s budgets. This
   file holds only the seven translations, keyed by a short id, and
   `t(key, fallback)` hands back the fallback when a language has no entry for a
   key. So the failure mode of a missing translation is English, never a blank
   label and never a key printed at a reader.

   That also means this file is NOT in check-copy's JS_FILES, and it is the one
   exemption the gate has beyond the conversation. The reason is that the gate
   measures ENGLISH: Flesch–Kincaid counts English syllables, the 400-word budget
   is 400 English words at 200 wpm, and running either over Japanese would produce
   a number with no meaning attached. The English source of truth is measured; the
   translations are held to it by being translations — each one is written to be
   no longer than the English it stands in for.

   ── The keys ─────────────────────────────────────────────────────
   Short ids, not the English text. Using the English as the key looks tidy for
   about a day: `check-copy.js --fix` rewrites the copy in place (gluing
   `&nbsp;` into em-dashes and number–unit pairs), and every key built out of that
   copy would silently stop matching. An id survives the fixer.

   Wrap glue is written as a backslash-u00a0 escape, never as the HTML entity. Most of these
   strings are handed to `textContent`, where the entity is six characters a
   reader can see; the escape is the same character in text, in markup and in an
   attribute, so one rule covers all three destinations.

   ── What is translated, and what is not ──────────────────────────
   The chrome: labels, headings, buttons, hints, the plan line under every book,
   the meter's tiles. NOT translated, on purpose:

     tooltips        opt-in depth, and the place this repo puts its one hard
                     sentence per idea. Translating them would triple this file
                     to serve the reader who has already chosen to dig.
     the wire log    method, path, stats. It is a transcript, not page voice.
     the footer      endpoint names and the unstable-API caveat.
     hooks, titles,  the books' own words, and the numbers. `Moby-Dick` is not
     authors, sizes  translated, and neither is `≈329,443 tok`.

   ── The interpolation ────────────────────────────────────────────
   `{name}` placeholders, filled by `t()`'s third argument. No plural machinery:
   where a count changes the wording, the caller picks the key (`shelf.books.one`
   / `shelf.books.many`), because plural rules differ by language in ways a
   two-branch helper would get wrong — Russian has three forms.

   Loaded as a plain script like every other shared module here.
   ─────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  /**
   * The eight the page offers, in the order the picker shows them: English
   * first, then by ISO code.
   *
   * `flag` is a convenience and an imperfect one — a flag is a country and a
   * language is not, and no flag is right for all of English or Spanish. It is
   * there because it is scannable at a glance; `native` is the accessible label
   * and the thing a reader actually recognises.
   *
   * `english` is the language's name in English, and it is not decoration
   * either: it is what goes into the reply-language note the model is sent.
   */
  const LANGS = [
    { code: "en", flag: "🇬🇧", native: "English", english: "English" },
    { code: "de", flag: "🇩🇪", native: "Deutsch", english: "German" },
    { code: "es", flag: "🇪🇸", native: "Español", english: "Spanish" },
    { code: "fr", flag: "🇫🇷", native: "Français", english: "French" },
    { code: "it", flag: "🇮🇹", native: "Italiano", english: "Italian" },
    { code: "ja", flag: "🇯🇵", native: "日本語", english: "Japanese" },
    { code: "ru", flag: "🇷🇺", native: "Русский", english: "Russian" },
    { code: "zh", flag: "🇨🇳", native: "中文", english: "Chinese" },
  ];

  const CODES = LANGS.map((l) => l.code);
  const DEFAULT = "en";

  /* ── The translations ──────────────────────────────────────────────
     One object per language, same key set in each — `tests/i18n.test.js` fails
     the build if one drifts. Kept as terse as the English: a label that wraps to
     two lines in one language and one in another is a layout bug written in
     prose. ── */

  const I18N = {
    fr: {
      "nav.allDemos": "Toutes les démos",
      skip: "Aller à la conversation",
      title: "Discuter avec<span class=\"fold-mark\" aria-hidden=\"true\"></span>un livre",
      titleLabel: "Discuter avec un livre",
      lede: "Une conversation manque de place bien avant de manquer de choses à dire. " +
        "<span class=\"nb\">Deux appels y suffisent :</span> <code>context/trim</code> compte, " +
        "<code>context/compact</code> plie. Prenez un livre sur l'étagère et regardez. " +
        "Plier n'est pas déchiqueter\u00a0— chaque section se rouvre.",
      "hero.tokens": "tokens portés",
      "hero.folds": "plis jusqu'ici",
      "hero.reclaimed": "tokens récupérés",
      cta: "Ça vous plaît ? Prenez le code <span aria-hidden=\"true\">→</span>",
      step1: "1 · Charger le contexte",
      step2: "2 · Choisir le moteur",
      step3: "3 · Regarder le pli",
      "shelf.sub": "Prenez un livre sur l'étagère, ou apportez le vôtre. Chaque tuile dit ce " +
        "que son chargement coûte, avant le clic. Rien ne quitte votre navigateur sauf les " +
        "appels du journal.",
      "originals.h": "Dans la langue d'origine",
      "byo.summary": "…ou apportez le vôtre\u00a0— texte, fichier ou URL",
      "byo.paste": "Collez un long document",
      "byo.placeholder": "Notes de version, spécification, transcription, chapitre…",
      "byo.file": "Choisir un fichier .txt ou .md",
      "byo.sample": "Prendre un exemple",
      "byo.url": "…ou récupérer une page web",
      "byo.fetch": "Récupérer",
      "byo.ingest": "Charger",
      "field.model": "Modèle",
      "field.budget": "Budget de travail",
      "field.greed": "Résultats par recherche",
      "field.lang": "Langue",
      "meter.eyebrow": "le compteur",
      "meter.title": "Contexte porté",
      "btn.compact": "Plier maintenant",
      "btn.reset": "Recommencer",
      "btn.send": "Envoyer",
      "ledger.h": "Le registre",
      "ledger.sub": "Une bande par message, hauteur proportionnelle à ses tokens estimés. " +
        "L'historique plié garde son pli.",
      "chat.h": "La conversation",
      "empty.h": "Rien n'est porté pour l'instant.",
      "empty.p": "Prenez un livre sur l'étagère, chargez un document, ou posez simplement une " +
        "question\u00a0— le compteur bouge dès le premier tour.",
      "cleared.h": "Effacé.",
      "cleared.p": "Prenez un livre sur l'étagère, ou chargez un document.",
      "chip.needle": "aiguille",
      "chip.arc": "arc",
      "chip.next": "suite",
      "chip.later": "après votre première question",
      "composer.label": "Votre message",
      "composer.placeholder": "Posez une question sur ce livre…",
      "tile.naive": "Naïf",
      "tile.real": "Réel",
      "tile.est": "est.",
      "tile.saved": "Économisé",
      "tile.unlocked": "Débloqué",
      "tile.wontFit": "ne tiendrait même pas ✗",
      "tile.pct": "{pct}% du naïf",
      "tile.payingBack": "se rembourse",
      "tile.noTurn": "aucun tour encore",
      "tile.unlockedSub": "run naïf : impossible\u00a0— rien à soustraire",
      "cost.breakdown": "Détail",
      "cost.hide": "Masquer",
      "theme.dark": "Sombre",
      "theme.light": "Clair",
      "regime.fits-budget.heading": "Assez petit pour qu'il ne se passe rien",
      "regime.budget-compact.heading": "Envoyé entier, puis plié à votre première question",
      "regime.oversize-fold.heading": "Trop grand pour être envoyé\u00a0— plié à l'arrivée",
      "regime.cost-gated.heading": "Le prix mérite un regard avant le clic",
      "shelf.books.one": "1 livre",
      "shelf.books.many": "{n} livres",
      "plan.fits": "tient entier dans le budget",
      "plan.compacts": "plié à votre première question",
      "plan.folds": "plié en {n} parties à l'arrivée",
      "plan.noCall": "aucun appel au résumeur",
      "plan.call1": "~{n} appel au résumeur ≈ {usd} à {rate}",
      "plan.calls": "~{n} appels au résumeur ≈ {usd} à {rate}",
      "plan.callsNoRate": "~{n} appels au résumeur · le coût dépend du modèle",
      "plan.illustrative": "un tarif indicatif",
      "plan.listPrice": "un tarif public",
      "gate.title": "{title} coûte environ {usd} à charger",
      "gate.go": "Charger quand même · ~{usd}",
      "gate.no": "Pas maintenant",
      "gate.flag": "demande d'abord · au-delà de {usd}",
      "gate.titleTokens": "{title} : \u2248{tok} tokens à plier · ~{usd}",
      "gate.goTokens": "Charger quand même · \u2248{tok} tok",
      "gate.flagTokens": "demande d'abord · au-delà de {tok} tok",
      "greed.title": "Cette question porte ≈{tok} tokens · ~{usd}",
      "greed.go": "Demander quand même · ≈{tok} tok",
      "greed.hint": "jusqu'à ≈{tok} tokens par recherche",
      "greed.default": "jusqu'à ≈{tok} tokens par recherche · valeur par défaut",
      "greed.past": "au-delà de la fenêtre de {win} tokens de {label}",
      "greed.asks": "demande avant d'envoyer",
      "state.ok": "De la place à revendre",
      "state.warn": "Le pli approche",
      "state.at": "Au budget\u00a0— plier pour continuer",
      "state.over": "Budget dépassé de {n} tokens\u00a0— plier pour continuer",
      "status.fetching": "Récupération de {title}…",
      "status.loaded": "{title} est dans la conversation\u00a0— posez une question.",
      "status.cleared": "{title} effacé\u00a0— reprenez-le, ou un autre.",
    },

    de: {
      "nav.allDemos": "Alle Demos",
      skip: "Zum Gespräch springen",
      title: "Mit einem Buch<span class=\"fold-mark\" aria-hidden=\"true\"></span>sprechen",
      titleLabel: "Mit einem Buch sprechen",
      lede: "Einem Gespräch geht der Platz lange vor dem Gesprächsstoff aus. " +
        "<span class=\"nb\">Zwei Aufrufe genügen:</span> <code>context/trim</code> zählt, " +
        "<code>context/compact</code> faltet. Nehmen Sie ein Buch vom Regal und schauen Sie zu. " +
        "Falten ist kein Schreddern\u00a0— jeder Abschnitt lässt sich wieder öffnen.",
      "hero.tokens": "getragene Tokens",
      "hero.folds": "Faltungen bisher",
      "hero.reclaimed": "zurückgewonnene Tokens",
      cta: "Gefällt es? Nehmen Sie den Code <span aria-hidden=\"true\">→</span>",
      step1: "1 · Kontext laden",
      step2: "2 · Motor wählen",
      step3: "3 · Der Faltung zusehen",
      "shelf.sub": "Nehmen Sie ein Buch vom Regal, oder bringen Sie ein eigenes mit. Jede Karte " +
        "sagt vor dem Klick, was das Laden kostet. Nichts verlässt Ihren Browser außer den " +
        "Aufrufen im Protokoll.",
      "originals.h": "In der Originalsprache",
      "byo.summary": "…oder etwas Eigenes\u00a0— Text, Datei oder URL",
      "byo.paste": "Ein langes Dokument einfügen",
      "byo.placeholder": "Release Notes, eine Spezifikation, ein Transkript, ein Kapitel…",
      "byo.file": "Eine .txt- oder .md-Datei wählen",
      "byo.sample": "Beispiel verwenden",
      "byo.url": "…oder eine Webseite holen",
      "byo.fetch": "Holen",
      "byo.ingest": "Laden",
      "field.model": "Modell",
      "field.budget": "Arbeitsbudget",
      "field.greed": "Treffer pro Suche",
      "field.lang": "Sprache",
      "meter.eyebrow": "der Zähler",
      "meter.title": "Getragener Kontext",
      "btn.compact": "Jetzt falten",
      "btn.reset": "Neu anfangen",
      "btn.send": "Senden",
      "ledger.h": "Das Journal",
      "ledger.sub": "Ein Band pro Nachricht, Höhe proportional zu den geschätzten Tokens. " +
        "Gefaltete Geschichte behält ihren Knick.",
      "chat.h": "Das Gespräch",
      "empty.h": "Noch wird nichts getragen.",
      "empty.p": "Nehmen Sie ein Buch vom Regal, laden Sie ein eigenes Dokument, oder fragen " +
        "Sie einfach\u00a0— der Zähler bewegt sich ab dem ersten Zug.",
      "cleared.h": "Geleert.",
      "cleared.p": "Nehmen Sie ein Buch vom Regal, oder laden Sie ein eigenes Dokument.",
      "chip.needle": "Nadel",
      "chip.arc": "Bogen",
      "chip.next": "weiter",
      "chip.later": "nach Ihrer ersten Frage",
      "composer.label": "Ihre Nachricht",
      "composer.placeholder": "Fragen Sie etwas über dieses Buch…",
      "tile.naive": "Naiv",
      "tile.real": "Real",
      "tile.est": "gesch.",
      "tile.saved": "Gespart",
      "tile.unlocked": "Ermöglicht",
      "tile.wontFit": "würde nicht einmal passen ✗",
      "tile.pct": "{pct}% des naiven",
      "tile.payingBack": "zahlt sich zurück",
      "tile.noTurn": "noch kein Zug",
      "tile.unlockedSub": "naiver Lauf: unmöglich\u00a0— nichts abzuziehen",
      "cost.breakdown": "Aufschlüsselung",
      "cost.hide": "Ausblenden",
      "theme.dark": "Dunkel",
      "theme.light": "Hell",
      "regime.fits-budget.heading": "Klein genug, dass nichts passiert",
      "regime.budget-compact.heading": "Ganz gesendet, dann bei Ihrer ersten Frage gefaltet",
      "regime.oversize-fold.heading": "Zu groß zum Senden\u00a0— bei Ankunft gefaltet",
      "regime.cost-gated.heading": "Den Preis liest man besser vor dem Klick",
      "shelf.books.one": "1 Buch",
      "shelf.books.many": "{n} Bücher",
      "plan.fits": "passt ganz ins Arbeitsbudget",
      "plan.compacts": "wird bei Ihrer ersten Frage gefaltet",
      "plan.folds": "wird bei Ankunft in {n} Teile gefaltet",
      "plan.noCall": "kein Aufruf des Zusammenfassers",
      "plan.call1": "~{n} Aufruf des Zusammenfassers ≈ {usd} zu {rate}",
      "plan.calls": "~{n} Aufrufe des Zusammenfassers ≈ {usd} zu {rate}",
      "plan.callsNoRate": "~{n} Aufrufe des Zusammenfassers · Kosten je nach Modell",
      "plan.illustrative": "einem beispielhaften Tarif",
      "plan.listPrice": "einem Listenpreis",
      "gate.title": "{title} kostet etwa {usd} zu laden",
      "gate.go": "Trotzdem laden · ~{usd}",
      "gate.no": "Jetzt nicht",
      "gate.flag": "fragt zuerst · über {usd}",
      "gate.titleTokens": "{title}: \u2248{tok} Tokens zu falten · ~{usd}",
      "gate.goTokens": "Trotzdem laden · \u2248{tok} Tok",
      "gate.flagTokens": "fragt zuerst · über {tok} Tok",
      "greed.title": "Diese Frage trägt ≈{tok} Tokens · ~{usd}",
      "greed.go": "Trotzdem fragen · ≈{tok} Tok",
      "greed.hint": "bis zu ≈{tok} Tokens pro Suche",
      "greed.default": "bis zu ≈{tok} Tokens pro Suche · heutiger Standard",
      "greed.past": "jenseits des {win}-Token-Fensters von {label}",
      "greed.asks": "fragt vor dem Senden",
      "state.ok": "Reichlich Platz",
      "state.warn": "Die Faltung kommt näher",
      "state.at": "Am Budget\u00a0— falten, um weiterzumachen",
      "state.over": "{n} Tokens über dem Budget\u00a0— falten, um weiterzumachen",
      "status.fetching": "{title} wird geholt…",
      "status.loaded": "{title} ist im Gespräch\u00a0— fragen Sie etwas.",
      "status.cleared": "{title} geleert\u00a0— wieder wählen, oder ein anderes.",
    },

    es: {
      "nav.allDemos": "Todas las demos",
      skip: "Ir a la conversación",
      title: "Hablar con<span class=\"fold-mark\" aria-hidden=\"true\"></span>un libro",
      titleLabel: "Hablar con un libro",
      lede: "A una conversación se le acaba el sitio mucho antes que las cosas que decir. " +
        "<span class=\"nb\">Dos llamadas lo resuelven:</span> <code>context/trim</code> cuenta, " +
        "<code>context/compact</code> pliega. Coja un libro del estante y mire. " +
        "Plegar no es triturar\u00a0— cada sección vuelve a abrirse.",
      "hero.tokens": "tokens llevados",
      "hero.folds": "pliegues hasta ahora",
      "hero.reclaimed": "tokens recuperados",
      cta: "¿Le gusta? Use el código <span aria-hidden=\"true\">→</span>",
      step1: "1 · Cargar el contexto",
      step2: "2 · Elegir el motor",
      step3: "3 · Ver el pliegue",
      "shelf.sub": "Coja un libro del estante, o traiga el suyo. Cada ficha dice lo que costará " +
        "cargarlo, antes del clic. Nada sale de su navegador salvo las llamadas del registro.",
      "originals.h": "En su lengua original",
      "byo.summary": "…o traiga el suyo\u00a0— texto, archivo o URL",
      "byo.paste": "Pegue un documento largo",
      "byo.placeholder": "Notas de versión, una especificación, una transcripción, un capítulo…",
      "byo.file": "Elegir un archivo .txt o .md",
      "byo.sample": "Usar un ejemplo",
      "byo.url": "…o traer una página web",
      "byo.fetch": "Traer",
      "byo.ingest": "Cargar",
      "field.model": "Modelo",
      "field.budget": "Presupuesto de trabajo",
      "field.greed": "Resultados por búsqueda",
      "field.lang": "Idioma",
      "meter.eyebrow": "el contador",
      "meter.title": "Contexto llevado",
      "btn.compact": "Plegar ahora",
      "btn.reset": "Empezar de nuevo",
      "btn.send": "Enviar",
      "ledger.h": "El libro de cuentas",
      "ledger.sub": "Una banda por mensaje, con la altura proporcional a sus tokens estimados. " +
        "El historial plegado guarda su pliegue.",
      "chat.h": "La conversación",
      "empty.h": "Todavía no se lleva nada.",
      "empty.p": "Coja un libro del estante, cargue un documento propio, o pregunte sin " +
        "más\u00a0— el contador se mueve desde el primer turno.",
      "cleared.h": "Vaciado.",
      "cleared.p": "Coja un libro del estante, o cargue un documento propio.",
      "chip.needle": "aguja",
      "chip.arc": "arco",
      "chip.next": "sigue",
      "chip.later": "tras su primera pregunta",
      "composer.label": "Su mensaje",
      "composer.placeholder": "Pregunte algo sobre este libro…",
      "tile.naive": "Ingenuo",
      "tile.real": "Real",
      "tile.est": "est.",
      "tile.saved": "Ahorrado",
      "tile.unlocked": "Desbloqueado",
      "tile.wontFit": "no cabría siquiera ✗",
      "tile.pct": "{pct}% del ingenuo",
      "tile.payingBack": "se está amortizando",
      "tile.noTurn": "ningún turno aún",
      "tile.unlockedSub": "run ingenuo: imposible\u00a0— nada que restar",
      "cost.breakdown": "Desglose",
      "cost.hide": "Ocultar",
      "theme.dark": "Oscuro",
      "theme.light": "Claro",
      "regime.fits-budget.heading": "Tan pequeño que no pasa nada",
      "regime.budget-compact.heading": "Enviado entero, y plegado en su primera pregunta",
      "regime.oversize-fold.heading": "Demasiado grande para enviarlo\u00a0— plegado al llegar",
      "regime.cost-gated.heading": "Vale la pena leer el precio antes del clic",
      "shelf.books.one": "1 libro",
      "shelf.books.many": "{n} libros",
      "plan.fits": "cabe entero en el presupuesto",
      "plan.compacts": "se pliega en su primera pregunta",
      "plan.folds": "se pliega en {n} partes al llegar",
      "plan.noCall": "ninguna llamada al resumidor",
      "plan.call1": "~{n} llamada al resumidor ≈ {usd} a {rate}",
      "plan.calls": "~{n} llamadas al resumidor ≈ {usd} a {rate}",
      "plan.callsNoRate": "~{n} llamadas al resumidor · el coste depende del modelo",
      "plan.illustrative": "una tarifa ilustrativa",
      "plan.listPrice": "un precio de tarifa",
      "gate.title": "Cargar {title} cuesta unos {usd}",
      "gate.go": "Cargar de todos modos · ~{usd}",
      "gate.no": "Ahora no",
      "gate.flag": "pregunta primero · más de {usd}",
      "gate.titleTokens": "{title}: \u2248{tok} tokens por plegar · ~{usd}",
      "gate.goTokens": "Cargar de todos modos · \u2248{tok} tok",
      "gate.flagTokens": "pregunta primero · más de {tok} tok",
      "greed.title": "Esta pregunta lleva ≈{tok} tokens · ~{usd}",
      "greed.go": "Preguntar de todos modos · ≈{tok} tok",
      "greed.hint": "hasta ≈{tok} tokens por búsqueda",
      "greed.default": "hasta ≈{tok} tokens por búsqueda · el valor de hoy",
      "greed.past": "más allá de la ventana de {win} tokens de {label}",
      "greed.asks": "pregunta antes de enviar",
      "state.ok": "Sitio de sobra",
      "state.warn": "El pliegue se acerca",
      "state.at": "En el presupuesto\u00a0— pliegue para seguir",
      "state.over": "{n} tokens por encima del presupuesto\u00a0— pliegue para seguir",
      "status.fetching": "Trayendo {title}…",
      "status.loaded": "{title} está en la conversación\u00a0— pregúntele algo.",
      "status.cleared": "{title} vaciado\u00a0— vuelva a cogerlo, u otro.",
    },

    it: {
      "nav.allDemos": "Tutte le demo",
      skip: "Vai alla conversazione",
      title: "Parlare con<span class=\"fold-mark\" aria-hidden=\"true\"></span>un libro",
      titleLabel: "Parlare con un libro",
      lede: "A una conversazione finisce lo spazio molto prima delle cose da dire. " +
        "<span class=\"nb\">Bastano due chiamate:</span> <code>context/trim</code> conta, " +
        "<code>context/compact</code> piega. Prenda un libro dallo scaffale e guardi. " +
        "Piegare non è distruggere\u00a0— ogni sezione si riapre.",
      "hero.tokens": "token portati",
      "hero.folds": "pieghe finora",
      "hero.reclaimed": "token recuperati",
      cta: "Le piace? Prenda il codice <span aria-hidden=\"true\">→</span>",
      step1: "1 · Caricare il contesto",
      step2: "2 · Scegliere il motore",
      step3: "3 · Guardare la piega",
      "shelf.sub": "Prenda un libro dallo scaffale, o porti il suo. Ogni scheda dice quanto " +
        "costerà caricarlo, prima del clic. Nulla lascia il browser tranne le chiamate " +
        "nel registro.",
      "originals.h": "Nella lingua originale",
      "byo.summary": "…o porti il suo\u00a0— testo, file o URL",
      "byo.paste": "Incolli un documento lungo",
      "byo.placeholder": "Note di rilascio, una specifica, una trascrizione, un capitolo…",
      "byo.file": "Scegliere un file .txt o .md",
      "byo.sample": "Usare un esempio",
      "byo.url": "…o prendere una pagina web",
      "byo.fetch": "Prendi",
      "byo.ingest": "Carica",
      "field.model": "Modello",
      "field.budget": "Budget di lavoro",
      "field.greed": "Risultati per ricerca",
      "field.lang": "Lingua",
      "meter.eyebrow": "il contatore",
      "meter.title": "Contesto portato",
      "btn.compact": "Piega ora",
      "btn.reset": "Ricomincia",
      "btn.send": "Invia",
      "ledger.h": "Il registro",
      "ledger.sub": "Una banda per messaggio, alta in proporzione ai token stimati. " +
        "La storia piegata conserva la sua piega.",
      "chat.h": "La conversazione",
      "empty.h": "Non si porta ancora nulla.",
      "empty.p": "Prenda un libro dallo scaffale, carichi un suo documento, o faccia " +
        "semplicemente una domanda\u00a0— il contatore parte dal primo turno.",
      "cleared.h": "Svuotato.",
      "cleared.p": "Prenda un libro dallo scaffale, o carichi un suo documento.",
      "chip.needle": "ago",
      "chip.arc": "arco",
      "chip.next": "poi",
      "chip.later": "dopo la prima domanda",
      "composer.label": "Il suo messaggio",
      "composer.placeholder": "Chieda qualcosa su questo libro…",
      "tile.naive": "Ingenuo",
      "tile.real": "Reale",
      "tile.est": "stim.",
      "tile.saved": "Risparmiato",
      "tile.unlocked": "Sbloccato",
      "tile.wontFit": "non ci starebbe nemmeno ✗",
      "tile.pct": "{pct}% dell'ingenuo",
      "tile.payingBack": "si sta ripagando",
      "tile.noTurn": "ancora nessun turno",
      "tile.unlockedSub": "run ingenuo: impossibile\u00a0— niente da sottrarre",
      "cost.breakdown": "Dettaglio",
      "cost.hide": "Nascondi",
      "theme.dark": "Scuro",
      "theme.light": "Chiaro",
      "regime.fits-budget.heading": "Abbastanza piccolo perché non succeda nulla",
      "regime.budget-compact.heading": "Inviato intero, poi piegato alla prima domanda",
      "regime.oversize-fold.heading": "Troppo grande da inviare\u00a0— piegato all'arrivo",
      "regime.cost-gated.heading": "Il prezzo va letto prima del clic",
      "shelf.books.one": "1 libro",
      "shelf.books.many": "{n} libri",
      "plan.fits": "sta intero nel budget",
      "plan.compacts": "si piega alla prima domanda",
      "plan.folds": "si piega in {n} parti all'arrivo",
      "plan.noCall": "nessuna chiamata al riassuntore",
      "plan.call1": "~{n} chiamata al riassuntore ≈ {usd} a {rate}",
      "plan.calls": "~{n} chiamate al riassuntore ≈ {usd} a {rate}",
      "plan.callsNoRate": "~{n} chiamate al riassuntore · il costo dipende dal modello",
      "plan.illustrative": "una tariffa indicativa",
      "plan.listPrice": "un prezzo di listino",
      "gate.title": "Caricare {title} costa circa {usd}",
      "gate.go": "Carica comunque · ~{usd}",
      "gate.no": "Non ora",
      "gate.flag": "chiede prima · oltre {usd}",
      "gate.titleTokens": "{title}: \u2248{tok} token da piegare · ~{usd}",
      "gate.goTokens": "Carica comunque · \u2248{tok} token",
      "gate.flagTokens": "chiede prima · oltre {tok} token",
      "greed.title": "Questa domanda porta ≈{tok} token · ~{usd}",
      "greed.go": "Chiedi comunque · ≈{tok} tok",
      "greed.hint": "fino a ≈{tok} token per ricerca",
      "greed.default": "fino a ≈{tok} token per ricerca · valore predefinito",
      "greed.past": "oltre la finestra di {win} token di {label}",
      "greed.asks": "chiede prima di inviare",
      "state.ok": "Spazio in abbondanza",
      "state.warn": "La piega si avvicina",
      "state.at": "Al limite del budget\u00a0— piega per continuare",
      "state.over": "{n} token oltre il budget\u00a0— piega per continuare",
      "status.fetching": "Sto prendendo {title}…",
      "status.loaded": "{title} è nella conversazione\u00a0— chieda qualcosa.",
      "status.cleared": "{title} svuotato\u00a0— lo riprenda, o un altro.",
    },

    ru: {
      "nav.allDemos": "Все демо",
      skip: "К разговору",
      title: "Поговорить<span class=\"fold-mark\" aria-hidden=\"true\"></span>с книгой",
      titleLabel: "Поговорить с книгой",
      lede: "Место в разговоре кончается задолго до того, как кончаются темы. " +
        "<span class=\"nb\">Хватает двух вызовов:</span> <code>context/trim</code> считает, " +
        "<code>context/compact</code> складывает. Возьмите книгу с полки и смотрите. " +
        "Сложить — не значит уничтожить\u00a0— каждый раздел открывается снова.",
      "hero.tokens": "токенов несём",
      "hero.folds": "складываний",
      "hero.reclaimed": "токенов вернули",
      cta: "Нравится? Возьмите код <span aria-hidden=\"true\">→</span>",
      step1: "1 · Загрузить контекст",
      step2: "2 · Выбрать движок",
      step3: "3 · Смотреть, как складывается",
      "shelf.sub": "Возьмите книгу с полки или принесите свою. Каждая карточка говорит, во что " +
        "обойдётся загрузка, ещё до нажатия. Из браузера уходят только вызовы из журнала.",
      "originals.h": "В оригинале",
      "byo.summary": "…или своё\u00a0— текст, файл или URL",
      "byo.paste": "Вставьте длинный документ",
      "byo.placeholder": "Список изменений, спецификация, стенограмма, глава…",
      "byo.file": "Выбрать файл .txt или .md",
      "byo.sample": "Взять пример",
      "byo.url": "…или загрузить веб-страницу",
      "byo.fetch": "Загрузить",
      "byo.ingest": "Принять",
      "field.model": "Модель",
      "field.budget": "Рабочий бюджет",
      "field.greed": "Результатов на поиск",
      "field.lang": "Язык",
      "meter.eyebrow": "счётчик",
      "meter.title": "Контекст в работе",
      "btn.compact": "Сложить сейчас",
      "btn.reset": "Начать заново",
      "btn.send": "Отправить",
      "ledger.h": "Ведомость",
      "ledger.sub": "Одна полоса на сообщение, высота — по оценке токенов. " +
        "Сложенная история хранит свой сгиб.",
      "chat.h": "Разговор",
      "empty.h": "Пока ничего не несём.",
      "empty.p": "Возьмите книгу с полки, загрузите свой документ или просто задайте " +
        "вопрос\u00a0— счётчик пойдёт с первого хода.",
      "cleared.h": "Очищено.",
      "cleared.p": "Возьмите книгу с полки или загрузите свой документ.",
      "chip.needle": "иголка",
      "chip.arc": "дуга",
      "chip.next": "дальше",
      "chip.later": "после первого вопроса",
      "composer.label": "Ваше сообщение",
      "composer.placeholder": "Спросите что-нибудь об этой книге…",
      "tile.naive": "Наивно",
      "tile.real": "Реально",
      "tile.est": "оц.",
      "tile.saved": "Сэкономлено",
      "tile.unlocked": "Стало возможным",
      "tile.wontFit": "даже не поместилось бы ✗",
      "tile.pct": "{pct}% от наивного",
      "tile.payingBack": "окупается",
      "tile.noTurn": "ходов ещё нет",
      "tile.unlockedSub": "наивный прогон невозможен\u00a0— вычитать нечего",
      "cost.breakdown": "Разбор",
      "cost.hide": "Скрыть",
      "theme.dark": "Тёмная",
      "theme.light": "Светлая",
      "regime.fits-budget.heading": "Настолько мало, что ничего не происходит",
      "regime.budget-compact.heading": "Уходит целиком, складывается на первом вопросе",
      "regime.oversize-fold.heading": "Слишком велико, чтобы отправить\u00a0— складывается сразу",
      "regime.cost-gated.heading": "Цену стоит прочитать до нажатия",
      "shelf.books.one": "1 книга",
      "shelf.books.many": "книг: {n}",
      "plan.fits": "целиком укладывается в бюджет",
      "plan.compacts": "сложится на первом вопросе",
      "plan.folds": "сложится в {n} частей при загрузке",
      "plan.noCall": "без вызова суммаризатора",
      "plan.call1": "~{n} вызов суммаризатора ≈ {usd} по {rate}",
      "plan.calls": "~{n} вызовов суммаризатора ≈ {usd} по {rate}",
      "plan.callsNoRate": "~{n} вызовов суммаризатора · цена зависит от модели",
      "plan.illustrative": "условному тарифу",
      "plan.listPrice": "прайс-листу",
      "gate.title": "{title} обойдётся примерно в {usd}",
      "gate.go": "Всё равно загрузить · ~{usd}",
      "gate.no": "Не сейчас",
      "gate.flag": "спросит сначала · дороже {usd}",
      "gate.titleTokens": "{title}: \u2248{tok} токенов для сворачивания · ~{usd}",
      "gate.goTokens": "Всё равно загрузить · \u2248{tok} ток.",
      "gate.flagTokens": "спросит сначала · больше {tok} ток.",
      "greed.title": "Этот вопрос несёт ≈{tok} токенов · ~{usd}",
      "greed.go": "Всё равно спросить · ≈{tok} ток.",
      "greed.hint": "до ≈{tok} токенов на поиск",
      "greed.default": "до ≈{tok} токенов на поиск · значение по умолчанию",
      "greed.past": "больше окна {label} в {win} токенов",
      "greed.asks": "спросит перед отправкой",
      "state.ok": "Места вдоволь",
      "state.warn": "Складывание близко",
      "state.at": "Бюджет исчерпан\u00a0— сложите, чтобы продолжить",
      "state.over": "Бюджет превышен на {n} токенов\u00a0— сложите, чтобы продолжить",
      "status.fetching": "Загружаем {title}…",
      "status.loaded": "{title} в разговоре\u00a0— спросите что-нибудь.",
      "status.cleared": "{title} очищено\u00a0— возьмите снова или другую книгу.",
    },

    ja: {
      "nav.allDemos": "デモ一覧",
      skip: "会話へ移動",
      title: "本と<span class=\"fold-mark\" aria-hidden=\"true\"></span>話す",
      titleLabel: "本と話す",
      lede: "会話は、話すことが尽きるずっと前に場所が尽きます。" +
        "<span class=\"nb\">必要な呼び出しは二つ:</span> <code>context/trim</code> が数え、" +
        "<code>context/compact</code> が畳みます。棚から一冊とって見てください。" +
        "畳むのは裁断ではありません\u00a0— どの区画も開き直せます。",
      "hero.tokens": "運んでいるトークン",
      "hero.folds": "これまでの畳み",
      "hero.reclaimed": "取り戻したトークン",
      cta: "気に入ったら、このコードをどうぞ <span aria-hidden=\"true\">→</span>",
      step1: "1 · 文脈を読み込む",
      step2: "2 · エンジンを選ぶ",
      step3: "3 · 畳まれるのを見る",
      "shelf.sub": "棚から一冊とるか、自分の文書を持ち込んでください。読み込みにいくらかかるかは、" +
        "押す前に各タイルが示します。ブラウザから出るのは記録にある呼び出しだけです。",
      "originals.h": "原語のまま",
      "byo.summary": "…自分のものでも\u00a0— 貼り付け、ファイル、URL",
      "byo.paste": "長い文書を貼り付ける",
      "byo.placeholder": "リリースノート、仕様、書き起こし、一章…",
      "byo.file": ".txt か .md のファイルを選ぶ",
      "byo.sample": "見本を使う",
      "byo.url": "…またはウェブページを取得",
      "byo.fetch": "取得",
      "byo.ingest": "読み込む",
      "field.model": "モデル",
      "field.budget": "作業予算",
      "field.greed": "1回の検索で取る件数",
      "field.lang": "言語",
      "meter.eyebrow": "メーター",
      "meter.title": "運んでいる文脈",
      "btn.compact": "いま畳む",
      "btn.reset": "やり直す",
      "btn.send": "送信",
      "ledger.h": "台帳",
      "ledger.sub": "1件につき1本の帯で、高さは推定トークン数に比例します。" +
        "畳まれた履歴には折り目が残ります。",
      "chat.h": "会話",
      "empty.h": "まだ何も運んでいません。",
      "empty.p": "棚から一冊とるか、自分の文書を読み込むか、そのまま質問してください" +
        "\u00a0— 最初の一手からメーターが動きます。",
      "cleared.h": "消しました。",
      "cleared.p": "棚から一冊とるか、自分の文書を読み込んでください。",
      "chip.needle": "一点",
      "chip.arc": "全体",
      "chip.next": "次に",
      "chip.later": "最初の質問のあとに",
      "composer.label": "メッセージ",
      "composer.placeholder": "この本について聞いてください…",
      "tile.naive": "素朴",
      "tile.real": "実際",
      "tile.est": "推定",
      "tile.saved": "節約",
      "tile.unlocked": "可能になった",
      "tile.wontFit": "そもそも入りません ✗",
      "tile.pct": "素朴の{pct}%",
      "tile.payingBack": "元をとりつつある",
      "tile.noTurn": "まだ一手もなし",
      "tile.unlockedSub": "素朴な実行は不可能\u00a0— 引く相手がいません",
      "cost.breakdown": "内訳",
      "cost.hide": "隠す",
      "theme.dark": "暗く",
      "theme.light": "明るく",
      "regime.fits-budget.heading": "小さすぎて何も起きません",
      "regime.budget-compact.heading": "丸ごと送られ、最初の質問で畳まれます",
      "regime.oversize-fold.heading": "大きすぎて送れません\u00a0— 到着時に畳みます",
      "regime.cost-gated.heading": "押す前に値段を読む価値があります",
      "shelf.books.one": "1冊",
      "shelf.books.many": "{n}冊",
      "plan.fits": "作業予算に丸ごと収まる",
      "plan.compacts": "最初の質問で畳まれる",
      "plan.folds": "到着時に{n}部に畳まれる",
      "plan.noCall": "要約の呼び出しなし",
      "plan.call1": "要約の呼び出し約{n}回 ≈ {usd}（{rate}）",
      "plan.calls": "要約の呼び出し約{n}回 ≈ {usd}（{rate}）",
      "plan.callsNoRate": "要約の呼び出し約{n}回 · 費用はモデル次第",
      "plan.illustrative": "参考価格",
      "plan.listPrice": "公表価格",
      "gate.title": "{title} の読み込みは約 {usd}",
      "gate.go": "それでも読み込む · ~{usd}",
      "gate.no": "いまはやめる",
      "gate.flag": "先に確認 · {usd} 超",
      "gate.titleTokens": "{title} は約{tok}トークンの折りたたみ · ~{usd}",
      "gate.goTokens": "それでも読み込む · \u2248{tok} トークン",
      "gate.flagTokens": "先に確認 · {tok} トークン超",
      "greed.title": "この質問は約{tok}トークン · ~{usd}",
      "greed.go": "それでも聞く · ≈{tok} トークン",
      "greed.hint": "1回の検索で最大 約{tok}トークン",
      "greed.default": "1回の検索で最大 約{tok}トークン · 既定値",
      "greed.past": "{label} の{win}トークンの窓を超えます",
      "greed.asks": "送信前に確認します",
      "state.ok": "余裕あり",
      "state.warn": "畳みが近い",
      "state.at": "予算いっぱい\u00a0— 畳めば続けられます",
      "state.over": "予算を{n}トークン超過\u00a0— 畳めば続けられます",
      "status.fetching": "{title} を取得中…",
      "status.loaded": "{title} が会話に入りました\u00a0— 何か聞いてください。",
      "status.cleared": "{title} を消しました\u00a0— もう一度選ぶか、別の本を。",
    },

    zh: {
      "nav.allDemos": "全部示例",
      skip: "跳到对话",
      title: "和一本书<span class=\"fold-mark\" aria-hidden=\"true\"></span>聊天",
      titleLabel: "和一本书聊天",
      lede: "对话的空间，往往比话题先用完。" +
        "<span class=\"nb\">两个调用就够了:</span> <code>context/trim</code> 负责数，" +
        "<code>context/compact</code> 负责折。从书架上取一本，看着它发生。" +
        "折叠不是碎纸\u00a0— 每一段都能重新打开。",
      "hero.tokens": "携带的 token",
      "hero.folds": "已折叠次数",
      "hero.reclaimed": "收回的 token",
      cta: "喜欢？把代码拿去用 <span aria-hidden=\"true\">→</span>",
      step1: "1 · 载入上下文",
      step2: "2 · 选择引擎",
      step3: "3 · 看它折叠",
      "shelf.sub": "从书架上取一本，或带上你自己的文本。每张卡片在你点击之前就说明载入的代价。" +
        "除了记录里的调用，没有任何东西离开你的浏览器。",
      "originals.h": "原文语言",
      "byo.summary": "…或用你自己的\u00a0— 粘贴、文件或网址",
      "byo.paste": "粘贴一段长文本",
      "byo.placeholder": "发布说明、规格、访谈记录、一章…",
      "byo.file": "选择 .txt 或 .md 文件",
      "byo.sample": "用示例",
      "byo.url": "…或抓取一个网页",
      "byo.fetch": "抓取",
      "byo.ingest": "载入",
      "field.model": "模型",
      "field.budget": "工作预算",
      "field.greed": "每次检索的结果数",
      "field.lang": "语言",
      "meter.eyebrow": "计量表",
      "meter.title": "携带的上下文",
      "btn.compact": "立即折叠",
      "btn.reset": "重新开始",
      "btn.send": "发送",
      "ledger.h": "账目",
      "ledger.sub": "每条消息一条色带，高度与其估算 token 成正比。折叠过的历史留着折痕。",
      "chat.h": "对话",
      "empty.h": "还没有携带任何东西。",
      "empty.p": "从书架上取一本，载入你自己的文本，或者直接提问" +
        "\u00a0— 计量表从第一轮就开始动。",
      "cleared.h": "已清空。",
      "cleared.p": "从书架上取一本，或载入你自己的文本。",
      "chip.needle": "一处",
      "chip.arc": "整体",
      "chip.next": "接着",
      "chip.later": "在你的第一个问题之后",
      "composer.label": "你的消息",
      "composer.placeholder": "问问这本书…",
      "tile.naive": "朴素",
      "tile.real": "实际",
      "tile.est": "估",
      "tile.saved": "省下",
      "tile.unlocked": "得以可能",
      "tile.wontFit": "根本装不下 ✗",
      "tile.pct": "朴素的{pct}%",
      "tile.payingBack": "正在回本",
      "tile.noTurn": "还没有一轮",
      "tile.unlockedSub": "朴素做法不可能\u00a0— 没有可减的对象",
      "cost.breakdown": "明细",
      "cost.hide": "收起",
      "theme.dark": "深色",
      "theme.light": "浅色",
      "regime.fits-budget.heading": "小到什么都不会发生",
      "regime.budget-compact.heading": "整本送出，在你的第一个问题时折叠",
      "regime.oversize-fold.heading": "大到根本送不出去\u00a0— 载入时就折叠",
      "regime.cost-gated.heading": "点击之前值得先看价格",
      "shelf.books.one": "1 本",
      "shelf.books.many": "{n} 本",
      "plan.fits": "整本装进工作预算",
      "plan.compacts": "在你的第一个问题时折叠",
      "plan.folds": "载入时折成 {n} 部分",
      "plan.noCall": "不调用摘要模型",
      "plan.call1": "约 {n} 次摘要调用 ≈ {usd}（{rate}）",
      "plan.calls": "约 {n} 次摘要调用 ≈ {usd}（{rate}）",
      "plan.callsNoRate": "约 {n} 次摘要调用 · 费用取决于模型",
      "plan.illustrative": "参考价",
      "plan.listPrice": "标价",
      "gate.title": "载入《{title}》约需 {usd}",
      "gate.go": "仍然载入 · ~{usd}",
      "gate.no": "现在不要",
      "gate.flag": "会先询问 · 超过 {usd}",
      "gate.titleTokens": "《{title}》约 {tok} token 待折叠 · ~{usd}",
      "gate.goTokens": "仍然载入 · \u2248{tok} token",
      "gate.flagTokens": "会先询问 · 超过 {tok} token",
      "greed.title": "这个问题携带约 {tok} token · ~{usd}",
      "greed.go": "仍然提问 · ≈{tok} token",
      "greed.hint": "每次检索最多约 {tok} token",
      "greed.default": "每次检索最多约 {tok} token · 默认值",
      "greed.past": "超过 {label} 的 {win} token 窗口",
      "greed.asks": "发送前会询问",
      "state.ok": "空间充裕",
      "state.warn": "接近折叠",
      "state.at": "已到预算\u00a0— 折叠后可继续",
      "state.over": "超出预算 {n} token\u00a0— 折叠后可继续",
      "status.fetching": "正在取《{title}》…",
      "status.loaded": "《{title}》已在对话里\u00a0— 问它点什么。",
      "status.cleared": "《{title}》已清空\u00a0— 再取一次，或换一本。",
    },
  };

  /* ── The runtime ───────────────────────────────────────────────── */

  let current = DEFAULT;

  const known = (code) => CODES.indexOf(String(code)) >= 0;
  const langOf = (code) => LANGS.find((l) => l.code === code) || LANGS[0];

  function setLang(code) {
    current = known(code) ? String(code) : DEFAULT;
    return current;
  }

  const lang = () => current;

  /** `{name}` → vars.name; a placeholder with no value is left as it is */
  function fill(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) =>
      (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  }

  /**
   * The translation for `key`, or `fallback` — which is the English, written
   * where the gate can see it. Missing keys are therefore invisible rather than
   * loud, and `en` never looks anything up at all.
   */
  function t(key, fallback, vars) {
    const table = current === DEFAULT ? null : I18N[current];
    const hit = table && Object.prototype.hasOwnProperty.call(table, key)
      ? table[key] : null;
    const text = typeof hit === "string" && hit ? hit : (fallback === undefined ? key : fallback);
    return fill(text, vars);
  }

  /* ── Applying it to markup ─────────────────────────────────────────
     English stays in the HTML, so the element's own content is the fallback and
     `en` is a no-op walk. Three attributes, because three things need saying:
     text, markup (the lede carries a code span), and an attribute (a
     placeholder, an accessible name). ── */

  function applyDom(root) {
    const scope = root || global.document;
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll("[data-i18n]").forEach((n) => {
      if (n.dataset.i18nEn === undefined) n.dataset.i18nEn = n.textContent;
      n.textContent = t(n.dataset.i18n, n.dataset.i18nEn);
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((n) => {
      if (n.dataset.i18nEnHtml === undefined) n.dataset.i18nEnHtml = n.innerHTML;
      n.innerHTML = t(n.dataset.i18nHtml, n.dataset.i18nEnHtml);
    });
    scope.querySelectorAll("[data-i18n-ph]").forEach((n) => {
      if (n.dataset.i18nEnPh === undefined) n.dataset.i18nEnPh = n.placeholder || "";
      n.placeholder = t(n.dataset.i18nPh, n.dataset.i18nEnPh);
    });
    scope.querySelectorAll("[data-i18n-label]").forEach((n) => {
      if (n.dataset.i18nEnLabel === undefined) {
        n.dataset.i18nEnLabel = n.getAttribute("aria-label") || "";
      }
      n.setAttribute("aria-label", t(n.dataset.i18nLabel, n.dataset.i18nEnLabel));
    });
  }

  global.DEMO_I18N = {
    LANGS, CODES, DEFAULT, I18N,
    known, langOf, setLang, lang, t, fill, applyDom,
  };
})(window);
