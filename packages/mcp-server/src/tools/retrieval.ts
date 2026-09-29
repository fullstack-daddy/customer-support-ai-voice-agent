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
async function lexicalSearch(query: string): Promise<RawChunk[]> {
  const db = supabaseAdmin();
  // websearch_to_tsquery tolerates natural phrasing ("how much are fees")
  // where plainto_tsquery is stricter about operators.
  const res = await withTimeout('lexical kb search', () =>
    db
      .from('knowledge_chunks')
      .select('id, title, section_path, content')
      .textSearch('search_tsv', query, { type: 'websearch', config: 'english' })
      .limit(RETRIEVAL_TOP_K)
  );
  if (!res.ok) throw new Error(res.error);
  const { data, error } = res.data as {
    data: Omit<RawChunk, 'score'>[] | null;
    error: { message?: string } | null;
  };
  if (error) throw new Error(error.message ?? 'lexical search failed');
  const rows = data ?? [];

  // Rank by term overlap. Crude next to BM25, but it is honest about its
  // own confidence, which is what the threshold needs.
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  return rows.map((r) => {
    const hay = `${r.title} ${r.content}`.toLowerCase();
    const hits = terms.filter((t) => hay.includes(t)).length;
    const score = terms.length ? Math.min(1, hits / terms.length) : 0.5;
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
