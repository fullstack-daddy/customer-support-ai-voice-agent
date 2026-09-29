// Validated environment access.
//
// Two rules enforced here:
//   1. Secrets are read through `serverEnv()`, which throws if called from
//      a bundle that reached the browser. Nothing in this module is safe to
//      import from a client component.
//   2. Missing-but-required values fail loudly at startup with a message
//      naming exactly what to set and where to get it — never a silent
//      undefined that surfaces as a confusing 500 three layers down.

import { z } from 'zod';

const serverSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'Set ANTHROPIC_API_KEY in .env (console.anthropic.com -> API Keys).'),
  CLAUDE_MODEL: z.string().optional(),

  SUPABASE_URL: z
    .string()
    .url('SUPABASE_URL must be the bare project URL, e.g. https://abcd.supabase.co')
    .refine((u) => !/\/rest\/v1/.test(u), 'SUPABASE_URL must NOT include /rest/v1 — that path is added automatically.'),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, 'Set SUPABASE_SERVICE_ROLE_KEY in .env (Supabase -> Settings -> API -> service_role -> Reveal).'),
  SUPABASE_ANON_KEY: z.string().optional(),

  VAPI_API_KEY: z.string().optional(),
  VAPI_SERVER_SECRET: z.string().optional(),

  VOYAGE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  INTERNAL_REVIEW_SECRET: z.string().optional(),

  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000')
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/**
 * Read + validate server-side environment. Throws with an actionable
 * message if anything required is missing or malformed.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() was called in the browser. Secrets must never reach the client bundle.');
  }
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Environment is not configured correctly:\n${lines.join('\n')}\n\nSee .env.example for the full list.`);
  }
  cached = parsed.data;
  return cached;
}

/** Which embeddings provider, if any, is configured. */
export function embeddingProvider(): 'voyage' | 'openai' | null {
  if (process.env.VOYAGE_API_KEY) return 'voyage';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

/** Origins permitted to call the API routes. Never '*'. */
export function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
