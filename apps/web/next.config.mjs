// @next/env is CommonJS, so a named ESM import fails. Default-import
// then destructure.
import nextEnv from '@next/env';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { loadEnvConfig } = nextEnv;

// Fallback env loading for the MONOREPO ROOT .env.
//
// The real fix lives in scripts/with-env.mjs, which the npm scripts use:
// it puts the root .env into the environment BEFORE Next starts, which
// is the only way server handlers, edge middleware and the client bundle
// all see it.
//
// This call is a safety net for someone running `npx next dev` directly.
// On its own it is NOT sufficient: Next restores its own snapshot of
// process.env after reading this config, so server-side variables set
// here do not survive into route handlers, and edge middleware never
// sees them. What it does still buy is the NEXT_PUBLIC_* forwarding
// below, which is applied at config time.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
loadEnvConfig(ROOT);

/**
 * NEXT_PUBLIC_* values must be present when the client bundle is built.
 * Forwarding them explicitly guarantees that, rather than relying on
 * load order. Only the publishable ones — nothing secret is listed here,
 * and scripts/check-secrets.mjs fails the build if that ever changes.
 */
const publicEnv = Object.fromEntries(
  Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('NEXT_PUBLIC_') && typeof v === 'string')
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Agent SDK spawns the MCP server as a child process. Bundling it
  // would break that, so it stays external and is required at runtime.
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@relaypay/agent',
    '@relaypay/mcp-server'
  ],
  // Dev-only: allows requests from this LAN origin. A bare host, not a URL.
  allowedDevOrigins: ['172.23.48.1'],
  env: publicEnv,
  // The monorepo root holds the workspace packages this app imports.
  outputFileTracingRoot: ROOT,
  // Files the agent reaches at RUNTIME, which static tracing cannot see.
  //
  // The agent spawns the MCP server by building its path at run time, so
  // nothing imports packages/mcp-server/dist and Next leaves it out of
  // the serverless bundle. The spawn then fails instantly — a turn that
  // dies in ~3s rather than timing out — and the caller hears the
  // generic "I'm having trouble" line. The Agent SDK is listed for the
  // same reason: it unpacks its CLI from files it reads at run time.
  outputFileTracingIncludes: {
    '/api/vapi': [
      '../../packages/mcp-server/dist/**',
      '../../packages/shared/dist/**',
      '../../packages/agent/node_modules/@anthropic-ai/claude-agent-sdk/**',
      '../../node_modules/@anthropic-ai/claude-agent-sdk/**'
    ],
    '/api/vapi/chat/completions': [
      '../../packages/mcp-server/dist/**',
      '../../packages/shared/dist/**',
      '../../packages/agent/node_modules/@anthropic-ai/claude-agent-sdk/**',
      '../../node_modules/@anthropic-ai/claude-agent-sdk/**'
    ]
  },
  async headers() {
    return [
      {
        // The admin console must not be cached or indexed.
        source: '/admin/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' }
        ]
      }
    ];
  }
};

export default nextConfig;
