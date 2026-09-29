// Knowledge-base chunker.
//
// Splits assets/relaypay-knowledge-base.md on headings into retrievable
// chunks. The rule that matters: a question and its answer must stay in
// the same chunk. The FAQ section uses `###` per question, so each `###`
// becomes one chunk carrying its parent `##` in section_path for context.
//
// Chunks are 1-3 paragraphs. We do NOT split smaller — "Why Is My Payment
// Delayed?" separated from its answer would retrieve a heading with no
// information in it.

export interface KbChunk {
  id: string;
  title: string;
  section_path: string;
  content: string;
  summary: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Stable, readable chunk id: a short section prefix plus the heading.
 *
 * Built from the section rather than the full path because the full path
 * shares a long common prefix across siblings — truncating it produced
 * collisions and ids like `...-2-3-4-5-6`, which are useless in a
 * retrieval log a human has to read.
 */
function chunkId(sectionPath: string, title: string): string {
  const parts = sectionPath.split('>').map((p) => p.trim()).filter(Boolean);
  // parts[0] is the document H1; parts[1] is the major section.
  const section = parts[1] ?? parts[0] ?? '';
  const prefix = slugify(section)
    .split('-')
    .filter((w) => !['and', 'the', 'of', 'a'].includes(w))
    .map((w) => w.slice(0, 4))
    .slice(0, 3)
    .join('-');
  const leaf = slugify(title).slice(0, 48);
  return [prefix, leaf].filter(Boolean).join('--');
}

/** First sentence (or first 180 chars) as a one-line summary. */
function summarise(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const firstSentence = /^(.{20,200}?[.!?])\s/.exec(flat);
  if (firstSentence?.[1]) return firstSentence[1];
  return flat.slice(0, 180) + (flat.length > 180 ? '…' : '');
}

export function chunkKnowledgeBase(markdown: string): KbChunk[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  const chunks: KbChunk[] = [];
  let h1 = '';
  let h2 = '';
  let currentTitle = '';
  let currentPath = '';
  let buffer: string[] = [];
  const seenIds = new Set<string>();

  const flush = () => {
    const content = buffer.join('\n').trim();
    buffer = [];
    if (!currentTitle || !content) return;

    // Drop chunks that are only a heading with no substance.
    if (content.replace(/\s+/g, ' ').length < 40) return;

    const base = chunkId(currentPath, currentTitle);
    let id = base;
    let n = 2;
    while (seenIds.has(id)) id = `${base}-${n++}`;
    seenIds.add(id);

    chunks.push({
      id,
      title: currentTitle,
      section_path: currentPath,
      content,
      summary: summarise(content)
    });
  };

  for (const line of lines) {
    const m1 = /^#\s+(.*)$/.exec(line);
    const m2 = /^##\s+(.*)$/.exec(line);
    const m3 = /^###\s+(.*)$/.exec(line);

    if (m1?.[1]) {
      flush();
      h1 = m1[1].trim();
      h2 = '';
      currentTitle = '';
      currentPath = h1;
      continue;
    }
    if (m2?.[1]) {
      flush();
      h2 = m2[1].trim();
      currentTitle = h2;
      currentPath = [h1, h2].filter(Boolean).join(' > ');
      continue;
    }
    if (m3?.[1]) {
      flush();
      const h3 = m3[1].trim();
      currentTitle = h3;
      currentPath = [h1, h2, h3].filter(Boolean).join(' > ');
      continue;
    }
    buffer.push(line);
  }
  flush();

  return chunks;
}
