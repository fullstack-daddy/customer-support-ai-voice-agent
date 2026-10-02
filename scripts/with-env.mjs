#!/usr/bin/env node
// Run a command with the MONOREPO-ROOT .env loaded into the real process
// environment.
//
// Why this exists
// ---------------
// Next only auto-loads .env from its own directory (apps/web). In a
// monorepo with a single root .env that file is ignored.
//
// Calling loadEnvConfig() from next.config.mjs does NOT fix it. Next
// snapshots process.env before reading the config and restores that
// snapshot afterwards, so anything the config added is gone by the time
// a route handler runs — the admin login fails with "not_configured"
// while the value sits in the file. Edge middleware is worse: it cannot
// read files at all, so it only ever sees variables that were inlined at
// build time.
//
// The one thing that reaches all three runtimes — node handlers, edge
// middleware, and NEXT_PUBLIC_* in the client bundle — is a variable
// that is already in the environment when Next starts. So load it here,
// then exec.
//
// Variables already present in the real environment win; the file only
// fills gaps. A missing .env is not an error: on Vercel the values come
// from the dashboard and there is no file to read.
//
// Usage:  node scripts/with-env.mjs next dev

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(ROOT, '.env');

/**
 * Parse a .env file. Deliberately small and predictable: KEY=VALUE, an
 * optional `export` prefix, `#` comments, and single- or double-quoted
 * values. Escapes (\n, \t) are expanded only inside double quotes, which
 * is the usual convention and keeps Windows paths in single quotes
 * intact.
 */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1).replace(/\n/g, '\n').replace(/\t/g, '\t');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment ends the value.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

let loaded = 0;
if (existsSync(ENV_FILE)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(ENV_FILE, 'utf8')))) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      loaded++;
    }
  }
  console.log(`[with-env] loaded ${loaded} variable(s) from ${ENV_FILE}`);
} else {
  console.log('[with-env] no root .env — using the ambient environment');
}

// npm puts node_modules/.bin on PATH for its own scripts, but this file
// is also runnable directly (node scripts/with-env.mjs next dev). Add the
// local bin directories so `next`, `tsx` and friends resolve either way.
const BIN_DIRS = [
  resolve(process.cwd(), 'node_modules', '.bin'),
  resolve(ROOT, 'node_modules', '.bin')
].filter(existsSync);
if (BIN_DIRS.length) {
  const sep = process.platform === 'win32' ? ';' : ':';
  // Windows env keys are case-insensitive but the object keys are not,
  // so reuse whatever casing the parent process actually used.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  process.env[pathKey] = [...BIN_DIRS, process.env[pathKey] ?? ''].join(sep);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('[with-env] usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}

// shell:true so the npm-provided node_modules/.bin entries resolve on
// Windows, where the binaries are .cmd shims.
const child = spawn(cmd, args, { stdio: 'inherit', shell: true, env: process.env });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
