# RelayPay Support Agent — how it works

**One page for a non-engineer reviewer.**

## What it is

A customer opens the RelayPay support page, clicks **Start call**, and talks. An AI agent answers out loud, using only RelayPay's approved support documentation. It can look up a transaction or payout, raise a support ticket, and arrange a specialist callback. It does not guess, and it hands anything account-specific to a human.

## What a customer experiences

1. They see a notice that the call is recorded and handled by an AI agent, **before** they start. The agent also says it in its opening line.
2. They click **Start call** and speak.
3. A live transcript appears as they talk — useful for anyone who cannot use audio, and for anyone who wants to check what was said.
4. The agent answers, asks a clarifying question, arranges a callback, or says plainly that it cannot confirm something.
5. They can mute, end the call, and download a transcript afterwards.

## What happens behind the scenes, one turn at a time

**The customer speaks.** Vapi converts speech to text and sends the sentence to our server.

**Our server checks it is really Vapi.** The endpoint costs money to run, so an unauthenticated request is rejected before anything else happens.

**The agent decides what kind of request this is**, working through four options in order:

| Path | When | Example |
| --- | --- | --- |
| **Escalate** | Account restrictions, compliance, disputes, refunds, cancellations, or a frustrated caller | *"My account was restricted and nobody is helping me."* |
| **Ask a clarifying question** | Vague, could mean several things | *"My payment is stuck."* → which kind of payment? |
| **Answer directly** | General question covered by approved documentation | *"What fees does RelayPay charge?"* |
| **Decline gracefully** | Documentation does not cover it, or answering would mean guessing | *"Will it definitely arrive by 9am?"* |

Escalation is checked **first**, on purpose. A frustrated caller asking a documented question should still reach a human.

**It gathers what it needs.** For a policy question it searches the approved knowledge base. For a specific transaction it looks up that exact reference. It only looks things up when the caller has actually given it a reference — it never goes fishing.

**It answers, and everything is recorded.** The reply goes back to Vapi, which speaks it. Meanwhile every step is written down: what was asked, what was answered, which tools ran, what the knowledge base returned, and any ticket or escalation created.

## What it will not do

These are enforced in the system's design, not just by asking the model nicely:

- **It cannot state an account balance.** There is no balance field anywhere in the database. The information does not exist for it to leak.
- **It cannot read internal notes aloud.** Staff-only notes are passed to the agent under a separate name reserved for internal routing, and it is instructed never to voice them.
- **It will not explain a compliance decision** or promise a date for a dispute, refund, or review.
- **It will not invent a fee, a date, or a record.** If a lookup finds nothing, it says so.

These hold even if a caller claims to be a RelayPay employee or tells the agent to ignore its instructions.

## Where to review a specific call

Go to `/internal/review?key=<INTERNAL_REVIEW_SECRET>` — not linked from the public site, and password-gated.

The list shows every conversation with its outcome. Click **Open** on one to see:

| Section | What it tells you |
| --- | --- |
| **Turns** | The full transcript, each turn tagged with what kind of answer it was |
| **Tool calls** | Every lookup and action, with timing and success/failure |
| **Retrieval** | What the agent searched for, what it found, and **whether it actually used it** |
| **Tickets / Escalations** | Anything created during the call |

That retrieval "used?" column is worth knowing about: it catches the case where the agent looked something up and then ignored it — which is the quiet failure worth catching in a grounded system.

## Where the data lives in Supabase

| Table | Contains |
| --- | --- |
| `conversations` | One row per call: when, which channel, how it ended, a summary, token cost |
| `conversation_turns` | Every turn of every call |
| `tool_calls` | Every lookup and action, successful or not |
| `retrieval_logs` | Every knowledge-base search and whether it informed the answer |
| `support_tickets` / `escalations` | Everything created during a call |
| `evaluations` | Test-scenario results |
| `customers` / `transactions` / `payouts` | The provided business data |

To find one call: filter any of these by `conversation_id`. Voice calls use the Vapi call id prefixed with `vapi-`.

## If something goes wrong

The system is built to degrade rather than fail silently.

- **The knowledge base is unreachable** → the agent declines rather than answering from general knowledge.
- **A lookup fails** → the agent says it could not retrieve the details and offers a specialist, rather than guessing.
- **The AI model times out** → the caller hears a short apology and an offer to arrange a callback. The call does not go silent.
- **A call ends without a proper report** → the conversation is closed automatically after two hours rather than sitting open forever.

Every one of these is logged, so the review dashboard shows what happened rather than an unexplained gap.
