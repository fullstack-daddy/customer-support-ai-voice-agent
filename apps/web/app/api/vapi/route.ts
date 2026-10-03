// Alias so the custom-LLM URL works under either Vapi convention.
//
// Vapi's own documentation is inconsistent about the model URL: the
// dashboard walkthrough tells you to paste a base URL and shows a server
// whose route is /chat/completions (i.e. Vapi appends the path), while
// the API reference shows "url": "https://host/chat/completions" with
// the path already included.
//
// Guessing wrong produces a 404 on every turn, which the caller hears as
// the assistant being unable to reach support — and nothing in the Vapi
// dashboard says why. Serving the same handler at /api/vapi and at
// /api/vapi/chat/completions removes the guess: configure the URL as
// https://<host>/api/vapi and it works whether or not Vapi appends.

import { POST as chatCompletions, GET as chatHealth } from './chat/completions/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = chatCompletions;
export const GET = chatHealth;
