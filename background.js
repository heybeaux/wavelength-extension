// Wavelength Chrome Extension — Background Service Worker
// Manages auth token storage and proxies API calls for content scripts

const API_BASE = 'https://api-production-dad4.up.railway.app/api/v1';
const TRUSTED_WEB_ORIGIN = 'https://mywavelength.ai';

// Production Supabase (wavelength project). The publishable key is public by
// design and safe here — never put an sb_secret_ key in this folder, which is
// mirrored to a public repo on merge. Keep in sync with manifest.json's
// host_permissions entry, which names this same host.
const SUPABASE_URL = 'https://hgxtfkazzjtetddkdmgs.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_sS-5re7a84zwWVQ_qF0feg_-w30veBF';

const STORAGE_KEYS = {
  access: 'wavelength_token',
  refresh: 'wavelength_refresh_token',
  expiresAt: 'wavelength_expires_at',
  upgradeFailed: 'wavelength_upgrade_failed',
  upgradeAttemptedAt: 'wavelength_upgrade_attempted_at',
};

// Serialises every read-decide-exchange-persist cycle. It is a queue, not a
// shared result: each caller runs its own critical section once it holds the
// lock, so a forced refresh after a 401 never inherits an earlier call's
// decision that the token was still fresh. Coalescing did exactly that.
let sessionLock = Promise.resolve();

// Bumped on sign-out. A refresh already in flight when the user signs out must
// not write its result afterwards — the new pair would be valid (sign-out
// revoked the *old* refresh token), leaving the extension authenticated after
// the user believed they had left.
let sessionGeneration = 0;

function withSessionLock(fn) {
  const run = sessionLock.then(fn, fn);
  sessionLock = run.then(() => undefined, () => undefined);
  return run;
}

function senderOrigin(sender) {
  if (sender.origin) return sender.origin;
  if (sender.url) {
    try { return new URL(sender.url).origin; } catch { return null; }
  }
  return null;
}

function isTrustedWebSender(sender) {
  return senderOrigin(sender) === TRUSTED_WEB_ORIGIN;
}

function isExtensionSender(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  const origin = senderOrigin(sender);
  return !origin || origin.startsWith('chrome-extension://');
}

function decodeJwtExp(accessToken) {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// Carries over the sanity check the old SET_TOKEN handler had: reject obvious
// junk — an empty string, a truncated paste, a placeholder — before it reaches
// storage. A real access token is a JWT of several hundred characters, so 20 is
// a floor, not validation of the token itself.
//
// It applies to the ACCESS token only. Supabase refresh tokens are short —
// 12 characters in practice — so the same floor would silently discard every
// one of them, leaving a session that looks signed in and cannot refresh.
// That is precisely the bug this whole change exists to fix, and an earlier
// version of this file reintroduced it. Caught in a browser, not in review.
const MIN_ACCESS_TOKEN_LENGTH = 20;

function normalizeSession(input) {
  if (
    !input?.access_token ||
    typeof input.access_token !== 'string' ||
    input.access_token.length < MIN_ACCESS_TOKEN_LENGTH
  ) {
    return null;
  }
  // No length floor here — see the note above. Non-empty string is the only
  // thing we can safely require of a refresh token.
  const refreshToken =
    typeof input.refresh_token === 'string' && input.refresh_token.length > 0
      ? input.refresh_token
      : null;
  const expiresAt =
    typeof input.expires_at === 'number'
      ? input.expires_at
      : decodeJwtExp(input.access_token);
  return {
    access_token: input.access_token,
    refresh_token: refreshToken,
    expires_at: expiresAt,
  };
}

async function getStoredSession() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.access,
    STORAGE_KEYS.refresh,
    STORAGE_KEYS.expiresAt,
  ]);
  if (!result[STORAGE_KEYS.access]) return null;
  return {
    access_token: result[STORAGE_KEYS.access],
    refresh_token: result[STORAGE_KEYS.refresh] || null,
    expires_at:
      typeof result[STORAGE_KEYS.expiresAt] === 'number'
        ? result[STORAGE_KEYS.expiresAt]
        : decodeJwtExp(result[STORAGE_KEYS.access]),
  };
}

async function setSession(sessionInput) {
  const session = normalizeSession(sessionInput);
  if (!session) throw new Error('Invalid session');

  const payload = {
    [STORAGE_KEYS.access]: session.access_token,
  };
  if (session.refresh_token) {
    payload[STORAGE_KEYS.refresh] = session.refresh_token;
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.refresh);
  }
  if (session.expires_at) {
    payload[STORAGE_KEYS.expiresAt] = session.expires_at;
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.expiresAt);
  }

  await chrome.storage.local.set(payload);
}

async function clearSession() {
  sessionGeneration += 1;
  await chrome.storage.local.remove([
    STORAGE_KEYS.access,
    STORAGE_KEYS.refresh,
    STORAGE_KEYS.expiresAt,
    STORAGE_KEYS.upgradeFailed,
    STORAGE_KEYS.upgradeAttemptedAt,
  ]);
}

async function getAuthToken() {
  const session = await getStoredSession();
  return session?.access_token || null;
}

function isStale(session) {
  if (!session?.access_token) return true;
  if (!session.refresh_token) return false;
  if (!session.expires_at) return true;
  return session.expires_at * 1000 - Date.now() < 60_000;
}

function isAuthFailureStatus(status) {
  return status === 400 || status === 401 || status === 403;
}

function isTransientAuthStatus(status) {
  return status === 429 || status >= 500;
}

async function exchangeRefreshToken(refreshToken) {
  const generation = sessionGeneration;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    if (isTransientAuthStatus(res.status)) {
      return { kind: 'transient' };
    }
    if (isAuthFailureStatus(res.status)) {
      return { kind: 'auth_failure' };
    }
    return { kind: 'transient' };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { kind: 'transient' };
  }

  if (!data?.access_token || !data?.refresh_token) {
    return { kind: 'transient' };
  }

  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at:
      typeof data.expires_at === 'number'
        ? data.expires_at
        : decodeJwtExp(data.access_token),
  };

  if (generation !== sessionGeneration) {
    // Signed out while this exchange was in flight. Drop the result rather
    // than writing a live session back over the sign-out.
    return { kind: 'stale_generation' };
  }

  try {
    await setSession(session);
  } catch {
    return { kind: 'transient' };
  }

  return { kind: 'ok', accessToken: session.access_token };
}

// One body for both callers. `force` is the difference: ensureFreshToken skips
// the exchange when the token is still fresh, forceRefreshOnce always attempts
// it because the caller has just been told the token is dead.
//
// Both run INSIDE the lock, and read storage inside it too. Reading outside
// would let two callers see the same refresh token and both spend it — and
// with reuse detection on for this project, the second spend revokes the whole
// session.
async function runRefresh({ force }) {
  const session = await getStoredSession();

  if (!session?.access_token) {
    if (force) return null;
    throw new Error('Not authenticated');
  }

  if (!session.refresh_token) {
    if (force) return null;
    return session.access_token;
  }

  // A queued caller may find the previous one already refreshed for it.
  if (!force && !isStale(session)) {
    return session.access_token;
  }

  const result = await exchangeRefreshToken(session.refresh_token);

  if (result.kind === 'ok') {
    return result.accessToken;
  }

  if (result.kind === 'auth_failure') {
    if (force) return null;
    await clearSession();
    chrome.runtime.sendMessage({ type: 'AUTH_EXPIRED' }).catch(() => {});
    throw new Error('Your session has expired. Please sign in again.');
  }

  // stale_generation: signed out mid-exchange, nothing was written.
  if (result.kind === 'stale_generation') {
    return null;
  }

  // Transient — network, 429, 5xx. Keep the session and let the caller carry
  // on with the token it has.
  return force ? null : session.access_token;
}

async function ensureFreshToken() {
  return withSessionLock(() => runRefresh({ force: false }));
}

async function forceRefreshOnce() {
  return withSessionLock(() => runRefresh({ force: true }));
}

async function revokeRemoteSession(accessToken) {
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  } catch {
    // Always clear local storage even if revoke fails.
  }
}

// One-shot migration for installs that predate this change: they hold an access
// token and no refresh token, so they still expire in an hour. While that access
// token is still valid it is enough to mint a proper session, and the user never
// sees a sign-in prompt.
//
// This runs on every service worker wake, which is often. It must therefore
// remember what happened, or a permanent failure becomes a permanent retry loop
// against a rate-limited endpoint. It previously recorded only 401s, so a 404 —
// exactly what production returns until this ships — retried forever.
const UPGRADE_BACKOFF_MS = 60 * 60 * 1000;

async function maybeUpgradeLegacySession() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.access,
    STORAGE_KEYS.refresh,
    STORAGE_KEYS.upgradeFailed,
    STORAGE_KEYS.upgradeAttemptedAt,
  ]);

  if (stored[STORAGE_KEYS.refresh]) return;
  if (stored[STORAGE_KEYS.upgradeFailed]) return;
  if (!stored[STORAGE_KEYS.access]) return;

  const generation = sessionGeneration;

  const lastAttempt = stored[STORAGE_KEYS.upgradeAttemptedAt];
  if (typeof lastAttempt === 'number' && Date.now() - lastAttempt < UPGRADE_BACKOFF_MS) {
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.upgradeAttemptedAt]: Date.now() });

  try {
    const res = await fetch(`${API_BASE}/auth/extension/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stored[STORAGE_KEYS.access]}`,
        'Content-Type': 'application/json',
      },
    });

    // 429 is a 4xx but is the one that WILL succeed later — it must fall
    // through to the backoff, not the permanent sentinel. Anything else in the
    // 4xx range means retrying cannot help until the user signs in again:
    // 401 expired, 403 no verified email, 404 endpoint not deployed.
    if (res.status !== 429 && res.status >= 400 && res.status < 500) {
      await chrome.storage.local.set({ [STORAGE_KEYS.upgradeFailed]: true });
      return;
    }

    // 429 and 5xx: transient. The timestamp above holds off the next attempt.
    if (!res.ok) return;

    const session = await res.json();

    // Same rule as the refresh path: this fetch was in flight for a while, and
    // the user may have signed out during it. Commit on the lock, and only if
    // the session we started from is still the current one.
    await withSessionLock(async () => {
      if (generation !== sessionGeneration) return;
      await setSession(session);
      await chrome.storage.local.remove([
        STORAGE_KEYS.upgradeFailed,
        STORAGE_KEYS.upgradeAttemptedAt,
      ]);
    });
  } catch {
    // Network blip. The timestamp holds off the retry; the existing access
    // token stays in place and keeps working until it expires.
  }
}

function storeIncomingAuth(message) {
  const session = normalizeSession({
    access_token: message.token,
    refresh_token: message.refresh_token,
    expires_at: message.expires_at,
  });
  if (!session) {
    return Promise.reject(new Error('Invalid token'));
  }
  // On the lock, and bumping the generation, for two reasons. A refresh still
  // in flight from the previous session must not overwrite the session we are
  // about to write. And a fresh sign-in clears the upgrade sentinel and
  // backoff — without that, signing in again without an explicit sign-out
  // first would carry stale state from a failed upgrade.
  return withSessionLock(async () => {
    sessionGeneration += 1;
    await setSession(session);
    await chrome.storage.local.remove([
      STORAGE_KEYS.upgradeFailed,
      STORAGE_KEYS.upgradeAttemptedAt,
    ]);
  });
}

maybeUpgradeLegacySession();

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isTrustedWebSender(sender)) {
    sendResponse({ success: false, error: 'Untrusted sender' });
    return false;
  }

  if (message.type === 'WAVELENGTH_AUTH' && typeof message.token === 'string') {
    storeIncomingAuth(message)
      .then(() => {
        sendResponse({ success: true });
        chrome.runtime.sendMessage({
          type: 'AUTH_SUCCESS',
          token: message.token,
          refresh_token: message.refresh_token,
          expires_at: message.expires_at,
        });
      })
      .catch(() => sendResponse({ success: false, error: 'Invalid token' }));
    return true;
  }

  return false;
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_TOKEN') {
    getAuthToken().then(sendResponse);
    return true;
  }

  if (request.type === 'SET_TOKEN') {
    if (!isExtensionSender(sender) && !isTrustedWebSender(sender)) {
      sendResponse({ success: false, error: 'Untrusted sender' });
      return false;
    }
    storeIncomingAuth(request)
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false, error: 'Invalid token' }));
    return true;
  }

  if (request.type === 'CLEAR_TOKEN') {
    // Sign-out now revokes the refresh token at Supabase before clearing
    // storage, so this message has an effect that outlives the browser. It was
    // unguarded while it only deleted a local copy; that is no longer a fair
    // trade. The popup is the only legitimate sender and runs at the extension
    // origin, so content scripts — including anything injected into a Gmail
    // tab — cannot reach it.
    if (!isExtensionSender(sender)) {
      sendResponse({ success: false, error: 'Untrusted sender' });
      return false;
    }
    // Runs on the session lock so it cannot interleave with a refresh that is
    // mid-write. Without that, sign-out could clear storage between the
    // generation check and the write, and the refresh would resurrect the
    // session milliseconds later.
    withSessionLock(async () => {
      const session = await getStoredSession().catch(() => null);
      if (session?.access_token) {
        await revokeRemoteSession(session.access_token);
      }
      await clearSession();
    })
      .catch(() => {})
      .then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === 'GET_USER_INFO') {
    getAuthToken().then(async (token) => {
      if (!token) return sendResponse({ error: 'No token' });
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        sendResponse({
          email: payload.email || '',
          name: payload.user_metadata?.display_name || payload.user_metadata?.name || '',
          displayName: payload.user_metadata?.display_name || payload.user_metadata?.name || '',
        });
      } catch {
        sendResponse({ error: 'Invalid token' });
      }
    });
    return true;
  }

  if (request.type === 'GET_MY_STYLE') {
    handleApiCall('/auth/me')
      .then((user) => sendResponse({ commStyle: user?.profile?.commStyle || null }))
      .catch(() => sendResponse({ commStyle: null }));
    return true;
  }

  if (request.type === 'API_CALL') {
    handleApiCall(request.endpoint, request.method, request.body)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'RESOLVE_EMAIL') {
    resolveEmail(request.email)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'ANALYZE') {
    analyzeMessage(request.body)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'ACCEPT_SUGGESTION') {
    acceptSuggestion(request.eventId, request.rewrittenText)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});

async function handleApiCall(endpoint, method = 'GET', body = null) {
  let token = await ensureFreshToken();
  if (!token) throw new Error('Not authenticated');

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  let res = await fetch(`${API_BASE}${endpoint}`, options);

  if (res.status === 401) {
    const refreshed = await forceRefreshOnce();
    if (refreshed) {
      token = refreshed;
      options.headers.Authorization = `Bearer ${token}`;
      res = await fetch(`${API_BASE}${endpoint}`, options);
    }
  }

  if (res.status === 401) {
    // Refresh already had its one chance above. On the lock, like every other
    // session mutation, so it cannot land in the middle of one.
    await withSessionLock(() => clearSession());
    chrome.runtime.sendMessage({ type: 'AUTH_EXPIRED' }).catch(() => {});
    throw new Error('Your session has expired. Please sign in again.');
  }

  if (!res.ok) throw new Error('Something went wrong. Please try again.');
  return res.json();
}

async function resolveEmail(email) {
  return handleApiCall(`/users/by-email?email=${encodeURIComponent(email)}`);
}

async function analyzeMessage(body) {
  return handleApiCall('/coaching/analyze', 'POST', body);
}

async function acceptSuggestion(eventId, rewrittenText) {
  const body = rewrittenText ? { rewritten_text: rewrittenText } : {};
  return handleApiCall(`/coaching/events/${eventId}/accept`, 'PATCH', body);
}
