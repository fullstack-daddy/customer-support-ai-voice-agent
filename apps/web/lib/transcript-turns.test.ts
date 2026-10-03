import { appendFragment, joinFragments, COALESCE_MS, type Turn } from './transcript-turns';

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' ' + extra); }
};

const T0 = 1_000_000;
let turns: Turn[] = [];

// The reported bug: one spoken sentence arriving as several finals.
turns = appendFragment(turns, 'user', 'Hi, um,', T0);
turns = appendFragment(turns, 'user', 'can you tell me', T0 + 900);
turns = appendFragment(turns, 'user', 'what kind of questions I can ask you?', T0 + 1800);
t('one card for a split utterance', turns.length === 1, JSON.stringify(turns.map(x => x.text)));
t('  text reads naturally', turns[0]!.text === 'Hi, um, can you tell me what kind of questions I can ask you?', turns[0]!.text);

// Speaker change starts a new card.
turns = appendFragment(turns, 'assistant', 'Let me look that up.', T0 + 2500);
turns = appendFragment(turns, 'assistant', 'TXN 9001 is processing.', T0 + 3200);
t('assistant reply is one card', turns.length === 2, String(turns.length));
t('  assistant text joined', turns[1]!.text === 'Let me look that up. TXN 9001 is processing.', turns[1]!.text);

// Back to the caller.
turns = appendFragment(turns, 'user', 'Thanks.', T0 + 4000);
t('speaker change starts a card', turns.length === 3, String(turns.length));

// A long pause ends the turn even for the same speaker.
turns = appendFragment(turns, 'user', 'Actually, one more thing.', T0 + 4000 + COALESCE_MS + 1);
t('long pause starts a new card', turns.length === 4, String(turns.length));

// Keys must stay stable while a card grows.
const before = turns[3]!.at;
turns = appendFragment(turns, 'user', 'About the fees.', T0 + 4000 + COALESCE_MS + 500);
t('start timestamp is stable (React key)', turns[3]!.at === before, `${turns[3]!.at} vs ${before}`);
t('  but lastAt advances', turns[3]!.lastAt > before);

// Hygiene.
t('empty fragment is ignored', appendFragment(turns, 'user', '   ', T0 + 99999).length === turns.length);
t('no doubled spaces', joinFragments('hello ', '  world') === 'hello world', joinFragments('hello ', '  world'));
t('repeated tail is not duplicated', joinFragments('the balance is', 'the balance is') === 'the balance is');
t('does not mutate its input', (() => { const a: Turn[] = []; appendFragment(a, 'user', 'x', T0); return a.length === 0; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
