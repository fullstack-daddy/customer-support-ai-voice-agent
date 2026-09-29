// Query-time embedding client.
//
// Mirrors supabase/seed/embed.ts but lives in the MCP server so the
// server package has no dependency on the seed scripts. Both must use
// the same model and dimension or similarity search returns noise.

import { embeddingProvider } from '@relaypay/shared';

const TIMEOUT_MS = 8_000;   // tighter than seed-time: this is in a live call path
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
    throw new Error(`${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json() as Promise<{ data?: { embedding: number[] }[] }>;
}

/**
 * Embed a single query. Returns null when no provider is configured,
 * which is the caller's signal to use the lexical path. Throws only on
 * an actual provider failure — the caller treats that as "fall back"
 * too, so a flaky embeddings API degrades instead of erroring the call.
 */
export async function embedQuery(query: string): Promise<number[] | null> {
  const provider = embeddingProvider();
  if (!provider) return null;

  if (provider === 'voyage') {
    const json = await postJson(
      'https://api.voyageai.com/v1/embeddings',
      { input: [query], model: 'voyage-3', input_type: 'query', output_dimension: EMBEDDING_DIMENSION },
      { authorization: `Bearer ${process.env.VOYAGE_API_KEY}` }
    );
    return json.data?.[0]?.embedding ?? null;
  }

  const json = await postJson(
    'https://api.openai.com/v1/embeddings',
    { input: [query], model: 'text-embedding-3-small', dimensions: EMBEDDING_DIMENSION },
    { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  );
  return json.data?.[0]?.embedding ?? null;
}
