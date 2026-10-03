// Convert docs/*.md to designed PDFs via headless Chrome.
//
// Usage:
//   node scripts/md2pdf.mjs docs/ONE_PAGE.md docs/ONE_PAGE.pdf --style one-pager
//   node scripts/md2pdf.mjs docs/REFLECTION.md docs/REFLECTION.pdf
//
// Renders Markdown (headings, lists, tables, bold/italic, links, code, hr,
// blockquotes) → an HTML template tuned to the Koya editorial system →
// Chrome --headless --print-to-pdf.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: node scripts/md2pdf.mjs <input.md> <output.pdf> [--style one-pager] [--title "..."]');
  process.exit(1);
}
const [inFileRaw, outFileRaw, ...rest] = argv;
const inFile = path.resolve(inFileRaw);
const outFile = path.resolve(outFileRaw);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--style') opts.style = rest[++i];
  else if (a === '--title') opts.title = rest[++i];
  else if (a === '--eyebrow') opts.eyebrow = rest[++i];
  else if (a === '--footer') opts.footer = rest[++i];
}
const style = opts.style || 'standard';

const md = fs.readFileSync(inFile, 'utf8');
const bodyHtml = mdToHtml(md);
const derivedTitle = extractH1(md) || path.basename(inFile, '.md').replace(/[_-]/g, ' ');
const title = opts.title || derivedTitle;
const eyebrow = opts.eyebrow || 'RelayPay Support Agent · Week 6';
const footer = opts.footer || 'RelayPay Support Agent · Emmanuel Aboyeji · Week 6 · 2026-10-03';

const html = pageTemplate({ title, eyebrow, footer, bodyHtml, style });

// Write HTML to a temp file so Chrome can load it via file://.
const tmpHtml = path.join(os.tmpdir(), `koya-md2pdf-${crypto.randomBytes(6).toString('hex')}.html`);
fs.writeFileSync(tmpHtml, html);
if (process.env.MD2PDF_KEEP_HTML) {
  const side = outFile.replace(/\.pdf$/, '.preview.html');
  fs.writeFileSync(side, html);
  console.log('kept HTML at ' + side);
}

const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-pdf-header-footer',
  '--hide-scrollbars',
  '--run-all-compositor-stages-before-draw',
  `--print-to-pdf=${outFile}`,
  '--no-margins',
  '--virtual-time-budget=6000',
  `file:///${tmpHtml.replace(/\\/g, '/')}`
];
const proc = spawnSync(CHROME, args, { stdio: 'inherit' });
try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
if (proc.status !== 0) {
  console.error('chrome exited with', proc.status);
  process.exit(proc.status || 1);
}
console.log(`✓ wrote ${outFile}`);

// ============================================================
// Markdown → HTML (small, dependency-free)
// ============================================================
function mdToHtml(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="code" data-lang="${escHtml(lang)}"><code>${escHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr />'); i++; continue; }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`);
      i++; continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // Table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*[:\- ]+\|/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2; // skip separator
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      const th = header.map((c) => `<th>${inline(c)}</th>`).join('');
      const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // Lists (unordered / ordered)
    const ulm = /^(\s*)([*+-])\s+(.+)$/.exec(line);
    const olm = /^(\s*)(\d+)\.\s+(.+)$/.exec(line);
    if (ulm || olm) {
      const isOl = Boolean(olm);
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = isOl ? /^(\s*)(\d+)\.\s+(.+)$/.exec(cur) : /^(\s*)([*+-])\s+(.+)$/.exec(cur);
        if (m) {
          const body = m[3];
          // Nested continuation lines
          const buf = [body];
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([*+-]|\d+\.)\s+/.test(lines[i])) {
            buf.push(lines[i].trim()); i++;
          }
          items.push(`<li>${inline(buf.join(' '))}</li>`);
          continue;
        }
        break;
      }
      out.push(isOl ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // Blank line
    if (!line.trim()) { i++; continue; }

    // Paragraph — accumulate until blank/structural line
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>\s?|\s*\||```|(?:-{3,}|_{3,}|\*{3,})\s*$|\s*([*+-]|\d+\.)\s+)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\||\|$/g, '');
  return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function inline(text) {
  let s = escHtml(text);
  // Inline code
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => `<a href="${url}">${txt}</a>`);
  // Bold + italic (order matters — bold first)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
  return s;
}

function escHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractH1(src) {
  const m = /^#\s+(.+)$/m.exec(src);
  return m ? m[1].trim() : '';
}

// ============================================================
// Page templates
// ============================================================
function pageTemplate({ title, eyebrow, footer, bodyHtml, style }) {
  const styleSheet = commonCss() + (style === 'one-pager' ? onePagerCss() : standardCss());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escHtml(title)}</title>
<style>${styleSheet}</style>
</head>
<body>
  <div class="page">
    <header class="masthead">
      <div class="brand">RelayPay <em>Support</em> Agent</div>
      <div class="eyebrow">${escHtml(eyebrow)}</div>
    </header>
    <main>
      ${bodyHtml}
    </main>
    <footer>${escHtml(footer)}</footer>
  </div>
</body>
</html>`;
}

function commonCss() {
  return `
    @page { size: A4; margin: 0; }
    :root {
      --paper: #fbf7ed; --paper-2: #f7f1e2; --paper-3: #f0e8d1;
      --ink-950:#0e0a05; --ink-900:#1a1510; --ink-800:#2a231a;
      --ink-500:#6a5c46; --ink-400:#857858;
      --teal:#0f766e; --teal-50:#f0fdfa;
      --coral:#c85535; --olive:#5f7040; --amber:#b45309; --brick:#a94726;
      --border: rgba(20, 15, 10, 0.10);
      --border-strong: rgba(20, 15, 10, 0.18);
      --font-sans: "Inter", "Helvetica Neue", Arial, sans-serif;
      --font-serif: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      --font-mono: "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--paper-2); color: var(--ink-900); font-family: var(--font-sans); }
    body { font-size: 10.5pt; line-height: 1.5; }
    .page { min-height: 100vh; padding: 22mm 18mm 18mm; background:
      radial-gradient(600px 400px at 88% -6%, rgba(15, 118, 110, 0.05), transparent 60%),
      radial-gradient(500px 400px at -8% 108%, rgba(200, 85, 53, 0.04), transparent 60%),
      var(--paper); position: relative; overflow: hidden; }
    header.masthead { display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid var(--border); padding-bottom: 8pt; margin-bottom: 14pt; }
    header .brand { font-family: var(--font-serif); font-size: 15pt; color: var(--ink-950); }
    header .brand em { font-style: italic; color: var(--teal); padding: 0 2pt; }
    header .eyebrow { font-family: var(--font-mono); font-size: 8pt; letter-spacing: 0.18em;
      text-transform: uppercase; color: var(--teal); font-weight: 600; }
    main h1 { font-family: var(--font-serif); font-weight: 400; font-size: 26pt;
      line-height: 1.1; letter-spacing: -0.01em; margin: 8pt 0 10pt; color: var(--ink-950); }
    main h1 em { font-style: italic; color: var(--teal); }
    main h2 { font-family: var(--font-serif); font-weight: 400; font-size: 16pt;
      line-height: 1.15; margin: 18pt 0 8pt; color: var(--ink-950);
      border-top: 1px solid var(--border); padding-top: 10pt; }
    main h2:first-of-type { border-top: 0; padding-top: 0; }
    main h3 { font-family: var(--font-sans); font-weight: 700; font-size: 10pt;
      letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal);
      margin: 14pt 0 6pt; }
    main h4 { font-family: var(--font-sans); font-weight: 600; font-size: 11pt; margin: 10pt 0 4pt; color: var(--ink-900); }
    main p { margin: 6pt 0; }
    main ul, main ol { margin: 6pt 0 6pt 16pt; padding: 0; }
    main li { margin: 2pt 0; }
    main a { color: var(--teal); text-decoration: none; }
    main a:hover { text-decoration: underline; }
    main strong { color: var(--ink-950); }
    main hr { border: 0; border-top: 1px solid var(--border); margin: 12pt 0; }
    main blockquote { border-left: 3px solid var(--teal); background: var(--teal-50);
      padding: 8pt 10pt; margin: 8pt 0; color: var(--ink-800);
      font-family: var(--font-serif); font-style: italic; border-radius: 0 4pt 4pt 0; }
    main code { background: var(--paper-3); padding: 1pt 4pt; border-radius: 3pt;
      font-family: var(--font-mono); font-size: 9pt; color: var(--ink-950); }
    main pre.code { background: var(--paper-3); padding: 10pt; border-radius: 6pt;
      overflow: hidden; font-family: var(--font-mono); font-size: 8.5pt; line-height: 1.4;
      color: var(--ink-950); border: 1px solid var(--border); margin: 8pt 0;
      white-space: pre-wrap; word-break: break-word; }
    main pre.code code { background: transparent; padding: 0; font-size: inherit; }
    main table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 9.5pt; }
    main th, main td { padding: 6pt 8pt; text-align: left; vertical-align: top;
      border-bottom: 1px solid var(--border); }
    main th { font-family: var(--font-sans); font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em; font-size: 8.5pt; color: var(--ink-500); background: var(--paper-2); }
    main tr:nth-child(even) td { background: rgba(240, 232, 209, 0.35); }
    footer { position: absolute; bottom: 8mm; left: 18mm; right: 18mm; text-align: center;
      font-family: var(--font-mono); font-size: 7.5pt; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--ink-400);
      border-top: 1px solid var(--border); padding-top: 6pt; }
  `;
}

function onePagerCss() {
  // Squeeze everything onto one A4 page.
  return `
    @page { size: A4; margin: 0; }
    body { font-size: 8.5pt; line-height: 1.35; }
    .page { padding: 12mm 12mm 12mm; min-height: 297mm; max-height: 297mm; overflow: hidden; }
    header.masthead { padding-bottom: 5pt; margin-bottom: 8pt; }
    header .brand { font-size: 13pt; }
    header .eyebrow { font-size: 7pt; }
    main h1 { font-size: 18pt; margin: 3pt 0 5pt; }
    main h2 { font-size: 11pt; margin: 8pt 0 3pt; padding-top: 5pt; }
    main h3 { font-size: 8.5pt; margin: 6pt 0 2pt; }
    main h4 { font-size: 9pt; margin: 4pt 0 2pt; }
    main p { margin: 3pt 0; }
    main ul, main ol { margin: 3pt 0 3pt 14pt; }
    main li { margin: 1pt 0; }
    main table { font-size: 7.5pt; margin: 4pt 0; }
    main th, main td { padding: 3pt 5pt; }
    main pre.code, main blockquote { padding: 5pt 7pt; margin: 4pt 0; font-size: 7.5pt; }
    footer { bottom: 5mm; left: 12mm; right: 12mm; padding-top: 4pt; font-size: 6.5pt; }
    /* Two-column layout for body to fit content. */
    main { column-count: 2; column-gap: 10mm; column-fill: balance; }
    main h1, main h2 { column-span: all; }
    main table, main pre.code, main blockquote { break-inside: avoid; }
  `;
}

function standardCss() {
  return `
    /* Multi-page A4 defaults are handled by commonCss(). */
    @page { size: A4; margin: 0; }
    main table { break-inside: auto; }
    main tr { break-inside: avoid; }
    main h2, main h3 { break-after: avoid; }
    main pre.code, main blockquote { break-inside: avoid; }
    footer { position: fixed; }
  `;
}
