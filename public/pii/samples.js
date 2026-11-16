/* ───────────────────────────────────────────────────────────────
   samples.js — the "try it" strings under each type in "What it finds".

   All synthetic: reserved example domains, fictional or documentation
   phone and IP ranges, public test card numbers, registry example IBANs,
   SSNs long published as specimens. tests/pii.test.js runs every one through
   detect.js and checks its type and mask, so none is shown unflagged.
   ─────────────────────────────────────────────────────────────── */

/* check-copy: off */
export const SAMPLES = {
  EMAIL: ["billing.team@example.com", "user+alerts@example.org", "contact_42@mail.example.fr"],
  // UK drama range 07700 900xxx, US 555-01xx, an Indian mobile format
  PHONE: ["+44 7700 900123", "(202) 555-0147", "+91 98765 43210"],
  // Mastercard, Amex and JCB test numbers
  CREDIT_CARD: ["5555 5555 5555 4444", "3782 822463 10005", "3530 1113 3330 0000"],
  // registry examples: United Kingdom, France, Netherlands; compact form only
  IBAN: ["GB82WEST12345698765432", "FR1420041010050500013M02606", "NL91ABNA0417164300"],
  // the three documentation ranges, then a private address
  IP: ["192.0.2.10", "198.51.100.7", "203.0.113.254", "10.20.30.40"],
  US_SSN: ["078-05-1120", "219-09-9999", "123-45-6789"],
  ACCOUNT_NUMBER: ["account number 00123456", "acct no. 4521-8830-1127", "account # 9876543210123"],
};
/* check-copy: on */
