// Redaction helpers.
//
// `tool_calls.input_summary` must be a human-readable SUMMARY, never the
// raw sensitive input verbatim. Logs must not carry PII beyond what the
// audit records legitimately need. These helpers are the single place
// that decision is implemented, so it can't drift per-tool.

/** Mask an email to its shape: `emmanuel@example.com` -> `e****l@example.com`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '[redacted-email]';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local[0] ?? '';
  const tail = local.length > 1 ? local[local.length - 1] : '';
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}${tail}@${domain}`;
}

/** Keep a person's first name, drop the rest: `Ada Lovelace` -> `Ada L.` */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (!parts.length || !parts[0]) return '[redacted-name]';
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return `${parts[0]} ${(last?.[0] ?? '').toUpperCase()}.`;
}

/**
 * Build a `tool_calls.input_summary` string from a tool's raw input.
 * IDs are safe to keep verbatim (they're the whole point of the audit
 * trail); emails and names are masked; anything unrecognised is dropped
 * rather than passed through, so a new field can't leak by accident.
 */
export function summariseToolInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === '') continue;
    const v = String(value);
    switch (key) {
      case 'customer_id':
      case 'transaction_id':
      case 'payout_id':
      case 'conversation_id':
      case 'ticket_id':
      case 'category':
      case 'priority':
      case 'event_type':
        parts.push(`${key}=${v}`);
        break;
      case 'email':
      case 'user_email':
        parts.push(`${key}=${maskEmail(v)}`);
        break;
      case 'user_name':
        parts.push(`${key}=${maskName(v)}`);
        break;
      case 'company_name':
        parts.push(`company_name=${v}`);
        break;
      case 'query':
      case 'summary':
      case 'reason':
        parts.push(`${key}="${v.slice(0, 120)}${v.length > 120 ? '…' : ''}"`);
        break;
      default:
        // Unknown field: record that it was present, not its value.
        parts.push(`${key}=<${typeof value}>`);
    }
  }
  return parts.join(' ') || '(no input)';
}

/** Strip anything credential-shaped before a string reaches a log sink. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted-anthropic-key]')
    .replace(/sk-(?:proj-)?[A-Za-z0-9]{16,}/g, '[redacted-openai-key]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => maskEmail(m));
}
