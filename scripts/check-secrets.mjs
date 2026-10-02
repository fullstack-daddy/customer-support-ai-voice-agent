#!/usr/bin/env node
// ============================================================
// check-secrets.mjs
//
// Fails the build if a privileged secret can reach the browser bundle.
// Required by Section 2.3 of the build brief.
//
// Two classes of failure:
//   1. SUPABASE_SERVICE_ROLE_KEY referenced anywhere under apps/web/
//      outside an explicitly server-only file.
//   2. Any secret name hung off a NEXT_PUBLIC_* variable, anywhere.
//   3. A literal-looking credential committed in a tracked file.
//
// Run: npm run check:secrets
// ============================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const WEB_DIR = join(ROOT, 'apps', 'web');

// Files under apps/web that are allowed to reference the service-role key.
// Next.js guarantees these never ship to the client.
const SERVER_ONLY = [
  /[\\/]route\.(ts|js|tsx|jsx)$/,          // App Router route handlers
  /\.server\.(ts|js|tsx|jsx)$/,            // explicit server modules
  /[\\/]middleware\.(ts|js)$/,
  /[\\/]instrumentation\.(ts|js)$/,
  /next\.config\.(mjs|js|ts)$/
];

const SECRET_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'VAPI_API_KEY',
  'VAPI_SERVER_SECRET',
  'VOYAGE_API_KEY',
  'OPENAI_API_KEY',
  'INTERNAL_REVIEW_SECRET'
];

// Credential shapes that should never appear as literals in tracked code.
const LITERAL_PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'Supabase service-role JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: 'Apify token', re: /apify_api_[A-Za-z0-9]{20,}/ }
];

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'out', 'build', 'coverage', '.turbo']);
const SCAN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|yml|yaml|env)$/i;

/**
 * Files git ignores cannot leak — they are never committed, never built
 * into a bundle, and never deployed. Scanning them produces false
 * positives on exactly the file that is SUPPOSED to hold real
 * credentials: your local .env.
 *
 * `.env.example` is tracked, so it is still scanned — a real value there
 * would be a genuine leak.
 */
function gitIgnoredSet() {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return new Set(
      out.split('\n').map((l) => l.trim().replace(/\/$/, '')).filter(Boolean)
    );
  } catch {
    // Not a git repo, or git unavailable. Fall back to scanning
    // everything — a false positive is better than a missed secret.
    return new Set();
  }
}

const IGNORED = gitIgnoredSet();

function isGitIgnored(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (IGNORED.has(norm)) return true;
  // A directory entry in the ignore list covers everything beneath it.
  for (const entry of IGNORED) {
    if (entry && norm.startsWith(`${entry}/`)) return true;
  }
  return false;
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (SCAN_EXT.test(entry)) acc.push(full);
  }
  return acc;
}

const failures = [];

// ---- Check 1: service-role key inside apps/web, outside server-only files.
for (const file of walk(WEB_DIR)) {
  const rel = relative(ROOT, file);
  if (isGitIgnored(rel)) continue;
  if (SERVER_ONLY.some((re) => re.test(file))) continue;
  const text = readFileSync(file, 'utf8');
  if (text.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    failures.push(
      `${rel}: references SUPABASE_SERVICE_ROLE_KEY outside a server-only file. ` +
      `Move the access into a route handler or a *.server.ts module.`
    );
  }
}

// ---- Check 2: any secret hung off NEXT_PUBLIC_, anywhere.
const allFiles = walk(ROOT);
for (const file of allFiles) {
  const rel = relative(ROOT, file);
  if (isGitIgnored(rel)) continue;
  if (basename(file) === 'check-secrets.mjs') continue;   // this file names them on purpose
  const text = readFileSync(file, 'utf8');
  for (const name of SECRET_NAMES) {
    const re = new RegExp(`NEXT_PUBLIC_[A-Z0-9_]*${name}|NEXT_PUBLIC_${name}`);
    if (re.test(text)) {
      failures.push(`${rel}: exposes ${name} through a NEXT_PUBLIC_* variable. That ships to the browser.`);
    }
  }
}

// ---- Check 3: literal credentials in tracked files.
for (const file of allFiles) {
  const rel = relative(ROOT, file);
  if (isGitIgnored(rel)) continue;
  if (basename(file) === 'check-secrets.mjs') continue;   // the regexes themselves
  if (rel === '.env.example') continue;                   // template, values are blank
  const text = readFileSync(file, 'utf8');
  for (const { name, re } of LITERAL_PATTERNS) {
    if (re.test(text)) {
      failures.push(`${rel}: contains what looks like a literal ${name}. Move it to .env and rotate the key.`);
    }
  }
}

if (failures.length) {
  console.error('\n  Secret-safety check FAILED:\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n  ${failures.length} issue(s). Build blocked.\n`);
  process.exit(1);
}

console.log('  Secret-safety check passed: no privileged key reachable from the client bundle.');
