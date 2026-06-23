// Wavelength Chrome Extension — Background Service Worker
// Manages auth token storage and proxies API calls for content scripts

const API_BASE = 'https://api-production-dad4.up.railway.app/api/v1';
const TRUSTED_WEB_ORIGIN = 'https://mywavelength.ai';

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

// Store/retrieve auth token
async function getAuthToken() {
  const result = await chrome.storage.local.get('wavelength_token');
  return result.wavelength_token || null;
}

async function setAuthToken(token) {
  await chrome.storage.local.set({ wavelength_token: token });
}

async function clearAuthToken() {
  await chrome.storage.local.remove('wavelength_token');
}

// Handle auth tokens from the web app (externally_connectable)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isTrustedWebSender(sender)) {
    sendResponse({ success: false, error: 'Untrusted sender' });
    return false;
  }

  if (message.type === 'WAVELENGTH_AUTH' && typeof message.token === 'string') {
    setAuthToken(message.token).then(() => {
      sendResponse({ success: true });
      // Notify any open popups / content scripts
      chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS', token: message.token });
    });
    return true;
  }
});

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_TOKEN') {
    getAuthToken().then(sendResponse);
    return true; // async response
  }

  if (request.type === 'SET_TOKEN') {
    if (!isExtensionSender(sender) && !isTrustedWebSender(sender)) {
      sendResponse({ success: false, error: 'Untrusted sender' });
      return false;
    }
    if (typeof request.token !== 'string' || request.token.length < 20) {
      sendResponse({ success: false, error: 'Invalid token' });
      return false;
    }
    setAuthToken(request.token).then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === 'CLEAR_TOKEN') {
    clearAuthToken().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === 'GET_USER_INFO') {
    getAuthToken().then(async (token) => {
      if (!token) return sendResponse({ error: 'No token' });
      try {
        // Decode JWT payload to extract user info
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
});

async function handleApiCall(endpoint, method = 'GET', body = null) {
  const token = await getAuthToken();
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

  const res = await fetch(`${API_BASE}${endpoint}`, options);
  if (res.status === 401) {
    // Token is invalid or expired — clear it and notify all surfaces
    await clearAuthToken();
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
