// search_knowledge_base — the grounding tool.
//
// Design notes:
//
//  - Two retrieval paths. If an embeddings key is configured we run
//    cosine similarity through the `match_knowledge_chunks` RPC. If no
//    key is set, OR the embeddings call fails or times out, we fall back
//    to Postgres full-text ranking. A missing third-party key must not
//    take the support line down.
//
//  - `retrieval_mode` records which path ran, as a first-class column
//    rather than buried in freeform metadata, so a reviewer can tell at a
//    glance whether an answer was grounded by vectors or by keywords.
//
//  - THE TOOL writes the retrieval_logs row, not the model. Relying on
//    the model to remember to log its own retrieval is how you end up
//    with gaps in exactly the cases where something went wrong.
//
//  - Below the relevance threshold we return `found: false` with a
//    reason. That is the signal that routes the agent to "decline
//    gracefully" instead of answering from general fintech knowledge.

import { supabaseAdmin, withTimeout, RETRIEVAL_MIN_SCORE, RETRIEVAL_TOP_K } from '@relaypay/shared';
import { SearchKnowledgeBaseInput, type SearchKnowledgeBaseOutput } from '@relaypay/shared';
import { instrumented, formatZodError, type ToolContext } from '../instrument.js';
import { embedQuery } from './embed-client.js';

interface RawChunk {
  id: string;
  title: string;
  section_path: string | null;
  content: string;
  score: number;
}

/** Cosine-similarity path. Returns null if embeddings are unavailable. */
async function embeddingSearch(query: string): Promise<RawChunk[] | null> {
  let vector: number[] | null;
  try {
    vector = await embedQuery(query);
  } catch {
    return null;   // fall through to lexical
  }
  if (!vector) return null;

  const db = supabaseAdmin();
  const res = await withTimeout('match_knowledge_chunks', () =>
    db.rpc('match_knowledge_chunks', {
      query_embedding: vector,
      match_count: RETRIEVAL_TOP_K,
      min_score: 0
    })
  );
  if (!res.ok) return null;
  const { data, error } = res.data as { data: RawChunk[] | null; error: unknown };
  if (error || !data) return null;
  return data;
}

/**
 * Lexical path: Postgres full-text ranking over the generated tsvector.
 *
 * ts_rank returns small absolute numbers, so we normalise into roughly
 * the same 0-1 band the cosine path produces. Without this the shared
 * RETRIEVAL_MIN_SCORE threshold would mean two different things
 * depending on which path ran.
 */
// Words that carry no retrieval signal. Left out of both the OR query
// and the overlap score: counting "what" as a miss drags an otherwise
// good chunk below RETRIEVAL_MIN_SCORE purely for being asked politely.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'you', 'can', 'does', 'did', 'what', 'when',
  'how', 'why', 'who', 'with', 'from', 'that', 'this', 'there', 'here',
  'was', 'were', 'will', 'would', 'could', 'should', 'have', 'has', 'had',
  'any', 'all', 'but', 'not', 'his', 'her', 'its', 'our', 'your', 'their',
  'about', 'into', 'over', 'than', 'then', 'them', 'they', 'been', 'being',
  'much', 'many', 'please', 'tell', 'know', 'get', 'got', 'need', 'want'
]);

/** Content-bearing terms, lowercased and de-duplicated. */
function contentTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return Array.from(new Set(terms));
}

/**
 * Lexical path: Postgres full-text ranking over the generated tsvector.
 *
 * Two passes. websearch_to_tsquery ANDs every term, which is right when
 * it matches but fails whole questions: "What fees does RelayPay charge
 * for international payments?" requires a chunk containing *every* one
 * of those words, and the fee chunk does not say "international", so a
 * correct answer sitting in the database returned nothing.
 *
 * So if the strict pass finds nothing, retry with the content terms
 * OR-ed together. Recall goes up, and precision is held by the overlap
 * score below plus RETRIEVAL_MIN_SCORE — a chunk matching one word out
 * of five still scores too low to be returned.
 *
 * ts_rank returns small absolute numbers, so we normalise into roughly
 * the same 0-1 band the cosine path produces. Without this the shared
 * RETRIEVAL_MIN_SCORE threshold would mean two different things
 * depending on which path ran.
 */
async function lexicalSearch(query: string): Promise<RawChunk[]> {
  const db = supabaseAdmin();

  const run = async (
    text: string,
    type: 'websearch' | undefined
  ): Promise<Omit<RawChunk, 'score'>[]> => {
    const res = await withTimeout('lexical kb search', () =>
      db
        .from('knowledge_chunks')
        .select('id, title, section_path, content')
        .textSearch('search_tsv', text, type ? { type, config: 'english' } : { config: 'english' })
        .limit(RETRIEVAL_TOP_K)
    );
    if (!res.ok) throw new Error(res.error);
    const { data, error } = res.data as {
      data: Omit<RawChunk, 'score'>[] | null;
      error: { message?: string } | null;
    };
    if (error) throw new Error(error.message ?? 'lexical search failed');
    return data ?? [];
  };

  const terms = contentTerms(query);

  let rows = await run(query, 'websearch');
  if (rows.length === 0 && terms.length > 0) {
    // Raw tsquery (no `type`) so the | operator is honoured.
    rows = await run(terms.join(' | '), undefined);
  }

  if (rows.length === 0) return [];

  const hays = rows.map((r) => `${r.title} ${r.content}`.toLowerCase());

  // Score against the terms the corpus can actually answer, not every
  // word the caller said.
  //
  // "can you guarantee my payout arrives tomorrow morning" has five
  // content terms, but "arrives", "tomorrow" and "morning" appear in no
  // chunk at all. Dividing by five scored the correct no-guarantee
  // policy at 0.2 and RETRIEVAL_MIN_SCORE discarded it — the right
  // answer was in the database and the agent said it could not help.
  //
  // Terms that match nothing carry no signal about which chunk is best,
  // so they are excluded from the denominator. Precision still holds:
  // when nothing matches at all, rows is empty and found stays false.
  const answerable = terms.filter((t) => hays.some((h) => h.includes(t)));
  const denominator = answerable.length || terms.length;

  return rows.map((r, i) => {
    const hits = answerable.filter((t) => hays[i]!.includes(t)).length;
    const score = denominator ? Math.min(1, hits / denominator) : 0.5;
    return { ...r, score };
  }).sort((a, b) => b.score - a.score);
}

async function writeRetrievalLog(row: {
  conversation_id: string | null;
  query: string;
  chunks: RawChunk[];
  retrieval_mode: string;
  latency_ms: number;
}): Promise<void> {
  try {
    const db = supabaseAdmin();
    const top = row.chunks[0];
    await withTimeout('retrieval_logs insert', () =>
      db.from('retrieval_logs').insert({
        conversation_id: row.conversation_id,
        query: row.query,
        chunks_used: row.chunks.map((c) => ({
          chunk_id: c.id,
          title: c.title,
          score: Number(c.score.toFixed(4)),
          snippet: c.content.slice(0, 240)
        })),
        source_title: top?.title ?? null,
        source_summary: top ? top.content.slice(0, 400) : null,
        result_count: row.chunks.length,
        // Set true by the agent layer once it confirms the chunk actually
        // shaped the reply. Starts false so "retrieved but ignored" is
        // visible rather than assumed.
        used_in_answer: false,
        retrieval_mode: row.retrieval_mode,
        latency_ms: row.latency_ms
      })
    );
  } catch (e) {
    console.error(`[retrieval] log write failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function searchKnowledgeBase(ctx: ToolContext, raw: unknown): Promise<SearchKnowledgeBaseOutput> {
  return instrumented<SearchKnowledgeBaseOutput>(
    ctx,
    'search_knowledge_base',
    'Retrieve approved RelayPay knowledge to ground an answer',
    (raw ?? {}) as Record<string, unknown>,
    async () => {
      const parsed = SearchKnowledgeBaseInput.safeParse(raw);
      if (!parsed.success) {
        return {
          payload: {
            found: false,
            retrieval_mode: 'none',
            chunks: [],
            reason: formatZodError(parsed.error.issues)
          },
          status: 'error' as const,
          resultSummary: 'invalid input'
        };
      }
      const query = parsed.data.query.trim();
      const conversationId = parsed.data.conversation_id ?? ctx.conversationId;
      const started = Date.now();

      let mode = 'embedding';
      let hits = await embeddingSearch(query);
      if (hits === null) {
        mode = 'lexical';
        hits = await lexicalSearch(query);
      }

      const relevant = hits.filter((c) => c.score >= RETRIEVAL_MIN_SCORE).slice(0, RETRIEVAL_TOP_K);
      const latency = Date.now() - started;

      await writeRetrievalLog({
        conversation_id: conversationId,
        query,
        chunks: relevant,
        retrieval_mode: relevant.length ? mode : 'none',
        latency_ms: latency
      });

      if (!relevant.length) {
        return {
          payload: {
            found: false,
            retrieval_mode: mode,
            chunks: [],
            reason:
              'No approved RelayPay documentation covers this closely enough to answer from. ' +
              'Decline gracefully or escalate — do not answer from general knowledge.'
          },
          status: 'not_found' as const,
          resultSummary: `no chunk above threshold (mode=${mode}, candidates=${hits.length})`
        };
      }

      return {
        payload: {
          found: true,
          retrieval_mode: mode,
          chunks: relevant.map((c) => ({
            id: c.id,
            title: c.title,
            section_path: c.section_path,
            content: c.content,
            score: Number(c.score.toFixed(4))
          }))
        },
        status: 'success' as const,
        resultSummary: `${relevant.length} chunks (mode=${mode}, top=${relevant[0]!.title})`
      };
    },
    (message) => ({
      found: false,
      retrieval_mode: 'none',
      chunks: [],
      reason: `Knowledge base is unavailable right now (${message}). Do not answer from general knowledge.`
    })
  );
}
