// Transcript redaction.
//
// The problem this solves: the system prompt can stop the AGENT repeating
// a card number back, but it cannot stop a CALLER from reading one out.
// By the time any model sees the text, the value has already been
// captured — and on this system it would land in three places in
// plaintext: the on-screen transcript, `conversation_turns.transcript`
// in Postgres, and the audit trail.
//
// So redaction happens at the boundaries, not in a prompt.
//
// Design rules:
//
//  1. FAIL TOWARD KEEPING DATA READABLE. Over-redaction destroys the
//     audit trail and makes support useless — a transcript full of
//     [redacted] cannot be reviewed. Every pattern here is either
//     checksum-verified (card numbers) or requires an explicit contextual
//     cue ("my CVV is ..."). A bare run of digits is NOT redacted.
//
//  2. LEAVE EVIDENCE. We replace with a labelled marker, never silence.
//     "[redacted: card number]" tells a reviewer that something was said
//     and caught — which is itself useful — without storing the value.
//
//  3. NEVER TOUCH BUSINESS REFERENCES. TXN-9001, PAY-7001, CUS-1001,
//     amounts and dates must survive intact or the agent cannot work.

/** What was removed. Values are never included — only the kind. */
export interface RedactionHit {
  kind: 'card_number' | 'cvv' | 'otp' | 'password' | 'iban' | 'sort_code' | 'national_id' | 'spoken_card_number';
  /** Character offset in the ORIGINAL string, for debugging. */
  at: number;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
  /** True when anything was removed — cheap check for callers. */
  redacted: boolean;
}

const LABEL: Record<RedactionHit['kind'], string> = {
  card_number: '[redacted: card number]',
  spoken_card_number: '[redacted: card number]',
  cvv: '[redacted: security code]',
  otp: '[redacted: one-time code]',
  password: '[redacted: password]',
  iban: '[redacted: bank account]',
  sort_code: '[redacted: sort code]',
  national_id: '[redacted: ID number]'
};

/**
 * Luhn checksum. This is what makes card-number detection safe to run
 * against free text: a 16-digit order reference almost never passes,
 * while every real PAN does. Without it we would have to redact any long
 * digit run and would eat legitimate references.
 */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9'
};

/**
 * Business references that must survive untouched. We mask these out
 * before scanning and restore them afterwards, so no pattern can
 * accidentally swallow the identifiers the agent needs to do its job.
 */
const PROTECTED = /\b(?:TXN|PAY|CUS|TICKET|ESC)-[A-Z0-9-]+\b/gi;

function protectReferences(text: string): { masked: string; restore: (s: string) => string } {
  const found: string[] = [];
  const masked = text.replace(PROTECTED, (m) => {
    found.push(m);
    return `\u0000REF${found.length - 1}\u0000`;
  });
  return {
    masked,
    restore: (s: string) => s.replace(/\u0000REF(\d+)\u0000/g, (_, i) => found[Number(i)] ?? '')
  };
}

/**
 * Redact secrets a caller may have spoken.
 *
 * Returns the cleaned text plus the kinds removed. Safe to call on any
 * string, including empty or undefined-ish input.
 */
export function redactTranscript(input: string | null | undefined): RedactionResult {
  const original = String(input ?? '');
  if (!original.trim()) return { text: original, hits: [], redacted: false };

  const { masked, restore } = protectReferences(original);
  const hits: RedactionHit[] = [];
  let text = masked;

  const apply = (re: RegExp, kind: RedactionHit['kind'], test?: (m: RegExpExecArray) => boolean) => {
    text = text.replace(re, (...args) => {
      const match = args[0] as string;
      const offset = args[args.length - 2] as number;
      const groups = args.slice(0, -2) as string[];
      const fake = Object.assign([...groups], { index: offset, input: text }) as unknown as RegExpExecArray;
      if (test && !test(fake)) return match;
      hits.push({ kind, at: offset });
      return LABEL[kind];
    });
  };

  // --- Card numbers: 12-19 digits with optional spaces or dashes, Luhn-checked.
  apply(
    /\b(?:\d[ -]?){11,18}\d\b/g,
    'card_number',
    (m) => luhnValid(m[0].replace(/[ -]/g, ''))
  );

  // --- Spoken digits: "four five three two one two ...". STT does not
  // always convert these. Only redact a long run (12+) that Luhn-checks,
  // so a phone number or a date read aloud survives.
  apply(
    new RegExp(`\\b(?:(?:${Object.keys(DIGIT_WORDS).join('|')})[ ,-]+){11,19}(?:${Object.keys(DIGIT_WORDS).join('|')})\\b`, 'gi'),
    'spoken_card_number',
    (m) => {
      const digits = m[0].toLowerCase().split(/[ ,-]+/).map((w) => DIGIT_WORDS[w] ?? '').join('');
      return luhnValid(digits);
    }
  );

  // --- The rest require an explicit cue. A bare 3-digit number is not a CVV.
  //
  // The separator is [^\d] (any non-digit), NOT \W (any non-word). People
  // say "the cvv IS 123" — a \W class cannot cross the letters in "is",
  // so the cue and the number never connect and the secret sails through.
  // Bounded length stops the class running on to an unrelated number.
  apply(/\b(?:cvv|cvc|cv2|security code|card code|card verification)\b[^\d]{0,14}\d{3,4}\b/gi, 'cvv');
  apply(/\b(?:otp|one[\s-]?time (?:code|passcode|password|pin)|verification code|auth(?:entication)? code|2fa code|six[\s-]digit code)\b[^\d]{0,18}\d{4,8}\b/gi, 'otp');
  apply(/\b(?:password|passphrase|pass[\s-]?code|pin(?:\s+number)?)\b\s*(?:is|was|:|=)?\s*\S{3,40}/gi, 'password');

  // --- Bank identifiers.
  apply(/\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g, 'iban',
    (m) => m[0].replace(/\s/g, '').length >= 15);
  apply(/\b(?:sort[\s-]?code\b\W{0,10})?\d{2}-\d{2}-\d{2}\b/gi, 'sort_code',
    (m) => /sort/i.test(m[0]));

  // --- US SSN shape. Requires the dashes, so a date cannot match.
  apply(/\b\d{3}-\d{2}-\d{4}\b/g, 'national_id');

  return { text: restore(text), hits, redacted: hits.length > 0 };
}

/** Convenience: just the cleaned string. */
export function redactedText(input: string | null | undefined): string {
  return redactTranscript(input).text;
}

/**
 * One-line summary of what was caught, for the audit record.
 * e.g. "redacted: card number, security code"
 */
export function describeRedactions(hits: RedactionHit[]): string | null {
  if (!hits.length) return null;
  const kinds = [...new Set(hits.map((h) => LABEL[h.kind].replace(/^\[redacted: |\]$/g, '')))];
  return `redacted: ${kinds.join(', ')}`;
}
