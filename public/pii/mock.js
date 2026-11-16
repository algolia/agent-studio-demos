/* ───────────────────────────────────────────────────────────────
   mock.js — the mock banking assistant. Deterministic, no network.

   It answers from a few canned intents and, like many real models, repeats
   back the identifiers it was given. That echo is the point: what reaches
   the model also tends to come back out, and the chat log keeps both.
   Given a mask such as [ACCOUNT_NUMBER], it repeats the mask.
   ─────────────────────────────────────────────────────────────── */

import { detect, maskFindings } from "./detect.js";

/** what the agent "sees" of each entity: the first raw value or mask, by type */
function seen(text) {
  const out = {};
  for (const f of [...detect(text), ...maskFindings(text)].sort((a, b) => a.start - b.start)) {
    if (!(f.entity in out)) out[f.entity] = f.value;
  }
  return out;
}

/* this text is the conversation, not page copy */
/* check-copy: off */
const INTENTS = [
  {
    id: "balance",
    test: /\b(balance|how much (?:money|is in)|statement)\b/i,
    reply: (s) => [
      s.ACCOUNT_NUMBER ? `Sure, I can look into account number ${s.ACCOUNT_NUMBER}.` : "Sure, I can help with your balance.",
      s.US_SSN ? `I have noted your social security number as ${s.US_SSN}.` : "",
      "For your security, please confirm the request in the mobile app and I will show the balance there.",
    ],
  },
  {
    id: "card",
    test: /\b(card|charged|refund|chargeback)\b/i,
    reply: (s) => [
      s.CREDIT_CARD ? `I have opened a dispute for card ${s.CREDIT_CARD}.` : "I have opened a dispute for your card.",
      "You will get an answer within five business days.",
    ],
  },
  {
    id: "transfer",
    test: /\b(send|transfer|wire|pay)\b/i,
    reply: (s) => [
      s.IBAN ? `I have prepared a transfer to ${s.IBAN}.` : "I have prepared the transfer.",
      "Please approve it in the mobile app to send it.",
    ],
  },
  {
    id: "contact",
    test: /\b(contact|email|e-mail|phone|address)\b/i,
    reply: (s) => [
      s.EMAIL || s.PHONE
        ? `I will update your contact details to ${[s.EMAIL, s.PHONE].filter(Boolean).join(" and ")}.`
        : "I can update your contact details.",
      "You will get a confirmation code to approve the change.",
    ],
  },
  {
    id: "hours",
    test: /\b(open|hours|branch|saturday|sunday)\b/i,
    reply: () => ["Most branches open from 9:00 to 13:00 on Saturdays and are closed on Sundays."],
  },
];

const FALLBACK = () => ["I can help with balances, cards, transfers and contact details. What do you need?"];

/** the canned refusal block mode answers with, locally */
export const BLOCK_REPLY =
  "For your security, I cannot accept account numbers, card numbers or other identifiers in chat. " +
  "Please remove them and ask again.";
/* check-copy: on */

/** received text → { intent, text } */
export function mockReply(received) {
  const s = seen(received);
  const intent = INTENTS.find((i) => i.test.test(received));
  const lines = (intent ? intent.reply : FALLBACK)(s).filter(Boolean);
  return { intent: intent ? intent.id : "fallback", text: lines.join(" ") };
}
