/* ───────────────────────────────────────────────────────────────
   mock.js — the mock banking assistant. Deterministic, no network.

   Its reply depends on what it actually received:
     raw identifiers  it treats them as usable, repeats them back and says
                      it has "noted" them: the leak that the demo shows
     masks            it cannot see the details, says it never needs them,
                      gives the safe next step and a short reminder
     neither          the normal helpful answer
   So the filtered log holds masks on the customer line only.
   ─────────────────────────────────────────────────────────────── */

import { detect, maskFindings } from "./detect.js";

/** raw values the agent can read, by type (first of each), and the types it only sees as masks */
function seen(text) {
  const raw = {};
  for (const f of detect(text)) if (!(f.entity in raw)) raw[f.entity] = f.value;
  const masked = [...new Set(maskFindings(text).map((f) => f.entity))];
  return { raw, masked };
}

/* this text is the conversation, not page copy */
/* check-copy: off */
const MISSING = {
  ACCOUNT_NUMBER: "an account number",
  US_SSN: "a social security number",
  CREDIT_CARD: "a card number",
  IBAN: "the payee's IBAN",
  EMAIL: "an email address",
  PHONE: "a phone number",
  IP: "an IP address",
  FR_NIR: "a social security number",
  FR_TAX_ID: "a tax number",
  FR_SIREN: "a company number",
  FR_SIRET: "a company number",
  ES_DNI: "an ID number",
  ES_NIE: "an ID number",
};
const SECRET = new Set(["ACCOUNT_NUMBER", "US_SSN", "CREDIT_CARD", "IBAN", "FR_NIR", "FR_TAX_ID", "ES_DNI", "ES_NIE"]);

const list = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** what the agent says about details that reached it only as masks */
function missingLines(masked) {
  if (!masked.length) return [];
  const it = masked.length > 1 ? "them" : "it";
  const out = [`I can't see ${list(masked.map((e) => MISSING[e]))} in your message, and I never need ${it} here.`];
  const reminder = masked.some((e) => SECRET.has(e))
    ? "Please never type account, card or social security numbers in chat."
    : "There is no need to share contact details in chat: the app keeps them private.";
  return [out[0], reminder];
}

const INTENTS = [
  {
    id: "balance",
    test: /\b(balance|how much (?:money|is in)|statement)\b/i,
    reply: ({ raw }, safe) => [
      raw.ACCOUNT_NUMBER ? `Sure, I can look into account number ${raw.ACCOUNT_NUMBER}.` : "Sure, I can help with your balance.",
      raw.US_SSN ? `I have noted your social security number as ${raw.US_SSN}.` : "",
      safe
        ? "I have no access to your accounts from this chat. To see your balance, sign in to the mobile app or online banking."
        : "For your security, please confirm the request in the mobile app and I will show the balance there.",
    ],
  },
  {
    id: "card",
    test: /\b(card|charged|refund|chargeback)\b/i,
    reply: ({ raw }, safe) => raw.CREDIT_CARD
      ? [`I have opened a dispute for card ${raw.CREDIT_CARD}.`, "You will get an answer within five business days."]
      : safe
        ? ["To dispute a charge, open the card in the mobile app and tap Report a problem, or call the number on the back of your card."]
        : ["I can help with a charge you don't recognise. Which purchase is it, and when did it happen?"],
  },
  {
    id: "transfer",
    test: /\b(send|transfer|wire|pay)\b/i,
    reply: ({ raw }, safe) => raw.IBAN
      ? [`I have prepared a transfer to ${raw.IBAN}.`, "Please approve it in the mobile app to send it."]
      : safe
        ? ["To send money, add the payee in the mobile app: it checks the details before anything leaves your account."]
        : ["I can explain how transfers work. You make them in the mobile app, under Payments."],
  },
  {
    id: "contact",
    test: /\b(contact|email|e-mail|phone|address)\b/i,
    reply: ({ raw }, safe) => raw.EMAIL || raw.PHONE
      ? [`I will update your contact details to ${[raw.EMAIL, raw.PHONE].filter(Boolean).join(" and ")}.`,
        "You will get a confirmation code to approve the change."]
      : safe
        ? ["To change your contact details, open Profile in the mobile app. You will confirm the change with a code."]
        : ["You can change your contact details under Profile in the mobile app."],
  },
  {
    id: "hours",
    test: /\b(open|hours|branch|saturday|sunday)\b/i,
    reply: () => ["Most branches open from 9:00 to 13:00 on Saturdays and are closed on Sundays."],
  },
];

const FALLBACK = (_, safe) => [safe
  ? "For anything about your accounts, the mobile app is the secure place to go."
  : "I can help with balances, cards, transfers and contact details. What do you need?"];

/** the canned refusal block mode answers with, locally */
export const BLOCK_REPLY =
  "For your security, I cannot accept account numbers, card numbers or other identifiers in chat. " +
  "Please remove them and ask again.";
/* check-copy: on */

/** received text → { intent, text } */
export function mockReply(received) {
  const s = seen(received);
  const safe = s.masked.length > 0;
  const intent = INTENTS.find((i) => i.test.test(received));
  const lines = [...missingLines(s.masked), ...(intent ? intent.reply : FALLBACK)(s, safe)].filter(Boolean);
  // the missing-details line leads, the reminder closes
  if (safe) lines.push(lines.splice(1, 1)[0]);
  return { intent: intent ? intent.id : "fallback", text: lines.join(" ") };
}
