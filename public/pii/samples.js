/* ───────────────────────────────────────────────────────────────
   samples.js — the "try it" strings under each type in "What it finds".

   All synthetic: reserved example domains, fictional or documentation
   phone and IP ranges, public test card numbers, registry example IBANs,
   SSNs long published as specimens, and French and Spanish numbers from the
   test file's own generator. tests/pii.test.js runs every one through
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
  // demo port, from the generator in tests/pii.test.js: own inputs, checksums computed
  FR_NIR: ["2 91 03 2A 004 123 68", "178116912304518", "2 02 06 13 055 310 12"],
  FR_TAX_ID: ["1456789012063", "02 34 567 891 495", "2987654321330"],
  FR_SIREN: ["SIREN 508 325 172", "siren: 401234562", "n° SIREN 812 345 676"],
  FR_SIRET: ["SIRET 508 325 172 00015", "siret 40123456200023", "SIRET n° 812 345 676 00132"],
  ES_DNI: ["39740125N", "87654321-X", "00451230Q"],
  ES_NIE: ["X1234567L", "Y-7654321-G", "Z0451230K"],
};
/* check-copy: on */
