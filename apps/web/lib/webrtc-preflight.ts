// Why a voice call cannot start in THIS browser, on THIS origin.
//
// Daily (which Vapi's Web SDK uses underneath) throws a single opaque
// "WebRTC not supported or suppressed" for every one of these causes.
// That sends people hunting for a broken API key when the real problem
// is usually the URL they typed.
//
// The dominant cause in development: the page is open on a plain-http
// LAN address such as http://192.168.1.20:3000. Browsers only expose
// navigator.mediaDevices in a SECURE CONTEXT — https, or a loopback
// host (localhost / 127.0.0.1). On any other http origin the microphone
// API simply does not exist, so WebRTC cannot initialise.

export type PreflightReason = 'insecure-origin' | 'no-webrtc' | 'no-microphone-api';

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: PreflightReason; message: string; hint?: string };

export function checkWebrtcSupport(): PreflightResult {
  // On the server there is nothing to test. The component re-runs this
  // in an effect, so the real answer always comes from the browser.
  if (typeof window === 'undefined') return { ok: true };

  if (!window.isSecureContext) {
    const origin = window.location.origin;
    const port = window.location.port ? `:${window.location.port}` : '';
    return {
      ok: false,
      reason: 'insecure-origin',
      message:
        `Your browser blocks microphone access on ${origin} because the connection is not secure, ` +
        `so the call cannot start.`,
      hint:
        `Open the app on http://localhost${port} instead, or serve it over https. ` +
        `Browsers only allow the microphone on https or a loopback address.`
    };
  }

  if (typeof window.RTCPeerConnection !== 'function') {
    return {
      ok: false,
      reason: 'no-webrtc',
      message: 'This browser does not support WebRTC, or it has been disabled.',
      hint:
        'An extension, a privacy setting or an enterprise policy can suppress WebRTC. ' +
        'Try a normal window in Chrome, Edge, Firefox or Safari.'
    };
  }

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      reason: 'no-microphone-api',
      message: 'This browser does not expose a microphone API, so the call cannot start.',
      hint: 'Embedded or in-app browsers often block it. Open the page in a normal browser window.'
    };
  }

  return { ok: true };
}

/**
 * Map an error thrown during call setup onto something a caller can act
 * on. Falls back to the original text rather than inventing a cause.
 */
export function explainCallError(message: string): string {
  if (/permission|denied|notallowed/i.test(message)) {
    return 'RelayPay needs microphone access to take the call. Allow it in your browser, then try again.';
  }
  if (/notfound|devices?\s*not\s*found|no.*microphone/i.test(message)) {
    return 'No microphone was found. Connect one and try again.';
  }
  if (/notreadable|in use|could not start audio/i.test(message)) {
    return 'Your microphone is already in use by another application. Close it and try again.';
  }
  // Daily's catch-all. Re-run the preflight so the reply names the
  // actual precondition instead of repeating the opaque string.
  if (/webrtc not supported or suppressed/i.test(message)) {
    const pre = checkWebrtcSupport();
    if (!pre.ok) return pre.hint ? `${pre.message} ${pre.hint}` : pre.message;
    return 'This browser blocked WebRTC, so the call could not start. Try a normal browser window.';
  }
  return message;
}

/**
 * Get a human-readable string out of whatever was thrown or emitted.
 *
 * Vapi's error events are not Error instances: the payload is often an
 * object, and sometimes `message` is itself an object. String() on that
 * yields "[object Object]", which is what the caller used to see in
 * place of the actual fault.
 */
export function toMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error && e.message) return e.message;

  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    // Walk the shapes Vapi and Daily actually use, in order.
    for (const key of ['message', 'errorMsg', 'error', 'reason', 'type']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v;
      if (v && typeof v === 'object') {
        const nested = toMessage(v);
        if (nested && nested !== UNKNOWN) return nested;
      }
    }
    // Last resort: show the shape rather than "[object Object]".
    try {
      const json = JSON.stringify(e);
      if (json && json !== '{}') return json.slice(0, 300);
    } catch {
      // Circular. Fall through.
    }
  }
  return UNKNOWN;
}

const UNKNOWN = 'The call failed unexpectedly.';
