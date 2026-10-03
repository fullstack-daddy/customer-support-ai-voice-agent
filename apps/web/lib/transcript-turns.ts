// Turning Vapi's transcript events into readable conversation cards.
//
// Vapi emits a "final" transcript per SENTENCE, not per utterance.
// Appending each one straight to the list produced a new card for every
// sentence, so a caller saying "Hi, um, can you tell me what kind of
// questions I can ask you?" arrived as three separate cards, and a
// multi-sentence answer from the agent did the same.
//
// Fold consecutive fragments from the same speaker into one card. A
// change of speaker ends a card; so does a long pause, so that a caller
// who comes back a minute later is not appended to their earlier
// sentence.

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  /** When this turn started. Stable, so it works as a React key. */
  at: number;
  /** When text was last appended, for deciding whether to coalesce. */
  lastAt: number;
}

/**
 * How long after the previous fragment a new one still counts as the
 * same utterance. Generous, because someone reading out a reference
 * number pauses mid-sentence and should not be split across cards.
 */
export const COALESCE_MS = 12_000;

/** Join two transcript fragments without doubling spaces or text. */
export function joinFragments(existing: string, addition: string): string {
  const left = existing.replace(/\s+$/, '');
  const right = addition.replace(/^\s+/, '');
  if (!left) return right;
  if (!right) return left;
  // Vapi sometimes re-sends the tail of the previous fragment.
  if (left.endsWith(right)) return left;
  return `${left} ${right}`;
}

/**
 * Add a transcript fragment, coalescing it into the previous card when
 * it continues the same speaker's turn. Returns a new array; the input
 * is never mutated.
 */
export function appendFragment(
  turns: Turn[],
  role: Turn['role'],
  text: string,
  now: number
): Turn[] {
  const trimmed = text.trim();
  if (!trimmed) return turns;

  const last = turns[turns.length - 1];
  if (last && last.role === role && now - last.lastAt < COALESCE_MS) {
    const merged = turns.slice(0, -1);
    merged.push({ ...last, text: joinFragments(last.text, trimmed), lastAt: now });
    return merged;
  }
  return [...turns, { role, text: trimmed, at: now, lastAt: now }];
}
