/* ───────────────────────────────────────────────────────────────
   compose-conversations.js — the offline fallback for the seeded sagas.

   The generator's preferred path is self-play against the real API: two
   personas talking to each other for a few hundred turns, so the prose is
   genuinely written rather than assembled. This file is what runs when that
   path is not available — during the build of this demo the demo key stopped
   authenticating mid-run, and a demo that cannot be built without a working
   credential is not much of a demo.

   So: authored composition, and the UI says so in those words. Every scenario
   file records which path produced it in `generated.method`, and the page
   repeats it on screen. Nothing here pretends to be model output.

   How it stays readable rather than obviously repetitive: each message is
   assembled from several independent slots — an opener, a body, a pasted
   artifact, a closing question — each drawn from its own pool, with the state
   of the thread (which day, which theory, how good the learner's German is)
   advancing underneath. The random source is seeded per scenario, so a rerun
   produces byte-identical files.
   ─────────────────────────────────────────────────────────────── */

"use strict";

/* ── A small seeded random source ─────────────────────────────────
   mulberry32: 32 bits of state, good enough for choosing sentences and
   reproducible across Node versions, which `Math.random` is not. ──── */

function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    some(arr, n) {
      const copy = arr.slice();
      const out = [];
      for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
  };
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
const join = (parts) => parts.filter(Boolean).join("\n\n");

/* ══ Scenario one · a production incident, eleven days ═════════════ */

const SUBSYS = ["ingestion-worker", "query-planner", "replica-sync", "vector-shard",
  "rate-limiter", "webhook-dispatcher", "index-builder", "cache-warmer", "auth-sidecar"];

const THEORIES = [
  { name: "the request timeout", note: "set too low for the tail of the batch" },
  { name: "the connection pool", note: "exhausted rather than slow" },
  { name: "the readiness probe", note: "passing before the process can actually serve" },
  { name: "a deprecation warning", note: "that a colleague is convinced is the cause" },
  { name: "credential rotation mid-deploy", note: "refusing long-lived connections one at a time" },
];

const PERSON_OPENERS = [
  "Still with you on this.",
  "Right, an update, and it is not the one I wanted.",
  "Short one from me tonight.",
  "Picking this back up.",
  "This got worse before it got better.",
  "Some progress, some new confusion.",
  "I have been staring at this for two hours.",
  "One more data point before I stop for the day.",
  "Bad news and a question.",
  "I think we can rule something out.",
];

/* Each body names the artifact it is about to paste, so the two cannot drift
   apart. A message that says "the pool metrics are attached" and then attaches a
   configuration file is the tell that a transcript was assembled rather than
   written. */
const PERSON_BODIES = [
  { kind: "log", text: (s) => `The ${s.sys} came back about ${s.mins} minutes after the deploy ` +
    `went out, same as before. What is different this time is the shape of it: latency climbs ` +
    `steadily rather than stepping, and the error rate only follows about ${s.lag} seconds ` +
    `later. If it were ${s.theory.name} I would expect those two to move together, and they do ` +
    `not. The tail of the log is below.` },
  { kind: "log", text: (s) => `I did what you asked and ran the same batch at a third of the ` +
    `concurrency. It still failed, ${s.mins} minutes in, which I think means we can stop ` +
    `blaming load. The ${s.sys} is the only component that reports degraded, but the ` +
    `${s.other} logs a handful of refused connections at the same moment, and I do not know ` +
    `which of those is the cause and which is the symptom. Judge for yourself:` },
  { kind: "config", text: (s) => `We rolled back to the previous release and it held for ` +
    `${s.hours} hours, so it is something in this deploy. I diffed the two and the only ` +
    `meaningful change is in how the ${s.sys} builds its client. Here are the relevant lines. ` +
    `I might be reading too much into them.` },
  { kind: "log", text: (s) => `My colleague is now convinced this is ${s.theory.name}, ` +
    `${s.theory.note}. I am not sure, and I would rather not spend another day on it if you can ` +
    `rule it out from your side. Here is the evidence they are working from.` },
  { kind: "timeline", text: (s) => `Raised it to ${s.timeout} seconds as suggested. Same ` +
    `failure, ${s.mins} minutes in, except now the failing requests sit for the full ` +
    `${s.timeout} seconds before giving up, so we have made the symptom slower rather than ` +
    `smaller. I do not think ${s.theory.name} is it. Tonight's sequence, to the minute:` },
  { kind: "timeline", text: (s) => `Something I should have mentioned earlier and did not think ` +
    `mattered: our deploy rotates the service credentials as its last step. That is ${s.mins} ` +
    `minutes before the first failures, give or take, and it lines up better than anything else ` +
    `we have looked at. Laid out in order:` },
  { kind: "log", text: (s) => `The pool numbers are in the log lines below. In-use climbs to ` +
    `${s.pool} and stays there, and the wait queue grows the whole time without ever draining. ` +
    `On the previous release the same batch never took the pool past ` +
    `${Math.max(2, s.pool - 9)}.` },
  { kind: "config", text: (s) => `I want to write down what we are actually running, mostly for ` +
    `my own sake, because I have lost track of which settings we have changed and which we only ` +
    `talked about. This is the live configuration for the ${s.sys} as of tonight.` },
];

const PERSON_QUESTIONS = [
  "What would you look at next?",
  "Is there anything on your side that would show the connections being refused rather than timing out?",
  "Can you confirm whether that is expected behaviour?",
  "Should I keep the rollback in place overnight, or try one more thing?",
  "Am I reading this the wrong way round?",
  "Is it worth escalating this now, or is there something cheaper to try first?",
  "What do you need from me to make this reproducible on your side?",
  "Does that log line mean what I think it means?",
];

function logBlock(rng, s, lines) {
  const levels = ["INFO", "WARN", "WARN", "ERROR", "WARN", "INFO"];
  const messages = [
    "connection acquired after wait",
    "pool wait exceeded soft limit",
    "upstream closed connection during read",
    "retry scheduled with backoff",
    "credential refresh returned 401, retrying once",
    "readiness reported ok while queue non-empty",
    "batch partially applied, rolling forward",
    "handshake refused by peer",
    "request abandoned by client",
    "shard reported degraded, draining",
  ];
  const out = [];
  for (let i = 0; i < lines; i++) {
    const t = s.baseSecond + i * rng.int(2, 9);
    out.push(
      `2026-07-${pad(10 + s.day)} ${pad(s.hour)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}Z ` +
      `${rng.pick(levels)} ${s.sys}[pid ${1000 + rng.int(100, 899)}] ` +
      `req=${s.reqPrefix}${pad(rng.int(0, 9999), 4)} ` +
      `batch=${s.batch + i} latency=${rng.int(180, 4200)}ms ` +
      `pool=${rng.int(1, s.pool)}/${s.pool} retries=${rng.int(0, 3)} ` +
      `state=${rng.pick(["ok", "degraded", "degraded", "draining"])} ` +
      `msg="${rng.pick(messages)}"`);
  }
  return out.join("\n");
}

function configBlock(rng, s) {
  return [
    "# the only part of the deploy diff that touches this component",
    `${s.sys}:`,
    `  pool:`,
    `    max_connections: ${s.pool}`,
    `    acquire_timeout_ms: ${s.timeout * 1000}`,
    `    max_lifetime_s: ${rng.pick([300, 600, 900, 3600])}`,
    `  readiness:`,
    `    path: /healthz`,
    `    initial_delay_s: ${rng.int(2, 10)}`,
    `    period_s: ${rng.int(5, 15)}`,
    `  credentials:`,
    `    source: ${rng.pick(["vault", "env", "vault"])}`,
    `    rotate_on_deploy: true`,
  ].join("\n");
}

function timelineBlock(rng, s) {
  const t0 = s.hour * 60;
  const rows = [
    ["deploy started", 0],
    ["rolling restart complete", rng.int(2, 5)],
    ["readiness green on all replicas", rng.int(4, 7)],
    ["credentials rotated", rng.int(5, 9)],
    ["first elevated latency", s.mins],
    ["first client-visible error", s.mins + rng.int(1, 3)],
    ["error rate above alert threshold", s.mins + rng.int(3, 8)],
    ["manual restart, service recovers", s.mins + rng.int(9, 20)],
  ];
  return rows.map(([what, m]) =>
    `${pad(Math.floor((t0 + m) / 60) % 24)}:${pad((t0 + m) % 60)}  ${what}`).join("\n");
}

const AGENT_QUOTE = [
  (line) => `Taking the line you pasted first — \`${line}\` — that is the piece that matters, and ` +
    `it is not saying what I assumed it was saying yesterday.`,
  (line) => `The one I keep coming back to is \`${line}\`. Read it next to the timestamps in your ` +
    `timeline and the ordering is the wrong way round for the theory we were holding.`,
  (line) => `Before anything else: \`${line}\`. That is a refusal, not a timeout. The difference ` +
    `matters because a refusal is instant and a timeout is not, and everything in your latency ` +
    `graph is consistent with instant.`,
  (line) => `I want to be careful with \`${line}\`, because it appears on healthy deploys too. On ` +
    `its own it is noise; alongside the rest of what you sent, it is not.`,
];

const AGENT_BODIES = [
  (s) => `What that pattern usually means is that the ${s.sys} is losing its connections one at a ` +
    `time rather than all at once, which is why the failure looks gradual and why restarting ` +
    `clears it. The ${s.mins}-minute delay is the age of the oldest connection in the pool, ` +
    `not a threshold anywhere in the configuration.`,
  (s) => `I was wrong about ${s.theory.name} and I should say so plainly. Your test at a third of ` +
    `the concurrency rules it out: if the limit were the cause, the smaller batch would have ` +
    `survived. It did not, so the cause is time-based rather than load-based, and that is a ` +
    `different family of problem.`,
  (s) => `I have checked our side for the window you gave me. We see the same requests arriving ` +
    `and being answered, so nothing is being dropped in transit. What we do see is a burst of ` +
    `authentication failures from your app id, ${s.auth} of them inside two minutes, each ` +
    `followed by a successful retry. That burst starts before your first client-visible error.`,
  (s) => `Your colleague's theory is worth taking seriously and I do not think it holds. That ` +
    `warning is emitted by every client on this version, including ones with no failures at ` +
    `all, and it is written at startup rather than during the incident. I would rather rule it ` +
    `out with evidence than with an opinion, so here is what to look for.`,
  (s) => `Here is where I think we are, and what I have handed to the ${s.team} team along with ` +
    `your logs. Their view of the network layer is better than mine, and the question I have ` +
    `asked them is narrow: whether a rotated credential invalidates connections that are ` +
    `already open.`,
  (s) => `Ruled out so far, and why each one is out rather than merely unlikely. I am writing ` +
    `this list because we have both lost track of it, and because the next person who reads ` +
    `this thread should not have to re-derive it.`,
];

const AGENT_STEPS = [
  ["Run the same batch with the pool capped at four connections", "if the failure arrives sooner, the age of the connections is the variable"],
  ["Capture the pool's in-use count once a second for the whole window", "the shape of that curve separates exhaustion from refusal"],
  ["Turn off credential rotation for one deploy only", "this is the cheapest way to test the theory and the easiest to undo"],
  ["Send me the request ids for three failures and three successes in the same minute", "I can trace them from our side and compare"],
  ["Set the connection max lifetime below the rotation interval", "if this is the cause, the failure disappears entirely"],
  ["Keep the rollback in place overnight", "we lose a day, and we do not lose the evening"],
  ["Check whether the readiness probe touches the same pool the traffic uses", "if it does not, green means nothing here"],
  ["Re-run with debug logging on the client only", "the server side already has what we need"],
];

const AGENT_CLOSERS = [
  (s) => `I will have an answer from the ${s.team} team by tomorrow afternoon and I will write ` +
    `here either way, including if the answer is that they need more.`,
  () => `Nothing to do tonight. I would rather you slept and we did this properly in the morning.`,
  (s) => `I am keeping this ticket open at the current priority. If it recurs before we have the ` +
    `fix, page us — the on-call has this thread bookmarked.`,
  () => `If the next run behaves differently in any way, send the logs even if it looks like an ` +
    `improvement. An improvement we cannot explain is still a symptom.`,
];

function composeDeploy(rng, i, t, chapterIndex) {
  const day = Math.min(11, 1 + Math.floor(t * 11));
  const s = {
    day,
    hour: rng.int(8, 22),
    sys: SUBSYS[(chapterIndex * 3 + i) % SUBSYS.length],
    other: rng.pick(SUBSYS),
    theory: THEORIES[Math.min(THEORIES.length - 1, chapterIndex)],
    mins: rng.int(3, 14),
    lag: rng.int(20, 90),
    hours: rng.int(6, 30),
    timeout: rng.pick([30, 45, 60, 90, 120]),
    pool: rng.int(12, 48),
    auth: rng.int(11, 240),
    batch: rng.int(1000, 90000),
    baseSecond: rng.int(0, 3000),
    reqPrefix: rng.pick(["r-", "req-", "q"]),
    team: rng.pick(["networking", "platform runtime", "identity"]),
  };

  const body = rng.pick(PERSON_BODIES);
  const artifact = body.kind === "config" ? configBlock(rng, s)
    : body.kind === "timeline" ? timelineBlock(rng, s)
      : logBlock(rng, s, rng.int(11, 19));

  const person = join([
    `${rng.pick(PERSON_OPENERS)} ${body.text(s)}`,
    artifact,
    rng.pick(PERSON_QUESTIONS),
  ]);

  const quoted = artifact.split("\n")[rng.int(0, Math.min(4, artifact.split("\n").length - 1))]
    .slice(0, 96).trim();
  const steps = rng.some(AGENT_STEPS, rng.int(3, 4))
    .map(([what, why], n) => `${n + 1}. ${what} — ${why}.`).join("\n");

  const agent = join([
    rng.pick(AGENT_QUOTE)(quoted),
    rng.pick(AGENT_BODIES)(s),
    steps,
    rng.pick(AGENT_CLOSERS)(s),
  ]);

  return { person, agent };
}

/* ══ Scenario two · building a world out loud ══════════════════════ */

const TIDE_MOTIFS = ["the tide clocks", "the settling of the floating quarter", "the guild quarrel",
  "the salt liturgy", "the naming of the channels", "the long ebb", "the harbour rights",
  "the apprentice year", "the drowned market", "the reading of the gauges"];

const GUILDS = ["Tidewrights", "Gaugers", "Salters of the Second Basin", "Keel-Chandlers",
  "Almanackers", "Bell-Wardens", "Channel Pilots", "Marrow Guild", "Wrackfolk"];

const TIDE_WORDS = [
  ["ebb-hand", "the person who reads the gauge on a falling tide"],
  ["settle", "the hour a floating quarter comes to rest on the mud"],
  ["overslack", "a tide that fails to turn when the clocks say it should"],
  ["wrack-right", "the claim a family has to whatever the ebb leaves on its stretch"],
  ["bell-lag", "the gap between the clock's bell and the water's actual turn"],
  ["dry-mouth", "a channel that has silted past navigation"],
  ["saltmark", "the line on a wall that records the highest water anyone remembers"],
  ["counting-house", "not a bank; the room where the almanack is calculated"],
];

const WRITER_OPENERS = [
  "Right, I could not sleep and I think I have it.",
  "This might be nothing but hear me out.",
  "I went back over what we said last time and one thing is bothering me.",
  "New idea, probably too much.",
  "I wrote a paragraph. It is not good yet but the thing underneath it is.",
  "Can I throw a list at you.",
  "I want to argue with you about something you said.",
  "I have been thinking about this on the train all week.",
  "Forget what I said about the map. Or do not, but hear this first.",
  "Small thing, and then a large thing.",
];

/* Same rule as the support thread: the body names what it is about to paste. */
const WRITER_BODIES = [
  { kind: "prose", text: (s) => `What if ${s.motif} is not an institution at all but a habit — ` +
    `something everyone does without anyone being in charge of it. The moment I make it a guild ` +
    `it becomes a story about bureaucracy, and I do not want a book about bureaucracy. But the ` +
    `moment it is only a habit I lose the thing that can be corrupted, and I do want that. This ` +
    `is roughly the feeling I am after:` },
  { kind: "names", text: (s) => `The ${s.guild} keep growing in my head and I cannot tell whether ` +
    `that is because they are interesting or because they are easy. They have the clocks, they ` +
    `have the apprentices, they have a reason to lie about ${s.motif}. That is three engines in ` +
    `one body and it feels like cheating. Here is everyone who currently has a claim:` },
  { kind: "prose", text: () => `I want the water to be a character without ever describing it as ` +
    `one. So: no personification, no "the sea remembered", none of that. Instead everything ` +
    `about the people is shaped by it — how they count, what they call a week, which direction ` +
    `means "soon". If I do that properly I never have to say the sea is alive and the reader ` +
    `will think it anyway. Like this, I hope:` },
  { kind: "prose", text: () => `Here is the fragment. It is doing the thing where the prose is ` +
    `prettier than the idea, which usually means I do not know what happens yet.` },
  { kind: "glossary", text: () => `A glossary is a confession. Every word I have to define is a ` +
    `place where I have not made the thing clear in the scene. But I also love them, so here are ` +
    `some, and you can tell me which three are load-bearing and which are decoration.` },
  { kind: "names", text: (s) => `The disagreement we are having about the map is really a ` +
    `disagreement about scale. You think a map fixes the world too early. I think without one ` +
    `the reader cannot feel how far ${s.distance} miles of exposed seabed actually is. We are ` +
    `both right and it is annoying. Meanwhile the names keep multiplying, which is its own ` +
    `argument for a map:` },
  { kind: "glossary", text: () => `I think the novella is the one where a clock is wrong. Not ` +
    `broken — wrong, and trusted. Everything else in the world I have built exists to make that ` +
    `a catastrophe rather than an inconvenience. These are the words the story needs and no ` +
    `others:` },
];

const WRITER_QUESTIONS = [
  "Which of those would you keep?",
  "Does that contradict what we decided about the almanack?",
  "Is this too neat?",
  "Give me the version of this that is worse but truer.",
  "What am I avoiding here?",
  "Would you read a book with that in the first chapter?",
  "Tell me if I have used that name already, I have lost count.",
  "Which one of these is the actual story?",
];

function prosePassage(rng, s) {
  const bits = [
    `The bell went at the wrong hour and nobody moved.`,
    `${s.name} had read the gauge since she was nine and had never once said a number she did not believe.`,
    `On the third day of the long ebb the market stood on ground that had been sea inside living memory.`,
    `You could tell an ${rng.pick(["ebb-hand", "almanacker", "pilot"])} by the salt line on their cuff.`,
    `The floating quarter came down onto the mud the way a tired animal lies: slowly, and all at once.`,
    `There were four bells that mattered and one of them was a lie.`,
    `Her father's saltmark was still on the wall, a foot above where the water now bothered to come.`,
    `Nobody in the counting-house had seen the sea in eleven years, which was considered a qualification.`,
  ];
  return rng.some(bits, rng.int(3, 5)).join(" ");
}

function glossaryBlock(rng) {
  return rng.some(TIDE_WORDS, rng.int(4, 6))
    .map(([w, d]) => `${w} — ${d}`).join("\n");
}

function nameListBlock(rng) {
  return rng.some(GUILDS, rng.int(5, 7)).map((g, i) => `${i + 1}. the ${g}`).join("\n");
}

const COLLAB_RECAPS = [
  (s) => `Established, before we add anything: ${s.motif} is public, the almanack is not, and the ` +
    `${s.guild} inherited the right to calculate it rather than earning it. Two sittings ago you ` +
    `also said the bells are rung by children, which I have kept because it is the best detail ` +
    `in the world so far.`,
  (s) => `Careful — this contradicts something. You had the ${s.guild} unable to read the gauges ` +
    `themselves, which was the whole reason they need the ebb-hands. If they can read them now, ` +
    `the quarrel loses its engine.`,
  (s) => `That is the first version of this idea that has a cost attached to it, which is why it ` +
    `works and the last three did not.`,
  (s) => `I would keep two of those and lose the rest, and I would lose them for the same reason: ` +
    `they name a thing the reader will already have understood from the scene.`,
];

const COLLAB_OPTIONS = [
  ["Make it a habit that a guild is trying to become the owner of", "the corruption is the plot, not the background"],
  ["Give the clocks a maintenance cost only one family can pay", "inheritance does the work an institution would have done"],
  ["Let the almanack be public and the method secret", "everyone can check the answer and nobody can check the working"],
  ["Put the error in the bell rather than the calculation", "a mechanical fault is harder to blame anyone for, which is worse"],
  ["Keep the map out of the front matter and let a character draw one badly", "the reader gets the scale and the unreliability at once"],
  ["Name only what people argue about", "the glossary shrinks to the things that matter"],
  ["Tell it from the apprentice who is not told", "the reader learns the world at the speed she does"],
];

const COLLAB_CLOSERS = [
  () => `Send me the next fragment before you fix it. I want to see it while it is still wrong.`,
  (s) => `I have added ${s.motif} to the running list. That list is now longer than the outline, ` +
    `which is either a good sign or a warning.`,
  () => `Do not decide tonight. Two of these are the same idea wearing different coats and we will ` +
    `see which one in a week.`,
  () => `Write the scene, not the system. If the system is wrong the scene will tell you.`,
];

function composeTide(rng, i, t, chapterIndex) {
  const s = {
    motif: TIDE_MOTIFS[(chapterIndex * 2 + i) % TIDE_MOTIFS.length],
    guild: rng.pick(GUILDS),
    name: rng.pick(["Ise", "Marrow", "Callet", "Wren Ottick", "the ebb-hand Sella", "old Farrow"]),
    distance: rng.int(3, 19),
  };

  const body = rng.pick(WRITER_BODIES);
  const artifact = body.kind === "glossary" ? glossaryBlock(rng)
    : body.kind === "names" ? nameListBlock(rng)
      : prosePassage(rng, s);

  const person = join([
    `${rng.pick(WRITER_OPENERS)} ${body.text(s)}`,
    artifact,
    rng.pick(WRITER_QUESTIONS),
  ]);

  const options = rng.some(COLLAB_OPTIONS, rng.int(2, 3))
    .map(([what, why], n) => `${n + 1}. ${what} — ${why}.`).join("\n");

  const agent = join([
    rng.pick(COLLAB_RECAPS)(s),
    options,
    rng.chance(0.45) ? `In the world's own voice, so you can hear whether it holds: “${prosePassage(rng, s)}”` : null,
    rng.pick(COLLAB_CLOSERS)(s),
  ]);

  return { person, agent };
}

/* ══ Scenario three · fourteen months of evening German ════════════ */

/* [correct, the learner's version, the rule that explains the difference]. The
   rule travels with the sentence rather than being drawn separately: a
   correction paired with somebody else's rule is worse than no correction. */
const GERMAN_SENTENCES = [
  ["Ich habe gestern mit meiner Schwester telefoniert.",
    "Ich habe gestern mit meine Schwester telefoniert.",
    "mit always takes the dative, so meine becomes meiner"],
  ["Wir sind am Wochenende in die Berge gefahren.",
    "Wir haben am Wochenende in die Berge gefahren.",
    "fahren is a verb of motion, so its perfect takes sein rather than haben"],
  ["Der Zug ist wegen des Schnees ausgefallen.",
    "Der Zug ist wegen dem Schnee ausgefallen.",
    "wegen takes the genitive in careful written German — dem is what people say, des is what you write"],
  ["Ich freue mich auf den Sommer.",
    "Ich freue mich auf dem Sommer.",
    "sich freuen auf points forward to something, and that auf takes the accusative"],
  ["Nach der Arbeit gehe ich meistens schwimmen.",
    "Nach die Arbeit ich gehe meistens schwimmen.",
    "two things: nach takes the dative, and the conjugated verb stays in second position whatever comes first"],
  ["Kannst du mir bitte helfen?",
    "Kannst du mich bitte helfen?",
    "helfen takes a dative object — one of the handful you simply have to learn"],
  ["Sie hat mir das Buch empfohlen, das ich jetzt lese.",
    "Sie hat mir das Buch empfohlen, was ich jetzt lese.",
    "das as a relative pronoun points back to a neuter noun; was is for a whole clause"],
  ["Wenn ich mehr Zeit hätte, würde ich jeden Tag lesen.",
    "Wenn ich mehr Zeit habe, würde ich jeden Tag lesen.",
    "the unreal conditional needs the subjunctive in both halves, not just the würde half"],
  ["Ich wohne seit drei Jahren in dieser Stadt.",
    "Ich wohne seit drei Jahre in diese Stadt.",
    "seit takes the dative, so Jahre becomes Jahren, and in with no movement takes the dative too"],
  ["Das ist der Mann, dem ich geholfen habe.",
    "Das ist der Mann, den ich geholfen habe.",
    "the relative pronoun takes the case its own clause needs — helfen wants dative, so dem"],
  ["Ich bin müde, weil ich schlecht geschlafen habe.",
    "Ich bin müde, weil ich habe schlecht geschlafen.",
    "weil sends the conjugated verb to the end of its clause"],
  ["Wir treffen uns um halb acht vor dem Kino.",
    "Wir treffen uns um halb acht vor das Kino.",
    "vor with a location and no movement takes the dative"],
  ["Sie interessiert sich für alte Sprachen.",
    "Sie interessiert sich für alten Sprachen.",
    "a plural accusative with no article takes the strong ending: alte, not alten"],
  ["Ich habe den Film schon zweimal gesehen.",
    "Ich habe der Film schon zweimal gesehen.",
    "the object of sehen is accusative, so der becomes den"],
  ["Es gibt hier keinen guten Kaffee.",
    "Es gibt hier kein guter Kaffee.",
    "es gibt takes an accusative object, and the adjective follows kein into the weak ending"],
  ["Trotz des Regens sind wir spazieren gegangen.",
    "Trotz dem Regen sind wir spazieren gegangen.",
    "trotz takes the genitive, same family as wegen"],
];

const LEARNER_OPENERS = [
  (s) => `${s.date}. Good week, I think — I did four evenings out of five.`,
  (s) => `${s.date}. Not much this week, sorry. Work.`,
  (s) => `${s.date}. Something clicked and I do not entirely trust it.`,
  (s) => `${s.date}. I am back. Two weeks off and I have forgotten the plurals.`,
  (s) => `${s.date}. Short one, but I did the reading.`,
  (s) => `${s.date}. I had a small victory and I want to tell someone about it.`,
  (s) => `${s.date}. This is the week I stop pretending I understand the dative.`,
];

const LEARNER_BODIES = [
  (s) => `I read ${s.pages} pages of the novel and understood most of it without the dictionary, ` +
    `which has not happened before. The bits I lost were all the same kind of thing — long ` +
    `sentences where the verb is miles from its subject and I run out of memory before I get ` +
    `there.`,
  () => `I keep making the same mistake with the perfect tense and I can hear myself doing it now, ` +
    `which I suppose is progress of a sort. Knowing and not-yet-doing seem to be different ` +
    `skills.`,
  (s) => `Overheard on the tram: “${s.overheard}”. I got about two thirds of it and I have been ` +
    `chewing on the rest all week. Is that a normal thing to say?`,
  () => `I tried writing without translating in my head first. The result is shorter and worse, ` +
    `and it felt completely different to do, so I am going to keep at it.`,
  (s) => `Vienna was humbling. I said about forty sentences out loud over the week and ` +
    `${s.understood} of them were understood on the first attempt. Nobody switched to English, ` +
    `which I am choosing to take as a compliment.`,
  () => `The words I keep losing, written out so I stop pretending I know them: Gelegenheit, ` +
    `zuverlässig, verzichten, ausgerechnet, beziehungsweise, allerdings. Every one of them I ` +
    `recognise and cannot produce.`,
];

const LEARNER_QUESTIONS = [
  "Corrections please, and be blunt.",
  "Which of these is the mistake worth fixing first?",
  "Is that rule or is that just what people say?",
  "What should I read after this one?",
  "Can we do the case tables again, differently this time?",
  "Am I ready for something harder, or is that vanity?",
];

function homeworkBlock(rng, t, count) {
  // The error rate falls as the thread goes on: month one is mostly wrong,
  // month fourteen is right with the occasional slip.
  const errorRate = Math.max(0.08, 0.72 - t * 0.6);
  return rng.some(GERMAN_SENTENCES, count)
    .map(([right, wrong], i) => `${i + 1}. ${rng.chance(errorRate) ? wrong : right}`)
    .join("\n");
}

const TUTOR_PRAISE = [
  "Your word order is genuinely better than it was a month ago — the verb is landing where it should even in the long sentences.",
  "Two of those are perfect, and one of them is a sentence you would not have attempted in the spring.",
  "You are making harder mistakes now, which is the good kind of plateau.",
  "The reading is showing: your vocabulary is running ahead of your grammar, which is the right way round.",
  "Nothing wrong with the cases this week. I have gone looking and I cannot find one.",
];

const TUTOR_EXERCISES = [
  "Ten sentences with wegen, trotz and während, all genitive, all about your week.",
  "Rewrite the paragraph you sent, putting a different element first in each sentence. Same content, new emphasis.",
  "Five sentences in the unreal conditional about things you will not do.",
  "Take the first page of the next chapter and mark every relative pronoun. Do not translate it.",
  "Twenty minutes of listening with no text, then write down three things you are sure you heard.",
  "The dative verbs, in sentences, one each: helfen, danken, gratulieren, folgen, gehören, passen.",
];

function composeGerman(rng, i, t, chapterIndex) {
  const month = Math.min(14, 1 + Math.floor(t * 14));
  const s = {
    date: `${pad(rng.int(1, 28))}.${pad(Math.min(12, 1 + ((month + 2) % 12)))}.20${25 + (month > 10 ? 1 : 0)}`,
    pages: rng.int(3, 40),
    understood: rng.int(9, 34),
    overheard: rng.pick([
      "Das hätte ich dir auch sagen können.",
      "Na, dann eben nicht.",
      "Ich komm da einfach nicht weiter.",
      "Kannst du mir das noch mal in Ruhe erklären?",
      "Das ist mir ehrlich gesagt zu kompliziert.",
    ]),
  };

  const person = join([
    `${rng.pick(LEARNER_OPENERS)(s)} ${rng.pick(LEARNER_BODIES)(s)}`,
    homeworkBlock(rng, t, rng.int(5, 9)),
    rng.pick(LEARNER_QUESTIONS),
  ]);

  const corrections = rng.some(GERMAN_SENTENCES, rng.int(3, 5))
    .map(([right, wrong, rule], n) => `${n + 1}. ${wrong}\n   → ${right}\n   ${rule}.`)
    .join("\n");

  const agent = join([
    `Month ${month}, and the corrections are getting shorter. ${rng.pick(TUTOR_PRAISE)}`,
    corrections,
    `Next: ${rng.pick(TUTOR_EXERCISES)}`,
    rng.chance(0.4)
      ? `One thing to carry into next week: read the sentence out loud before you decide it is ` +
        `finished. Half of what is left is audible rather than visible.`
      : null,
  ]);

  return { person, agent };
}

/* ══ The public shape ═════════════════════════════════════════════ */

const COMPOSERS = {
  "deploy-escalation": composeDeploy,
  "tidewrights": composeTide,
  "german-by-post": composeGerman,
};

/**
 * Compose one chapter's worth of exchanges. `t` runs 0→1 across the whole
 * scenario, which is what lets a support thread escalate and a learner improve.
 */
function composeChapter(scenario, chapter, chapterIndex, chapterCount, seed) {
  const composer = COMPOSERS[scenario.slug];
  if (!composer) throw new Error(`no offline composer for ${scenario.slug}`);
  const rng = makeRng(seed);
  const out = [];
  let chars = 0;
  for (let i = 0; i < chapter.exchanges; i++) {
    const t = (chapterIndex + (i + 0.5) / chapter.exchanges) / chapterCount;
    const { person, agent } = composer(rng, i, t, chapterIndex);
    out.push({ speaker: "person", text: person });
    out.push({ speaker: "agent", text: agent });
    chars += person.length + agent.length;
    if (chars >= chapter.chars) break;
  }
  return out;
}

module.exports = { makeRng, composeChapter, COMPOSERS };
