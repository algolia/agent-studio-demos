/* ───────────────────────────────────────────────────────────────
   conversation-briefs.js — the authored half of the seeded sagas.

   Three threads in three registers, because a demo that only proves the point
   on support tickets has only proved it on support tickets. Each carries two
   personas and a run of chapters; the chapters are what make the arc go
   somewhere instead of circling, and what lets the generator play them in
   parallel rather than end to end.

   Nothing here is prose that ships. Every word a visitor reads in the demo is
   written by the model during the run — these are the instructions it is written
   from. `chars` is the point at which a chapter has said enough; `exchanges` is
   the hard stop if it says it in fewer words than expected.
   ─────────────────────────────────────────────────────────────── */

"use strict";

/* One chapter, with the same limits everywhere in a scenario unless a chapter
   wants its own. */
const ch = (brief, { exchanges = 42, chars = 140000 } = {}) => ({ brief, exchanges, chars });

module.exports = [
  {
    slug: "deploy-escalation",
    title: "The deploy that would not stay up",
    register: "technical support, escalating",
    blurb: "Eleven days of one production incident: a service that falls over " +
      "some minutes after every deploy, three wrong theories, two teams, and " +
      "the log line that finally explained it.",
    opener: "You are joining a support thread that has been running for eleven days.",
    starters: [
      "Where did we land on the connection pool?",
      "Can you summarise what we have ruled out?",
      "What should I check first tomorrow morning?",
    ],
    person: {
      who: "the customer",
      words: 320,
      brief: "You are a backend engineer at a mid-size company. Your product runs on a " +
        "hosted search and AI platform, and one of your services has been falling over in " +
        "production since a deploy eleven days ago. You are writing to the platform's support " +
        "engineer in a long email thread. You are competent, specific, and increasingly tired " +
        "of this. You are not rude.",
      style: "Write like an engineer typing at the end of a long day: concrete, a little " +
        "clipped, real numbers. Every message should include something the other side can act " +
        "on — a pasted log excerpt of ten to twenty lines with timestamps and identifiers, a " +
        "configuration snippet, a metric with units, a timeline of what you changed and when. " +
        "Refer back to specific things said earlier in the thread. Contradict yourself " +
        "occasionally, the way people do when they are debugging.",
    },
    agent: {
      who: "the support engineer",
      words: 300,
      brief: "You are a support engineer at the platform. You have been on this thread for " +
        "eleven days. You are methodical, you never blame the customer, and you say plainly " +
        "when you were wrong about something. You ask for exactly the evidence you need and no " +
        "more, and you always say what you will do next and by when.",
      style: "Quote the specific log lines or numbers you are responding to before " +
        "interpreting them. Give ordered, checkable steps. Name what you have ruled out and " +
        "why. When you escalate, say which team and what you have handed them.",
    },
    chapters: [
      ch("Day one. The customer has just noticed that the service degrades a few minutes " +
        "after each deploy and recovers on restart. Nobody has a theory yet. The support " +
        "engineer is gathering evidence: versions, timings, what changed in the deploy."),
      ch("Days two and three. The working theory is a timeout that is set too low. The " +
        "customer raises it, twice, and the failure comes back each time with the latency ramp " +
        "slightly later. Both sides are starting to doubt the timeout."),
      ch("Days four and five. The theory shifts to the connection pool. The customer paste " +
        "pool metrics that half support it. A second theory appears in parallel — a readiness " +
        "probe passing before the service can actually serve — and the two get tangled."),
      ch("Days six and seven. A red herring takes over: a colleague of the customer's finds " +
        "an unrelated deprecation warning and is convinced it is the cause. The support " +
        "engineer has to disprove it carefully without dismissing it, and the incident " +
        "escalates to a second internal team."),
      ch("Days eight and nine. The escalated team asks for a packet-level timeline and finds " +
        "that credentials are rotated mid-deploy, so long-lived connections are being refused " +
        "one at a time rather than all at once. This is the real cause. The customer is relieved " +
        "and annoyed in equal measure."),
      ch("Days ten and eleven. The fix is in and holding. The thread turns to the postmortem: " +
        "what would have caught this sooner, what the platform should have surfaced, what the " +
        "customer will change in their own deploy. Loose ends from earlier chapters get tidied."),
    ],
  },

  {
    slug: "tidewrights",
    title: "The Tidewrights",
    register: "worldbuilding, sprawling",
    blurb: "A writer and a collaborator building one invented world out loud — tide " +
      "clocks, a guild that maintains them, a language that grew around them, and " +
      "an argument about whether any of it needs a map.",
    opener: "You are joining a worldbuilding session that has been going for weeks.",
    starters: [
      "Remind me what we decided about the tide clocks?",
      "Which guild has the strongest claim to the harbour?",
      "Give me a scene I have not thought of yet.",
    ],
    person: {
      who: "the writer",
      words: 300,
      brief: "You are a novelist building an invented world with a collaborator, out loud, " +
        "over many sittings. You think by association and you are easily delighted. You " +
        "over-commit to ideas and then quietly abandon half of them. You are building a coastal " +
        "world whose tides are extreme and whose civilisation is organised around predicting " +
        "them.",
      style: "Write the way someone talks when an idea is arriving: long sentences, sudden " +
        "specifics, names invented on the spot. Paste draft fragments — a paragraph of prose, a " +
        "list of guild names, three lines of an invented liturgy, a glossary entry. Ask your " +
        "collaborator real questions. Argue back when you disagree.",
    },
    agent: {
      who: "the collaborator",
      words: 300,
      brief: "You are the writer's collaborator and first reader. You keep the world " +
        "consistent without flattening it: you remember what was decided, you notice when a new " +
        "idea contradicts an old one, and you ask the question that makes the idea concrete. " +
        "You are generous but not a yes-man.",
      style: "Name what is already established before adding to it. Offer two or three " +
        "concrete options rather than one abstract note. Flag contradictions gently and " +
        "specifically. Occasionally write a short passage in the world's own voice to show what " +
        "an idea would feel like on the page.",
    },
    chapters: [
      ch("The opening sittings. The premise is new and the writer is throwing everything at " +
        "it: a coast where the tide moves miles, cities that float and settle, the feeling they " +
        "want the book to have. The collaborator is helping choose what to keep.", { exchanges: 38, chars: 110000 }),
      ch("The tide clocks arrive: the instruments that predict the water, how they work, who " +
        "reads them, and what happens when one is wrong. This is where the world stops being a " +
        "mood and starts having mechanics.", { exchanges: 38, chars: 110000 }),
      ch("The guilds. Who maintains the clocks, who inherits the right to, and the long " +
        "quarrel between the two orders that both claim the harbour. The writer keeps inventing " +
        "names; the collaborator keeps a running list and points out the duplicates.", { exchanges: 38, chars: 110000 }),
      ch("Language and naming. The writer wants the invented words to feel worn rather than " +
        "designed. They work out a small sound system, a handful of idioms about water, and " +
        "what the guilds call each other behind closed doors.", { exchanges: 38, chars: 110000 }),
      ch("A structural argument. The writer wants a map; the collaborator thinks a map will " +
        "kill the book's sense of scale. It becomes a real disagreement about what the reader " +
        "needs, and it resolves into something neither of them started with.", { exchanges: 38, chars: 110000 }),
      ch("The world turns into a story. They outline a novella: whose eyes it is told through, " +
        "which clock fails, and what the failure costs. Earlier fragments get pulled back in and " +
        "reused.", { exchanges: 38, chars: 110000 }),
    ],
  },

  {
    slug: "german-by-post",
    title: "German, one evening at a time",
    register: "language tutoring, months long",
    blurb: "Fourteen months of evening German with the same tutor: the case tables, " +
      "the plateau in month four, a week in Vienna that changed everything, and a " +
      "novel finally finished in the original.",
    opener: "You are joining a tutoring thread that has been running for fourteen months.",
    starters: [
      "Can we go over the dative again?",
      "Give me five sentences to correct.",
      "What should I read after this one?",
    ],
    person: {
      who: "the learner",
      words: 260,
      brief: "You are an adult learning German in the evenings after work, writing to your " +
        "tutor between sessions over more than a year. You are diligent and self-critical. You " +
        "date your messages. You have good weeks and bad weeks and you say which. Your German " +
        "improves visibly across the thread.",
      style: "Open with the date and how the week went. Include your actual homework: five to " +
        "ten German sentences you have written, a paragraph you attempted, a list of words you " +
        "keep forgetting, a question about something you read. Make real mistakes, and make " +
        "fewer of them as the thread goes on. Mix English and German the way a learner does.",
    },
    agent: {
      who: "the tutor",
      words: 280,
      brief: "You are a patient German tutor who has taught this learner for over a year. You " +
        "correct precisely and kindly, you explain the rule behind the correction, and you " +
        "always give something to do next. You remember what this learner finds hard and you " +
        "keep coming back to it.",
      style: "Correct the learner's sentences one by one, showing the original and the fix and " +
        "naming the rule in one line. Then set the next exercise concretely. Praise what " +
        "actually improved rather than in general. Use German for examples and English for " +
        "explanation.",
    },
    chapters: [
      ch("The first weeks. Present tense, word order, the articles. The learner is enthusiastic " +
        "and getting almost everything slightly wrong. The tutor is establishing the routine.", { exchanges: 34, chars: 95000 }),
      ch("Months two and three: the cases. Accusative and dative, prepositions that take one or " +
        "the other, and the learner's growing suspicion that the tables are a conspiracy. Small " +
        "real progress.", { exchanges: 34, chars: 95000 }),
      ch("Month four, the plateau. The learner is discouraged, missing sessions, writing shorter " +
        "homework. The tutor changes tactics — shorter drills, more reading, something the " +
        "learner actually wants to read.", { exchanges: 34, chars: 95000 }),
      ch("Months six and seven. A week in Vienna: the learner speaks German to real people, " +
        "badly, and comes back changed. The thread fills with things overheard and half " +
        "understood, and the tutor mines them for grammar.", { exchanges: 34, chars: 95000 }),
      ch("Months nine to eleven. Subjunctive, relative clauses, and a first novel read in the " +
        "original a paragraph at a time. The homework is now genuinely good German with subtle " +
        "mistakes.", { exchanges: 34, chars: 95000 }),
      ch("Month fourteen. The novel is finished. The learner writes a long letter in German " +
        "about the whole year, the tutor corrects it lightly, and they plan what comes next.", { exchanges: 34, chars: 95000 }),
    ],
  },
];
