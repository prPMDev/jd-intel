import { AtsError, ERROR_CODES, atsErrorFromStatus } from './errors.js';

/**
 * The one HTTP door for every adapter request (issue #7).
 *
 * atsFetch() wraps the global fetch with the politeness every ATS expects
 * and the failure handling the adapters used to leave out:
 *   - a timeout per attempt on the wait for the response to start
 *   - retries with exponential backoff and jitter on 429, any 5xx, and
 *     network errors (DNS, reset, timeout), honoring Retry-After; a
 *     certificate failure is thrown at once, since it cannot pass later
 *   - a cap on requests in flight per host
 *
 * Every other status resolves normally, so an adapter keeps its own 404
 * handling. Once the retries are used up the caller gets an AtsError:
 * rate_limited for a 429, ats_unreachable for a 5xx or a network failure.
 * The global fetch is read on every attempt so a test's mock of it applies.
 *
 * The timer stops once the headers are in. Reading the body is the caller's
 * step (resp.json() in the adapter), and it is not timed: a signal left on
 * the request would abort that read too, so a large board on a slow link
 * would fail at the timeout with a raw TimeoutError thrown from resp.json(),
 * outside this retry loop, where master downloaded it fine. undici's own
 * body timeout (300s idle) still ends a stream that stalls.
 */

const DEFAULTS = {
  timeoutMs: 10_000,
  retries: 3,   // attempts per request in total; 1 turns retrying off
  perHost: 4,   // requests in flight per hostname
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const BASE_BACKOFF_MS = 1000; // 1s, 2s, 4s, ...
const JITTER_MS = 250;
const MAX_RETRY_AFTER_MS = 30_000;

let settings = { ...DEFAULTS };

/**
 * Replace the HTTP settings with the defaults plus `overrides`. For tests
 * and scripts. `configureHttp()` restores the defaults. Returns a copy of
 * the settings now in force.
 */
export function configureHttp(overrides = {}) {
  settings = { ...DEFAULTS, ...overrides };
  return { ...settings };
}

/**
 * fetch(url, init) with a timeout, retries and a per-host queue.
 *
 * Resolves with the Response for any status that is not retried (2xx, 3xx,
 * and 4xx other than 429). Throws AtsError once the retries are used up on
 * a 429 or 5xx (with `.status`), or on a network error or a timeout waiting
 * for the response to start.
 */
export async function atsFetch(url, init = {}) {
  const host = new URL(url).hostname;
  const { retries, sleep, timeoutMs } = settings;

  for (let attempt = 1; ; attempt++) {
    let resp;
    try {
      resp = await withHostSlot(host, () => fetchWithTimeout(url, init, timeoutMs));
    } catch (err) {
      if (attempt >= retries || isCertError(err)) {
        const error = new AtsError(
          ERROR_CODES.ATS_UNREACHABLE,
          `${host}: ${describeCause(err, timeoutMs)} after ${attempts(attempt)}`
        );
        error.cause = err;
        throw error;
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (!isRetried(resp.status)) return resp;
    if (attempt >= retries) {
      throw atsErrorFromStatus(resp.status, `${host}: HTTP ${resp.status} after ${attempts(attempt)}`);
    }
    await sleep(retryAfterMs(resp) ?? backoffMs(attempt));
  }
}

/**
 * Three-state probe outcome for an adapter's has(): true on 2xx, false on
 * a 404, and an AtsError for anything else (401, 403, ...), so a board the
 * probe could not check never reads as "not here" (issue #55). A 429 or
 * 5xx never reaches this point: atsFetch throws on those itself.
 */
export function probeResult(resp, label) {
  if (resp.ok) return true;
  if (resp.status === 404) return false;
  throw atsErrorFromStatus(resp.status, `${label}: ${resp.status}`);
}

// The abort covers connecting and waiting for the headers, and is cleared as
// soon as fetch resolves so the body read that follows is never aborted
// (see the header comment). The reason is a TimeoutError like the one
// AbortSignal.timeout would raise, so describeCause reads both the same way.
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs
  );
  try {
    return await globalThis.fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRetried(status) {
  return status === 429 || status >= 500;
}

function backoffMs(attempt) {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * JITTER_MS);
}

// Retry-After is either delay-seconds or an HTTP-date. Mocked responses may
// carry no headers at all.
function retryAfterMs(resp) {
  const raw = resp.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

// A certificate that fails validation fails the same way on the next
// attempt, so retrying it only costs time. Seen live: every
// {slug}.eu.teamtailor.com answers ERR_TLS_CERT_ALTNAME_INVALID.
const CERT_ERROR = /^(?:ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?)$/;

function isCertError(err) {
  return CERT_ERROR.test(err?.cause?.code || '');
}

// undici reports socket failures as TypeError('fetch failed') with the OS
// code on `cause`, and rejects an aborted request with the signal's reason,
// here the TimeoutError from fetchWithTimeout.
function describeCause(err, timeoutMs) {
  if (err?.name === 'TimeoutError') return `timed out after ${timeoutMs}ms`;
  const detail = err?.cause?.code || err?.cause?.message;
  const message = err?.message || String(err);
  return detail ? `${message} (${detail})` : message;
}

function attempts(n) {
  return `${n} attempt${n === 1 ? '' : 's'}`;
}

// Per-host queue. A finished request hands its slot straight to the next
// waiter (the count never dips in between), so the cap holds even when a new
// caller arrives while a waiter is being woken.
const hosts = new Map(); // hostname -> { active, waiting: [resolve] }

async function withHostSlot(host, run) {
  let slot = hosts.get(host);
  if (!slot) {
    slot = { active: 0, waiting: [] };
    hosts.set(host, slot);
  }
  if (slot.active >= settings.perHost) {
    await new Promise((resolve) => slot.waiting.push(resolve));
  } else {
    slot.active += 1;
  }
  try {
    return await run();
  } finally {
    const next = slot.waiting.shift();
    if (next) next();
    else {
      slot.active -= 1;
      if (slot.active === 0) hosts.delete(host);
    }
  }
}
