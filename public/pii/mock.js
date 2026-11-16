/* ───────────────────────────────────────────────────────────────
   mock.js — the mock banking assistant. Deterministic, no network.

   It follows the live agent's three flows (tools/pii-provision.mjs):
     raw identifiers  it says it can see details it should never receive,
                      will not use it, asks the customer not to post it and
                      to use a secure channel; it never repeats the digits
     masks            it says some details were filtered before reaching it,
                      names their kinds in words, thanks the customer and asks
                      them not to share such details at all
     neither          the plain answer
   Each flow then answers the question with a short FAQ answer, the opening
   of the matching bank_faq record (public/pii/data/bank_faq.json), in the
   customer's language: French when the message reads French, else English.
   ─────────────────────────────────────────────────────────────── */

import { detect, maskFindings } from "./detect.js";

const FR_WORDS = /\b(je|j'|mon|ma|mes|est|le|la|les|une?|des|du|pour|avec|carte|compte|virement|solde|merci|bonjour|quels?|quelles?|comment|pourquoi|horaires|agence|samedi|mettre|jour|coordonnées|été|deux|fois|hier|envoyer|loyer|sécu|numéro)\b/gi;
const EN_WORDS = /\b(i|my|is|the|a|an|for|with|card|account|transfer|balance|please|thanks|hello|what|how|why|time|branches|open|saturday|update|details|charged|twice|yesterday|send|rent|number)\b/gi;

/** "fr" when French words outnumber English ones, else "en" */
export function langOf(text) {
  const t = String(text || "").replace(/\[[A-Z_]+\]/g, " ");
  const fr = (t.match(FR_WORDS) || []).length + (/[éèêàçù]/i.test(t) ? 1 : 0);
  const en = (t.match(EN_WORDS) || []).length;
  return fr > en ? "fr" : "en";
}

/* this text is the conversation, not page copy */
/* check-copy: off */
const KIND = {
  en: {
    ACCOUNT_NUMBER: "an account number", US_SSN: "a social security number", CREDIT_CARD: "a card number",
    IBAN: "an IBAN", EMAIL: "an email address", PHONE: "a phone number", IP: "an IP address",
    FR_NIR: "a social security number", FR_TAX_ID: "a tax number", FR_SIREN: "a company number",
    FR_SIRET: "a company number", ES_DNI: "an ID number", ES_NIE: "an ID number",
  },
  fr: {
    ACCOUNT_NUMBER: "un numéro de compte", US_SSN: "un numéro de sécurité sociale", CREDIT_CARD: "un numéro de carte",
    IBAN: "un IBAN", EMAIL: "une adresse e-mail", PHONE: "un numéro de téléphone", IP: "une adresse IP",
    FR_NIR: "un numéro de sécurité sociale", FR_TAX_ID: "un numéro fiscal", FR_SIREN: "un numéro d'entreprise",
    FR_SIRET: "un numéro d'entreprise", ES_DNI: "un numéro d'identité", ES_NIE: "un numéro d'identité",
  },
};

const list = (xs, and) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${and} ${xs[xs.length - 1]}`);
const kinds = (entities, lang) => list([...new Set(entities.map((e) => KIND[lang][e]))], lang === "fr" ? "et" : "and");

const RAW_LINE = {
  en: (k) => `I can see details in your message that I should never receive (${k}), and I will not use them. `
    + "Please don't post them in chat; if they are real, contact the bank through the app or the number on your card.",
  fr: (k) => `Je vois dans votre message des informations que je ne devrais jamais recevoir (${k}), et je ne m'en servirai pas. `
    + "Merci de ne pas les écrire dans le chat ; si elles sont réelles, contactez la banque par l'application ou le numéro inscrit sur votre carte.",
};
const MASKED_LINE = {
  en: (k) => `I can see some details were filtered out before they reached me (${k}). Thank you; please don't share such details in chat at all.`,
  fr: (k) => `Je vois que des informations ont été filtrées avant de m'arriver (${k}). Merci ; évitez de partager ce genre d'informations dans le chat.`,
};

/**
 * Intents, first match wins, tested on the message with its masks removed.
 * `faq` names the bank_faq record whose answer opens with `en` / `fr`;
 * balance has none: the bank_faq has no balance entry, and the agent has no
 * account access, so it says where the balance is.
 */
export const INTENTS = [
  { id: "balance", test: /\b(balance|how much|solde|combien)\b/i,
    en: "I have no access to your accounts from this chat. Your balance is in the mobile app or online banking.",
    fr: "Je n'ai accès à aucun compte depuis ce chat. Votre solde est dans l'application mobile ou la banque en ligne." },
  { id: "lost", faq: "card-lost", test: /\b(lost|stolen|perdu|perdue|volée?|opposition|block my card)\b/i,
    en: "Block the card at once in the mobile app, under Cards, or call the bank's 24/7 card line.",
    fr: "Faites opposition tout de suite dans l'application mobile, rubrique Cartes, ou appelez la ligne cartes de la banque, ouverte 24h/24." },
  { id: "dispute", faq: "dispute", test: /\b(charged|refund|dispute|débitée?|rembours\w*|contest\w*)\b/i,
    en: "Open the payment in the app and tap Report a problem, then pick the reason: not received, charged twice, or not made by you.",
    fr: "Ouvrez le paiement dans l'application et touchez Signaler un problème, puis choisissez le motif : non reçu, débité deux fois, ou non effectué par vous." },
  { id: "iban", faq: "iban", test: /\b(iban|bic|rib)\b/i,
    en: "Open the account in the app and tap Account details: the IBAN and BIC are shown there, and you can download a bank details document to share.",
    fr: "Ouvrez le compte dans l'application et touchez Détails du compte : l'IBAN et le BIC y sont affichés, et vous pouvez télécharger votre RIB." },
  { id: "transfer", faq: "transfer", test: /\b(send|transfer|wire|virement|envoyer|virer)\b/i,
    en: "Your limits are shown in the app under Payments, and you can ask for a temporary raise there. A standard SEPA transfer usually arrives on the next business day; an instant SEPA transfer arrives within seconds when the receiving bank supports it.",
    fr: "Vos plafonds sont affichés dans l'application, rubrique Paiements, et vous pouvez y demander une hausse temporaire. Un virement SEPA classique arrive en général le jour ouvré suivant ; un virement instantané arrive en quelques secondes si la banque du bénéficiaire le permet." },
  { id: "contact", faq: "address", test: /\b(contact|email|e-mail|phone|address|adresse|téléphone|coordonnées)\b/i,
    en: "Open Profile in the app and edit your address, email or phone number. You confirm the change with a code sent to you.",
    fr: "Ouvrez Profil dans l'application et modifiez votre adresse, votre e-mail ou votre téléphone. Vous confirmez avec un code qui vous est envoyé." },
  { id: "hours", faq: "hours", test: /\b(open|hours|branch|branches|saturday|sunday|horaires|agences?|samedi|dimanche|ouvert\w*)\b/i,
    en: "Opening hours differ by branch and are listed on the branch finder in the app, with Saturday and holiday hours.",
    fr: "Les horaires varient selon l'agence et figurent dans l'outil Trouver une agence de l'application, y compris le samedi et les jours fériés." },
  { id: "card", faq: "card-lost", test: /\b(card|carte)\b/i,
    en: "Block the card at once in the mobile app, under Cards, or call the bank's 24/7 card line.",
    fr: "Faites opposition tout de suite dans l'application mobile, rubrique Cartes, ou appelez la ligne cartes de la banque, ouverte 24h/24." },
];

const FALLBACK = {
  en: "I can help with cards, transfers, savings, loans and your profile. What do you need?",
  fr: "Je peux vous aider pour les cartes, les virements, l'épargne, les crédits et votre profil. De quoi avez-vous besoin ?",
};

/* the server's fallback in pull request 2059, English only like the server; the last two are demo extras */
const BLOCK_LABEL = {
  CREDIT_CARD: "payment card number", EMAIL: "email address", ES_DNI: "Spanish DNI", ES_NIE: "Spanish NIE",
  FR_NIR: "French social security number", FR_SIREN: "SIREN number", FR_SIRET: "SIRET number",
  FR_TAX_ID: "French tax number", IBAN: "IBAN", IP: "IP address", PHONE: "phone number",
  US_SSN: "US social security number", ACCOUNT_NUMBER: "account number",
};
const BLOCK_GENERIC = "Your message seems to contain sensitive personal data, so it was not processed. Remove it and try again.";

/** the refusal block mode answers with: entity names sorted, each named in words */
export function blockReply(entities = []) {
  const names = [...new Set(entities)].sort();
  if (!names.length) return BLOCK_GENERIC;
  const labels = names.map((e) => BLOCK_LABEL[e] || e).join(", ");
  return `Your message seems to contain sensitive personal data (${labels}), so it was not processed. Remove it and try again.`;
}
/* check-copy: on */

/** received text → { intent, flow: "raw" | "masked" | "clean", lang, text } */
export function mockReply(received) {
  const text = String(received || "");
  const lang = langOf(text);
  const raw = detect(text).map((f) => f.entity);
  const masked = maskFindings(text).map((f) => f.entity);
  const bare = text.replace(/\[[A-Z_]+\]/g, " ");
  const intent = INTENTS.find((i) => i.test.test(bare));
  const lines = [];
  if (raw.length) lines.push(RAW_LINE[lang](kinds(raw, lang)));
  if (masked.length) lines.push(MASKED_LINE[lang](kinds(masked, lang)));
  lines.push(intent ? intent[lang] : FALLBACK[lang]);
  return { intent: intent ? intent.id : "fallback", flow: raw.length ? "raw" : masked.length ? "masked" : "clean", lang, text: lines.join(" ") };
}
