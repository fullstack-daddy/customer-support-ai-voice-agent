// Email composition and sending.
//
// Two rules shape this file:
//
//  1. NOTHING SENDS AUTOMATICALLY. The agent composes a draft; a human
//     reads it, edits it if needed, and presses approve. An AI that can
//     email customers unsupervised is a liability, not a feature — and
//     the one thing you cannot un-send is an email.
//
//  2. THE DRAFT NEVER PROMISES ANYTHING. Copy here is deliberately
//     free of timelines and outcomes, because escalation-rules.md
//     forbids them and because the admin editing the draft should have
//     to ADD a commitment deliberately, never remove one by accident.

import { Resend } from 'resend';

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
}

/** Shape-check only. Real deliverability is the provider's job. */
export function isPlausibleEmail(value: unknown): boolean {
  const s = String(value ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;
}

function firstName(full: string | null | undefined): string {
  const n = String(full ?? '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0] ?? 'there';
}

/**
 * Compose the customer-facing ticket email.
 *
 * Note what is absent: no "within 24 hours", no "we will resolve this",
 * no apology that implies fault. It confirms what was logged and what
 * happens next in the vaguest honest terms.
 */
export function composeTicketEmail(opts: {
  ticketId: string;
  contactName?: string | null;
  contactEmail: string;
  category: string;
  summary: string;
  companyName?: string | null;
}): EmailDraft {
  const greeting = `Hi ${firstName(opts.contactName)},`;
  const company = opts.companyName ? ` for ${opts.companyName}` : '';

  return {
    to: opts.contactEmail,
    subject: `RelayPay support — ticket ${opts.ticketId}`,
    body: [
      greeting,
      '',
      `Thanks for contacting RelayPay support. We have logged your request${company} and it is with our team.`,
      '',
      `Reference: ${opts.ticketId}`,
      `Category: ${opts.category}`,
      '',
      'What you told us:',
      opts.summary,
      '',
      'A member of the support team will review this and follow up at this address. If you need to add anything, reply to this email and it will be attached to the same ticket.',
      '',
      'RelayPay Support'
    ].join('\n')
  };
}

/**
 * Compose the escalation email.
 *
 * Says a specialist is involved. Does NOT say when, does not say what
 * they will conclude, and does not mention why the case was escalated —
 * the caller may have been escalated for a compliance reason we are not
 * permitted to disclose.
 */
export function composeEscalationEmail(opts: {
  escalationId: string;
  contactName?: string | null;
  contactEmail: string;
  category: string;
  reason: string;
  preferredTime?: string | null;
}): EmailDraft {
  const greeting = `Hi ${firstName(opts.contactName)},`;
  const callLine = opts.preferredTime
    ? `You mentioned ${opts.preferredTime} would suit you for a call, and we have passed that on.`
    : 'If you would like to arrange a call, reply to this email and we will set one up.';

  return {
    to: opts.contactEmail,
    subject: `RelayPay support — your request has been passed to a specialist (${opts.escalationId})`,
    body: [
      greeting,
      '',
      'Thanks for speaking with us. Your request needs a specialist, so we have passed it to the right team.',
      '',
      `Reference: ${opts.escalationId}`,
      '',
      'What you raised:',
      opts.reason,
      '',
      callLine,
      '',
      'A specialist will follow up at this address.',
      '',
      'RelayPay Support'
    ].join('\n')
  };
}

/** Minimal HTML wrapper. Plain text stays the source of truth. */
function toHtml(body: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px;line-height:1.6">${esc(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1A1A1A;max-width:560px">',
    paragraphs,
    '<hr style="border:0;border-top:1px solid #E3E7EE;margin:22px 0">',
    '<p style="margin:0;font-size:12px;color:#6B7688">This message was sent by RelayPay Support. Please do not share passwords, card numbers, or security codes by email.</p>',
    '</div>'
  ].join('');
}

/**
 * Send via Resend.
 *
 * Never throws — a failed send must leave the record in a `failed` state
 * with a readable reason, so an admin can fix the address and retry,
 * rather than taking down the request that triggered it.
 */
export async function sendEmail(draft: EmailDraft): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!key) {
    return { ok: false, error: 'RESEND_API_KEY is not set. Add it to the environment to enable sending.' };
  }
  if (!from) {
    return { ok: false, error: 'EMAIL_FROM is not set. It must be an address on a domain verified in Resend.' };
  }
  if (!isPlausibleEmail(draft.to)) {
    return { ok: false, error: `"${draft.to}" does not look like a valid email address.` };
  }

  try {
    const resend = new Resend(key);
    const { data, error } = await resend.emails.send({
      from,
      to: [draft.to],
      subject: draft.subject,
      text: draft.body,
      html: toHtml(draft.body),
      ...(process.env.EMAIL_REPLY_TO ? { replyTo: process.env.EMAIL_REPLY_TO } : {})
    });

    if (error) {
      return { ok: false, error: error.message || 'Resend rejected the message.' };
    }
    return { ok: true, providerId: data?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether sending is configured at all — used to warn in the UI up front. */
export function emailConfigured(): { ready: boolean; reason?: string } {
  if (!process.env.RESEND_API_KEY) return { ready: false, reason: 'RESEND_API_KEY is not set.' };
  if (!process.env.EMAIL_FROM) return { ready: false, reason: 'EMAIL_FROM is not set.' };
  return { ready: true };
}
