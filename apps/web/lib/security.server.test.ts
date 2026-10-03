import { createHmac } from 'node:crypto';
import { verifyVapiRequest } from './security.server';

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = '') => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' ' + extra); }
};

const SECRET = 'correct-horse-battery-staple-0123456789';
process.env.VAPI_SERVER_SECRET = SECRET;
const h = (o: Record<string, string>) => new Headers(o);

let r = verifyVapiRequest(h({ 'x-vapi-secret': SECRET }));
t('accepts x-vapi-secret', r === null, String(r));

r = verifyVapiRequest(h({ authorization: 'Bearer ' + SECRET }));
t('accepts authorization bearer', r === null, String(r));

// The bug: empty x-vapi-secret must not mask a valid authorization.
r = verifyVapiRequest(h({ 'x-vapi-secret': '', authorization: 'Bearer ' + SECRET }));
t('empty x-vapi-secret falls through to authorization', r === null, String(r));

r = verifyVapiRequest(h({ 'x-vapi-secret': '   ', authorization: SECRET }));
t('whitespace-only header falls through', r === null, String(r));

const body = '{"hello":"world"}';
const mac = createHmac('sha256', SECRET).update(body).digest('hex');
r = verifyVapiRequest(h({ 'x-vapi-signature': mac }), body);
t('accepts an HMAC signature', r === null, String(r));

r = verifyVapiRequest(h({ 'x-vapi-secret': 'wrong-value-entirely' }));
t('rejects a wrong secret', typeof r === 'string' && r.includes('mismatch'), String(r));
t('  and names the header', typeof r === 'string' && r.includes('x-vapi-secret'), String(r));

r = verifyVapiRequest(h({}));
t('rejects with no headers', typeof r === 'string' && r.includes('no auth headers'), String(r));

r = verifyVapiRequest(h({ 'x-vapi-secret': '', authorization: '' }));
t('reports present-but-empty', typeof r === 'string' && r.includes('present but empty'), String(r));

delete process.env.VAPI_SERVER_SECRET;
r = verifyVapiRequest(h({ 'x-vapi-secret': SECRET }));
t('fails CLOSED when unconfigured', typeof r === 'string' && r.includes('not set'), String(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
