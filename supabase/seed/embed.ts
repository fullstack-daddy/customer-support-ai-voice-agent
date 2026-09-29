// Embeddings with a provider-agnostic surface.
//
// Voyage is Anthropic's recommended embeddings partner; OpenAI is the
// fallback. If neither key is set, callers should not reach this module —
// the retrieval layer uses Postgres full-text search instead.
//
// Every call is timeout-bounded. A slow embeddings API must never be the
// reason a seed run hangs.

import { embeddingProvider } from '@relaypay/shared';

const TIMEOUT_MS = 30_000;
const BATCH = 64;

/** Dimension must match the vector(n) column in 0003_embeddings.sql. */
export const EMBEDDING_DIMENSION = 1024;

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${url} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<any>;
}

async function embedVoyage(texts: string[]): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is not set.');
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const json = await postJson(
      'https://api.voyageai.com/v1/embeddings',
      { input: slice, model: 'voyage-3', output_dimension: EMBEDDING_DIMENSION },
      { authorization: `Bearer ${key}` }
    );
    for (const d of json.data ?? []) out.push(d.embedding);
  }
  return out;
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set.');
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const json = await postJson(
      'https://api.openai.com/v1/embeddings',
      { input: slice, model: 'text-embedding-3-small', dimensions: EMBEDDING_DIMENSION },
      { authorization: `Bearer ${key}` }
    );
    for (const d of json.data ?? []) out.push(d.embedding);
  }
  return out;
}

/** Embed an array of texts using whichever provider is configured. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const provider = embeddingProvider();
  if (provider === 'voyage') return embedVoyage(texts);
  if (provider === 'openai') return embedOpenAI(texts);
  throw new Error('No embeddings provider configured (set VOYAGE_API_KEY or OPENAI_API_KEY).');
}

/** Embed a single query string. Returns null if no provider is configured. */
export async function embedQuery(query: string): Promise<number[] | null> {
  if (!embeddingProvider()) return null;
  const [vec] = await embedTexts([query]);
  return vec ?? null;
}
