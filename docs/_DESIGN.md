# How these demos explain themselves

One question governs everything in this repo:

> **Could this explanation have been a visual state instead?**

Ask it of every sentence before you write it. Most of the time the answer is yes,
and the sentence should not exist.

A demo is not documentation. A reader arrives to be *shown* something — and a
paragraph explaining what they are about to see spends their attention before the
demo has earned any of it. We keep getting this wrong in the same direction: we
understand the mechanism, we find it genuinely interesting, and we write it down.
The reader does not want our understanding. They want the experience that produced
it.

## The three rules

**1. Under two minutes to read the whole page.** At 200 words per minute that is
400 words of prose. Enforced by `node scripts/check-copy.js`.

**2. Ninth grade, as a ceiling and not a target.** Measured with
Flesch–Kincaid. A crude instrument that cannot be gamed into good writing, but it
catches the thing we actually keep doing: the fifty-word sentence with three
subordinate clauses and four abstract nouns.

**3. The conversation is exempt.** These demos put whole novels into a chat —
*Ulysses* is on the shelf. What the model and the reader exchange is as hard as
literature gets, and that is the entire point. The exemption covers only the
conversation. Everything the page says *in its own voice* — headings, blurbs,
labels, tooltips — stays simple.

## Show, don't tell

Every one of these was real copy in this repo. The right-hand column is what
should have been built instead.

| Instead of writing | Show |
|---|---|
| "the digest keeps section order, so the shape of the document survives" | the sections, in order, as rows that stay in order |
| "nothing is lost — the sections are still here" | the rows, still there, clickable |
| "232,727 → 2,310 tokens" buried in a paragraph | those two numbers, large, with the bar collapsing between them |
| "up to 3 in flight at once (the map)" | three rows going from pending to done at the same time |
| "wall time is the clock on the whole fold; summarizer time is those same calls added up" | two bars, one short, one long, side by side |
| "a search costs two model steps, not one" | two steps drawn, the second visibly wider |

If a mechanism is worth explaining, it is worth animating. A state that changes in
front of someone is understood without a caption; a caption without the state
change is homework.

## Tooltips

Tooltips are opt-in depth, and that makes them the right home for a hard sentence
— the *one* hard sentence. They are not an overflow bin for prose that would not
fit on the page.

- **Forty words, maximum.** Enforced per tooltip. Past that it is an essay in a box
  that disappears when the pointer moves, which is the worst place on the page for
  anything a reader actually needs.
- **Give it hierarchy.** A lead line that answers the question, then the detail. Bold
  the number or the term being defined. A wall of forty undifferentiated words is
  still a wall.
- **One thought each.** If a tooltip has an "and also", it is two tooltips, or it is
  one tooltip and one thing you should have drawn.

## Numbers earn their place

This repo's whole claim is honest measurement, so numbers are the one thing that
should get *bigger*, not smaller. A card should lead with its figures and let the
prose fall away behind a hover:

    4 passages · ~1,436 tok · 41ms          ← the card
    why this happened, in one line          ← under it
    the mechanism                           ← in the tooltip, if at all

And keep them honest: percentages run against a 0–100% axis, an estimate says
"≈", and a figure counted from a file that ships with the page says so. A number
nobody can check is decoration.

## Running the check

```bash
node scripts/check-copy.js            # report and gate
node scripts/check-copy.js --verbose  # every long sentence and tooltip
```

It is deliberately **not** wired into CI yet, because the copy does not pass it
today: the landing page reads at grade 13.5, and several tooltips are two or three
times the length they should be. The gate exists first so the work has a target and
a way to know when it is done. Wire it into CI once it passes — a gate that has
always been red teaches nobody anything.
