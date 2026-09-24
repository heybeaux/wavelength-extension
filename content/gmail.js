// Wavelength Gmail Content Script — Grammarly-style button + card
// One small circular button per compose, in Gmail's Send row; one floating
// card that follows whichever compose has the cursor (WL-005).
//
// Runs as a content script in Gmail, and is also `require`d by the Jest suite
// so the card's real behaviour can be asserted rather than reimplemented.
// IN_EXTENSION gates every top-level side effect — listener registration and
// the startup scan — so requiring this file in jsdom defines the functions and
// starts nothing. It is true in any real browser context, so the shipped
// behaviour is unchanged. See the CommonJS export at the end of the file.
const IN_EXTENSION =
  typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;

const DEBOUNCE_MS = 1500;
const RECIPIENT_POLL_MS = 100;
const RECIPIENT_POLL_CEILING_MS = 3000;
const APP_URL = 'https://mywavelength.ai';
const CARD_ID = 'wl-coaching-card';
const CARD_WIDTH_PX = 300;
const CARD_GAP_PX = 8;
const CARD_VIEWPORT_PAD_PX = 8;
const GMAIL_TOP_CHROME_PX = 64; // sticky header — keep the fixed card out from under it
const BTN_SIZE_PX = 32;
const BTN_BOTTOM_PAD_PX = 8;
const BTN_RIGHT_PAD_PX = 48;
const BTN_WRAP_INSET_PX = 6; // (44 - 32) / 2: the wrap centres the button

// ─── Font injection (MV3-safe) ──────────────────────────────────────
(function injectFonts() {
  if (!IN_EXTENSION) return; // chrome.runtime.getURL is unavailable under Jest
  const fonts = [
    { family: 'WL Inter Tight', weight: '400', file: 'fonts/InterTight-Regular.ttf' },
    { family: 'WL Inter Tight', weight: '500', file: 'fonts/InterTight-Medium.ttf' },
    { family: 'WL Inter Tight', weight: '600', file: 'fonts/InterTight-SemiBold.ttf' },
    { family: 'WL Inter Tight', weight: '700', file: 'fonts/InterTight-Bold.ttf' },
    { family: 'WL Fraunces', weight: '600', file: 'fonts/Fraunces_72pt_SuperSoft-SemiBold.ttf' },
  ];
  const css = fonts.map(f =>
    `@font-face { font-family: '${f.family}'; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: url('${chrome.runtime.getURL(f.file)}') format('truetype'); }`
  ).join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
})();

// ─── State ───────────────────────────────────────────────────────────
// Per-compose state: `composes` looks a state up by its editable; `liveComposes`
// is the iterable view (a WeakMap cannot be walked). Any number of composes can
// be registered at once. `activeComposeEl` is the FOCUSED compose: the one the
// single shared card shows and the only one whose card ever opens.
const composes = new WeakMap();
const liveComposes = new Set();
let activeComposeEl = null;
let discoveryInstalled = false;

// Shared-card follow handles (one card, so one set).
let cardFollowRaf = null;
let cardFollowScrollHandler = null;
let cardFollowResizeHandler = null;
let cardHostResizeObserver = null;
let cardVisibilityObserver = null;

// One follower for every body-mounted button (the fallback mount, §4 of the
// plan). Installed only while at least one such button exists.
let bodyFollowRaf = null;
let bodyFollowHandler = null;

// email → { id, at }. Positive hits live for the page; a miss is retried after
// EMAIL_NEGATIVE_TTL_MS (a recipient who signs up later, a transient error).
// Cleared whenever the token changes.
const emailCache = new Map();
let hasToken = false;
let lastToken = null;
let lastAuthCheckAt = 0;
let cachedUserInfo = null;

const APPLY_SETTLE_MS = 500; // Gmail settles its DOM churn after our own writes
const AUTH_RECHECK_MS = 5000; // sign-in never reaches this tab (WL-024): re-ask on focus, throttled
const EMAIL_NEGATIVE_TTL_MS = 60 * 1000;

// Multi-level undo for Apply / subject Use (Cmd+Z does not cover Range writes).
const WL_UNDO_CAP = 10;
const UNDO_REFUSE_REASON =
  "Can't undo safely — the draft changed shape after applying. Edit the text directly instead.";

// Stroke-outline icons (exact paths from docs/plans/card-undo-and-ui.md). Do not substitute.
const WL_ICON_REGEN =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>';
const WL_ICON_UNDO =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h11a5 5 0 0 1 0 10H8"/><path d="M7 4 3 8l4 4"/></svg>';
const WL_ICON_TICK =
  '<svg class="wl-done-tick" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7"/></svg>';
// The button mark. `currentColor` so the quiet (unfocused) variant recolours by CSS.
const WL_BTN_LOGO =
  '<svg viewBox="0 0 200 200" width="20" height="20" aria-hidden="true"><path d="M 44 54 L 76 146 L 108 85 L 128 128 L 156 92" fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Same two selectors the compose scanner used; a compose editable is one of these.
const COMPOSE_EDITABLE_SELECTOR =
  '[role="dialog"] [contenteditable="true"][aria-label], [contenteditable="true"][aria-label="Message Body"]';

// ─── Per-compose state ───────────────────────────────────────────────
// Everything that used to be a module-level "the compose" variable lives here,
// one object per editable. Four pieces stay on the element itself because the
// card code reads them there: `_wlUndoStack`, `_wlSource`, `_wlLastResult`,
// `_wlWantFooter`.
function createComposeState(el) {
  return {
    el,
    // The node Gmail removes when this compose closes: the popup dialog, or the
    // inline reply's `.M9` block (discard and pop-out remove that, twenty levels
    // above the editable; probed live 2026-09-24). Its parent is observed.
    closeRoot: el.closest('[role="dialog"]') || el.closest('.M9'),
    host: null, // the compose chrome around the editable; visibility and the body fallback read it
    footer: null, // Gmail's Send row (`.aDh`) when the button is mounted in it
    owner: `wl${Math.random().toString(36).slice(2, 10)}`, // stamps this compose's button
    mount: null, // 'row' | 'body'
    wrap: null, // .wl-btn-wrap: the 44px box holding the button and its badge
    btn: null,
    badge: null,
    debounceTimer: null,
    recipientPollTimer: null,
    applyingTimer: null,
    contentObserver: null,
    closeObserver: null,
    footerObserver: null,
    hostResize: null,
    onInput: null,
    lastDraft: '', // dedupe key: always the live zone-1 text (see analyzeCurrentDraft)
    lastEventId: null,
    runSeq: 0, // bumped per ANALYZE request; an older response never overwrites a newer one
    applying: false, // our own write is in progress: observers and input must stand down
    card: null, // { status, data }: the last updateCard for this compose, painted or not
    appliedEventId: null, // the result whose rewrite is in the box; drives the Applied pill
    status: 'idle', // idle | analyzing | ready | attention | error — drives the badge
  };
}

function getState(el) {
  return (el && composes.get(el)) || null;
}

function isAlive(state) {
  return !!state && composes.get(state.el) === state && state.el.isConnected;
}

function isActive(composeEl) {
  return !!composeEl && composeEl === activeComposeEl;
}

// Frozen view for the test suite: never the mutable state itself.
function getComposeSnapshot(el) {
  const state = getState(el);
  if (!state) return Object.freeze({ registered: false, active: false, status: null, mount: null });
  return Object.freeze({
    registered: true,
    active: isActive(el),
    status: state.status,
    mount: state.mount,
  });
}

function setApplying(state) {
  if (!state) return;
  clearTimeout(state.applyingTimer);
  state.applyingTimer = null;
  state.applying = true;
}

// Release after Gmail has settled its DOM updates. Must run on every path,
// including refusal, or every later input and mutation is dropped.
function releaseApplying(state) {
  if (!state) return;
  clearTimeout(state.applyingTimer);
  state.applyingTimer = setTimeout(() => {
    state.applying = false;
    state.applyingTimer = null;
  }, APPLY_SETTLE_MS);
}

// ─── Bootstrap ───────────────────────────────────────────────────────
// ─── Auth check ──────────────────────────────────────────────────────
async function checkAuth() {
  let token = null;
  try {
    token = (await chrome.runtime.sendMessage({ type: 'GET_TOKEN' })) || null;
  } catch {
    token = null;
  }
  if (token !== lastToken) emailCache.clear(); // one account's visibility never serves another
  lastToken = token;
  hasToken = !!token;
  if (hasToken) fetchUserInfo();
}

async function fetchUserInfo() {
  try {
    const info = await chrome.runtime.sendMessage({ type: 'GET_USER_INFO' });
    if (info && !info.error) {
      cachedUserInfo = info;
    }
  } catch {
    // Non-critical — button will show "W" fallback
  }
}

function getUserInitial() {
  const name = cachedUserInfo?.displayName || cachedUserInfo?.name;
  if (name) return name.trim().charAt(0).toUpperCase();
  return 'W';
}

// Sign-in and sign-out never reach this tab as messages (the background's
// runtime.sendMessage is delivered to extension pages only, WL-024), so the
// token is re-asked on focus, throttled, whenever we think we are signed out.
function maybeRecheckAuth() {
  const now = Date.now();
  if (now - lastAuthCheckAt < AUTH_RECHECK_MS) return Promise.resolve(hasToken);
  lastAuthCheckAt = now;
  return checkAuth().then(() => hasToken);
}

if (IN_EXTENSION) {
  installDiscovery();
  checkAuth().then(reconcileActive);
}

// ─── Compose discovery ───────────────────────────────────────────────
// Composes are found by focus, never by scanning the page: the moment the
// cursor lands anywhere in a compose (body, To, Subject) that compose is
// registered if new and made active. Nothing runs between focus changes.
// One call registers every document-level listener this file owns; it is
// idempotent so the suite can install it too.
function installDiscovery() {
  if (discoveryInstalled) return;
  discoveryInstalled = true;
  document.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('focus', reconcileActive);
  document.addEventListener('visibilitychange', reconcileActive);
  window.addEventListener('hashchange', pruneLiveComposes); // Gmail navigates by hash
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
}

// The compose root around a node, in the same precedence zones.js uses.
function composeSurfaceFor(node) {
  if (!(node instanceof Element)) return null;
  return (
    node.closest('[role="dialog"]') ||
    node.closest('table.aoP') ||
    node.closest('div.aoI')
  );
}

// The compose editable a focused or clicked node belongs to, or null. Our own
// UI never counts. A surface qualifies only when it holds exactly one compose
// editable, so Gmail's search, chat and settings dialogs never match.
function composeForNode(node) {
  const el = node instanceof Element ? node : node?.parentElement;
  if (!el) return null;
  if (el.closest('.wl-card, .wl-btn-wrap')) return null;
  if (el.matches(COMPOSE_EDITABLE_SELECTOR) && isComposeMessageEditable(el)) return el;
  const surface = composeSurfaceFor(el);
  if (!surface) return null;
  const editables = [...surface.querySelectorAll('[contenteditable="true"][aria-label]')].filter(
    isComposeMessageEditable,
  );
  return editables.length === 1 ? editables[0] : null;
}

function onFocusIn(e) {
  if (!hasToken) {
    maybeRecheckAuth().then((ok) => {
      if (ok) discover(document.activeElement);
    });
    return;
  }
  discover(e.target);
}

function reconcileActive() {
  pruneLiveComposes();
  if (!hasToken) {
    maybeRecheckAuth().then((ok) => {
      if (ok) discover(document.activeElement);
    });
    return;
  }
  discover(document.activeElement);
}

function discover(node) {
  if (!hasToken) return;
  const el = composeForNode(node);
  if (!el) return;
  let state = getState(el);
  if (!state) {
    // A compose without a visible Send row is not one we can mount in yet
    // (mid-render, minimised). The next focus into it retries.
    if (!findVisibleComposeFooter(el, findHost(el))) return;
    state = registerCompose(el);
  } else {
    ensureButton(state);
  }
  if (!isActive(el)) activate(el);
  // First focus after a sign-in: a compose stuck on a session error is coached
  // again. The error path blanked its dedupe key, so this run never repeats.
  if (state.status === 'error' && isSessionError(state.card?.data?.message)) {
    scheduleAnalysis(state);
  }
}

// Composes Gmail removed together with an ancestor (leaving a thread with an
// inline reply) never fire their own close observer. Sweep on the events we
// already handle.
function pruneLiveComposes() {
  for (const state of [...liveComposes]) {
    if (!state.el.isConnected) teardownCompose(state);
  }
}

function clearRecipientPoll(state) {
  if (state && state.recipientPollTimer !== null) {
    clearTimeout(state.recipientPollTimer);
    state.recipientPollTimer = null;
  }
}

// Wait for extractRecipientEmails to resolve, then analyse once. Replaces the
// bare attach-time call — Gmail often renders the body before the To row.
// Non-empty is safe: extractRecipientEmails only counts chips in a compose
// To/Cc/Bcc row, so thread-header chips cannot satisfy the stop (WL-047).
// A setTimeout chain, not an interval: it dies with its compose (WL-023).
function pollForRecipientThenAnalyze(state) {
  clearRecipientPoll(state);
  const startedAt = Date.now();

  function tick() {
    state.recipientPollTimer = null;
    if (!isAlive(state)) return;

    const emails = extractRecipientEmails(state.el);
    const elapsed = Date.now() - startedAt;

    if (emails.length > 0 || elapsed >= RECIPIENT_POLL_CEILING_MS) {
      analyzeCurrentDraft(state.el);
      return;
    }
    state.recipientPollTimer = setTimeout(tick, RECIPIENT_POLL_MS);
  }

  tick();
}

function scheduleAnalysis(state) {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => analyzeCurrentDraft(state.el), DEBOUNCE_MS);
}

// ─── Register / activate / tear down ─────────────────────────────────
// Create this compose's state, button, listeners and observers, and run the
// attach-time analysis. Does not make it the active compose; activate does.
function registerCompose(composeEl) {
  const existing = getState(composeEl);
  if (existing) return existing;

  const state = createComposeState(composeEl);
  composes.set(composeEl, state);
  liveComposes.add(state);
  state.host = findHost(composeEl);

  mountButton(state);

  // Listen for input with debounce — a closure per compose, so typing in one
  // compose can never reset another's timer.
  state.onInput = () => {
    if (state.applying) return;
    ensureButton(state);
    scheduleAnalysis(state);
  };
  composeEl.addEventListener('input', state.onInput);

  // Expand/collapse mutates the editable without firing input (Probe B).
  // Observed on the editable only, never the compose chrome around it, or our
  // own badge and spinner changes would loop the analysis.
  state.contentObserver = new MutationObserver(() => {
    if (state.applying) return;
    ensureButton(state);
    if (isActive(composeEl)) {
      const body = getCard().querySelector('.wl-card-body');
      if (body) syncUseThisEligibility(body, composeEl);
    }
    scheduleAnalysis(state);
  });
  state.contentObserver.observe(composeEl, { childList: true, subtree: true });

  // Watch for compose close. A childList observer on the dialog's parent never
  // sees our own writes, so it needs no `applying` gate. Gmail re-parents
  // popups when it slides them sideways, so a removal is only a close once the
  // node is still gone a tick later.
  if (state.closeRoot?.parentNode) {
    state.closeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node === state.closeRoot || node.contains?.(composeEl)) {
            setTimeout(() => {
              if (!state.el.isConnected) teardownCompose(state);
            }, 0);
            return;
          }
        }
      }
    });
    state.closeObserver.observe(state.closeRoot.parentNode, { childList: true });
  }

  // Analyse once on registration so drafts (and any pre-filled compose) coach
  // without waiting for input. Empty composes stay silent — analyzeCurrentDraft
  // already guards on length. Never repeated on a later focus.
  pollForRecipientThenAnalyze(state);

  return state;
}

// Make this compose the one the shared card shows. Never triggers an analysis:
// the compose's own dedupe key still gates the next input-driven run.
function activate(composeEl) {
  const state = getState(composeEl);
  if (!state) return;

  const previous = getState(activeComposeEl);
  const cardWasOpen = isCardOpen();

  // Switch the slot first: the visuals read it to pick filled vs quiet.
  activeComposeEl = composeEl;
  if (previous && previous !== state) setButtonFocused(previous, false);
  setButtonFocused(state, true);

  // The card always repaints from THIS compose's last snapshot (or the hint),
  // and its actions rebind to this compose. It reopens only when it was open
  // and this compose has a result: close-then-reopen, so the existing fade
  // marks the switch instead of a jump.
  hideCoachingCard();
  paintCardFromState(state);
  if (cardWasOpen && state.card?.status === 'result') showCoachingCard(composeEl);
}

// Undo everything registerCompose did for one compose. Takes the state, or
// the editable (the suite's handle).
function teardownCompose(stateOrEl) {
  const state = stateOrEl instanceof Element ? getState(stateOrEl) : stateOrEl;
  if (!state) return;
  const el = state.el;

  state.contentObserver?.disconnect();
  state.contentObserver = null;
  state.closeObserver?.disconnect();
  state.closeObserver = null;
  state.footerObserver?.disconnect();
  state.footerObserver = null;
  state.hostResize?.disconnect();
  state.hostResize = null;
  clearTimeout(state.debounceTimer);
  state.debounceTimer = null;
  clearRecipientPoll(state);
  clearTimeout(state.applyingTimer);
  state.applyingTimer = null;

  if (state.onInput) el.removeEventListener('input', state.onInput);
  state.onInput = null;
  state.wrap?.remove();
  state.wrap = null;
  state.btn = null;
  state.badge = null;
  el._wlBtn = null;
  el._wlUndoStack = null;
  el._wlSource = null;
  el._wlLastResult = null;
  el._wlWantFooter = undefined;

  if (composes.get(el) === state) composes.delete(el);
  liveComposes.delete(state);

  if (activeComposeEl === el) {
    activeComposeEl = null;
    hideCoachingCard();
  }
  syncBodyFollower();
}

function getUndoStack(composeEl) {
  if (!composeEl) return [];
  if (!Array.isArray(composeEl._wlUndoStack)) composeEl._wlUndoStack = [];
  return composeEl._wlUndoStack;
}

function pushUndoSnapshot(composeEl, snapshot) {
  const stack = getUndoStack(composeEl);
  stack.push(snapshot);
  while (stack.length > WL_UNDO_CAP) stack.shift();
}

/**
 * Find Gmail's subject input for this compose.
 *
 * Pop-out / new-compose: inside `[role="dialog"]`.
 * Inline reply: NOT inside `.aO7` — it sits higher in `table.aoP` / the compose
 * form, often hidden until "Edit subject". Walking only `.aO7` made Subject
 * Use a silent no-op on every inline reply.
 */
function findSubjectInput(composeEl) {
  if (!composeEl) return null;

  const dialog = composeEl.closest('[role="dialog"]');
  if (dialog) {
    const input = dialog.querySelector(
      'input[name="subjectbox"], input[aria-label="Subject"]',
    );
    if (input) return input;
  }

  let node = composeEl.parentElement;
  for (let depth = 0; node && depth < 24; depth++) {
    const inputs = node.querySelectorAll(
      'input[name="subjectbox"], input[aria-label="Subject"]',
    );
    for (const input of inputs) {
      const inputDialog = input.closest('[role="dialog"]');
      if (inputDialog && !inputDialog.contains(composeEl)) continue;

      // Reject a subject that belongs to another compose body in this subtree.
      const foreignOwner = [
        ...node.querySelectorAll(
          '[aria-label="Message Body"][contenteditable="true"]',
        ),
      ].find((body) => {
        if (body === composeEl) return false;
        const scope =
          body.closest('[role="dialog"]') || body.closest('.aO7');
        return (
          scope && scope.contains(input) && !scope.contains(composeEl)
        );
      });
      if (foreignOwner) continue;

      return input;
    }
    node = node.parentElement;
  }
  return null;
}

function getSubjectValue(composeEl) {
  return findSubjectInput(composeEl)?.value ?? '';
}

function setSubjectValue(composeEl, value) {
  const subjectInput = findSubjectInput(composeEl);
  if (!subjectInput) return false;

  // Gmail listens to the native value setter; a plain `.value =` can be ignored.
  const desc = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  );
  if (desc && typeof desc.set === 'function') {
    desc.set.call(subjectInput, value);
  } else {
    subjectInput.value = value;
  }
  subjectInput.dispatchEvent(new Event('input', { bubbles: true }));
  subjectInput.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function isSubjectInputVisible(input) {
  if (!input || !(input instanceof Element)) return false;
  if (input.offsetParent === null) return false;
  const rect = input.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getComposeEditable(composeEl) {
  if (!composeEl) return null;
  return composeEl.getAttribute('contenteditable') === 'true'
    ? composeEl
    : composeEl.querySelector('[contenteditable="true"]');
}

/**
 * Header: recipient name + style tag when resolved; otherwise "Wavelength".
 */
function setCardHeader(card, recipientSummary) {
  const header = card?.querySelector('.wl-card-header');
  if (!header) return;
  const closeBtn = header.querySelector('.wl-card-close');
  header.querySelectorAll('.wl-card-title, .wl-tag').forEach((el) => el.remove());

  const title = document.createElement('span');
  if (recipientSummary?.name) {
    title.className = 'wl-card-title wl-card-title--name';
    title.textContent = recipientSummary.name;
    header.insertBefore(title, closeBtn);
    if (recipientSummary.comm_style) {
      const tag = document.createElement('span');
      tag.className = 'wl-tag';
      tag.textContent = recipientSummary.comm_style;
      header.insertBefore(tag, closeBtn);
    }
  } else {
    title.className = 'wl-card-title';
    title.textContent = 'Wavelength';
    header.insertBefore(title, closeBtn);
  }
}

/**
 * Undo icon ← stack length. Applied pill is independent (markUseThisApplied).
 * Call after every result paint and after refusal UI.
 */
function rehydrateActionRow(container, composeEl) {
  const actions = container?.querySelector('.wl-actions');
  if (!actions || !composeEl) return;

  const stack = getUndoStack(composeEl);
  let undoBtn = actions.querySelector('[data-action="undo"]');

  if (stack.length === 0) {
    undoBtn?.remove();
    return;
  }

  if (!undoBtn) {
    undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'wl-btn-icon';
    undoBtn.setAttribute('data-action', 'undo');
    undoBtn.setAttribute('aria-label', 'Undo');
    undoBtn.setAttribute('data-tip', 'Undo');
    undoBtn.innerHTML = WL_ICON_UNDO;
    actions.appendChild(undoBtn);
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      undoRewrite(container, composeEl);
    });
  }
}

function wakeUseThisButton(container, composeEl) {
  const actions = container?.querySelector('.wl-actions');
  if (!actions) return;

  actions.querySelector('.wl-done')?.remove();

  let useBtn = actions.querySelector('[data-action="use"]');
  if (!useBtn) {
    useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'wl-btn-use';
    useBtn.setAttribute('data-action', 'use');
    useBtn.setAttribute('aria-label', 'Use this rewrite');
    useBtn.textContent = 'Use this';
    const regen = actions.querySelector('[data-action="regen"]');
    actions.insertBefore(useBtn, regen || actions.firstChild);
    if (typeof container._wlOnUse === 'function') {
      useBtn.addEventListener('click', container._wlOnUse);
    }
  } else {
    useBtn.disabled = false;
    useBtn.removeAttribute('aria-disabled');
    useBtn.classList.remove('wl-btn-applied', 'wl-btn-refused');
    useBtn.textContent = 'Use this';
    useBtn.setAttribute('aria-label', 'Use this rewrite');
    useBtn.removeAttribute('data-tip');
    useBtn.removeAttribute('title');
  }
  syncUseThisEligibility(container, composeEl || activeComposeEl);
}

function markUseThisApplied(container) {
  const actions = container?.querySelector('.wl-actions');
  if (!actions) return;

  const useBtn = actions.querySelector('[data-action="use"]');
  useBtn?.remove();

  if (actions.querySelector('.wl-done')) return;

  const pill = document.createElement('div');
  pill.className = 'wl-done';
  pill.setAttribute('role', 'status');
  pill.innerHTML = `${WL_ICON_TICK}<span>Applied</span>`;
  const regen = actions.querySelector('[data-action="regen"]');
  actions.insertBefore(pill, regen || actions.firstChild);
}

function markSubjectApplied(container) {
  const useSubjectBtn = container?.querySelector('[data-action="use-subject"]');
  if (!useSubjectBtn) return;
  useSubjectBtn.textContent = 'Applied \u2713';
  useSubjectBtn.disabled = true;
  useSubjectBtn.setAttribute('aria-disabled', 'true');
}

function showReasonPanel(container, text, className) {
  let reason = container.querySelector(`.${className}`);
  if (!reason) {
    reason = document.createElement('div');
    reason.className = `wl-reason ${className}`;
    const actions = container.querySelector('.wl-actions');
    if (actions && actions.parentNode) {
      // Artifact: reason sits above the action row.
      actions.parentNode.insertBefore(reason, actions);
    } else {
      container.appendChild(reason);
    }
  }
  reason.replaceChildren();
  const ico = document.createElement('span');
  ico.className = 'wl-reason-ico';
  ico.setAttribute('aria-hidden', 'true');
  ico.textContent = '\u25B2';
  const msg = document.createElement('span');
  msg.textContent = text;
  reason.append(ico, msg);
  if (activeComposeEl) positionCoachingCard(activeComposeEl);
}

function showUndoRefusal(container) {
  showReasonPanel(container, UNDO_REFUSE_REASON, 'wl-undo-refuse-reason');
}

function clearUndoRefusal(container) {
  container?.querySelector('.wl-undo-refuse-reason')?.remove();
}

/**
 * Subject row only when Gmail's subject field is visibly present.
 * Re-checked on renderResult, card show, and after undo — no poller/observer.
 */
function syncSubjectRow(container, result, composeEl) {
  if (!container) return;

  const existing = container.querySelector('.wl-subject-row');
  const suggested = result?.suggested_subject;
  const visible = isSubjectInputVisible(findSubjectInput(composeEl));

  if (!suggested || !visible) {
    existing?.remove();
    return;
  }

  if (existing) {
    const text = existing.querySelector('.wl-subject-text');
    if (text) text.textContent = suggested;
    return;
  }

  const row = document.createElement('div');
  row.className = 'wl-subject-row';
  row.innerHTML = `
    <span class="wl-subject-label">Subject:</span>
    <span class="wl-subject-text">${escapeHtml(suggested)}</span>
    <button type="button" class="wl-btn-subject" data-action="use-subject" aria-label="Use subject">Use</button>
  `;

  const rewrite = container.querySelector('.wl-rewrite-section');
  if (rewrite) {
    container.insertBefore(row, rewrite);
  } else {
    container.insertBefore(row, container.firstChild);
  }

  const useSubjectBtn = row.querySelector('[data-action="use-subject"]');
  if (useSubjectBtn && composeEl) {
    useSubjectBtn.addEventListener('click', () => {
      const subjectInput = findSubjectInput(composeEl);
      if (!isSubjectInputVisible(subjectInput)) {
        syncSubjectRow(container, result, composeEl);
        return;
      }
      const subjectBefore = subjectInput.value;
      pushUndoSnapshot(composeEl, {
        zone1Html: null,
        subject: subjectBefore,
        lastDraft: getState(composeEl)?.lastDraft ?? '',
        hadFooter: false,
        wroteBody: false,
        subjectChanged: true,
      });
      if (!setSubjectValue(composeEl, suggested)) return;
      markSubjectApplied(container);
      rehydrateActionRow(container, composeEl);
      if (activeComposeEl) positionCoachingCard(activeComposeEl);
    });
  }

  if (
    composeEl &&
    getUndoStack(composeEl).some((s) => s.subjectChanged && !s.wroteBody)
  ) {
    markSubjectApplied(container);
  }
}

/**
 * Pop one undo level. Body restore refuses without a corroborated boundary
 * (keeps stack). Subject still restores. Subject-only entries skip the body.
 */
function undoRewrite(container, composeEl) {
  if (!composeEl) return;
  const stack = getUndoStack(composeEl);
  if (stack.length === 0) return;

  const entry = stack[stack.length - 1];
  const state = getState(composeEl);
  setApplying(state);
  clearTimeout(state?.debounceTimer);
  clearUndoRefusal(container);

  try {
    const editable = getComposeEditable(composeEl);

    if (entry.wroteBody) {
      if (!editable) {
        stack.length = 0;
        composeEl._wlSource = null; // box state unknown: regen falls back to live
        rehydrateActionRow(container, composeEl);
        wakeUseThisButton(container, composeEl);
        return;
      }

      const result = restoreZone1Html(editable, entry.zone1Html || '', {
        heldAtApply: !!entry.heldAtApply,
      });
      if (
        !result.ok &&
        (result.reason === 'no-boundary' || result.reason === 'tree-changed')
      ) {
        // Gate zone-1 only — subject still restores; keep stack for retry.
        if (entry.subjectChanged) {
          setSubjectValue(composeEl, entry.subject);
        }
        showUndoRefusal(container);
        rehydrateActionRow(container, composeEl);
        return;
      }
      if (!result.ok) {
        // Throw / malformed — leave tree, clear undo state. Never innerHTML fallback.
        stack.length = 0;
        composeEl._wlSource = null;
        rehydrateActionRow(container, composeEl);
        wakeUseThisButton(container, composeEl);
        return;
      }

      // Orphaned footer from this apply (snapshot itself had none).
      if (
        entry.hadFooter &&
        !(entry.zone1Html || '').includes('mywavelength.ai')
      ) {
        stripWavelengthFooters(editable);
      }

      editable.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (entry.subjectChanged) {
      setSubjectValue(composeEl, entry.subject);
    }

    if (state) state.lastDraft = entry.lastDraft;
    // The box is back to what this entry's card was coached from.
    if (entry.wroteBody) composeEl._wlSource = entry.source || null;
    stack.pop();
    if (entry.wroteBody && state) {
      state.appliedEventId = null;
      applyButtonVisuals(state);
    }

    // Body undo (or any wroteBody pop) wakes primary — card still offers a rewrite
    // the body no longer contains. Subject-only undo leaves body Applied when a
    // wroteBody entry remains on the stack.
    if (entry.wroteBody) {
      wakeUseThisButton(container, composeEl);
    }

    const subjectBtn = container.querySelector('[data-action="use-subject"]');
    if (subjectBtn) {
      const stillHasSubjectOnly = stack.some(
        (s) => s.subjectChanged && !s.wroteBody,
      );
      if (!stillHasSubjectOnly) {
        subjectBtn.disabled = false;
        subjectBtn.removeAttribute('aria-disabled');
        subjectBtn.textContent = 'Use';
      }
    }

    rehydrateActionRow(container, composeEl);
    syncSubjectRow(container, composeEl._wlLastResult, composeEl);
    if (activeComposeEl) positionCoachingCard(activeComposeEl);
  } finally {
    releaseApplying(state);
  }
}

// ─── Shared card: follow, show, hide ─────────────────────────────────
function stopFollowingCard() {
  if (cardFollowRaf !== null) {
    cancelAnimationFrame(cardFollowRaf);
    cardFollowRaf = null;
  }
  if (cardFollowScrollHandler) {
    document.removeEventListener('scroll', cardFollowScrollHandler, true);
    cardFollowScrollHandler = null;
  }
  if (cardFollowResizeHandler) {
    window.removeEventListener('resize', cardFollowResizeHandler);
    cardFollowResizeHandler = null;
  }
  if (cardHostResizeObserver) {
    cardHostResizeObserver.disconnect();
    cardHostResizeObserver = null;
  }
  if (cardVisibilityObserver) {
    cardVisibilityObserver.disconnect();
    cardVisibilityObserver = null;
  }
}

function isAnchorVisible(btn) {
  if (!btn || !document.contains(btn)) return false;
  const rect = btn.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (
    rect.bottom <= 0 ||
    rect.top >= window.innerHeight ||
    rect.right <= 0 ||
    rect.left >= window.innerWidth
  ) {
    return false;
  }
  return true;
}

// The one card on the page, created on first use and re-created if something
// removed it. Its ✕ is bound once and closes whatever compose is active.
function getCard() {
  let card = document.getElementById(CARD_ID);
  if (card?.isConnected) return card;
  document.querySelectorAll('.wl-card').forEach((el) => el.remove()); // exactly one

  // Card on document.body — escapes .qz.aiL clip. Positioned fixed against the viewport.
  card = document.createElement('div');
  card.className = 'wl-card';
  card.id = CARD_ID;
  card.style.display = 'none';
  card.innerHTML = `
    <div class="wl-card-header">
      <svg class="wl-card-logo" viewBox="0 0 200 200" width="20" height="20">
        <defs><linearGradient id="wl-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#B8372B"></stop><stop offset="55%" stop-color="#D46A3A"></stop><stop offset="100%" stop-color="#EDA324"></stop></linearGradient></defs><circle cx="100" cy="100" r="96" fill="url(#wl-g)"></circle>
        <path d="M 44 54 L 76 146 L 108 85 L 128 128 L 156 92" fill="none" stroke="#FFFDFB" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
      <span class="wl-card-title">Wavelength</span>
      <button class="wl-card-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="wl-card-body">
      <p class="wl-hint">Start typing to get suggestions…</p>
    </div>
  `;
  card.querySelector('.wl-card-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hideCoachingCard();
  });
  document.body.appendChild(card);
  return card;
}

function isCardOpen() {
  const card = document.getElementById(CARD_ID);
  return !!card && card.style.display !== 'none';
}

function hideCoachingCard() {
  const card = document.getElementById(CARD_ID);
  const active = getState(activeComposeEl);
  // Keyboard users: never strand focus on a hidden card.
  if (card && card.contains(document.activeElement) && activeComposeEl) activeComposeEl.focus();
  if (card) card.style.display = 'none';
  active?.btn?.setAttribute('aria-expanded', 'false');
  stopFollowingCard();
}

function showCoachingCard(composeEl) {
  if (!isActive(composeEl)) return;
  const state = getState(composeEl);
  if (!state?.btn) return;
  // Never float an orphan card: the anchor must be on screen.
  if (!isAnchorVisible(state.btn)) return;

  const card = getCard();
  card.style.display = 'block';
  state.btn.setAttribute('aria-expanded', 'true');
  // Subject visibility can change while the card was closed (e.g. Edit subject).
  const body = card.querySelector('.wl-card-body');
  if (body && composeEl._wlLastResult) {
    syncSubjectRow(body, composeEl._wlLastResult, composeEl);
  }
  positionCoachingCard(composeEl);
  startFollowingCard(composeEl);
}

// While the card is open it follows the active compose: capture-phase scroll,
// window resize, the host's ResizeObserver, and one rect read per frame so a
// docked popup that Gmail slides sideways re-anchors it. Everything stops when
// the card closes.
function startFollowingCard(composeEl) {
  stopFollowingCard();

  const state = getState(composeEl);
  const btn = state?.btn;
  const card = document.getElementById(CARD_ID);
  if (!btn || !card) return;

  let lastTop = null;
  let lastLeft = null;
  let dockDirty = false; // a scroll, resize or host resize: re-check the dock too

  // One button rect read per frame. The dock check (host + row rects) runs
  // only after an event that can change it, never on the idle frames.
  const frame = () => {
    cardFollowRaf = null;
    if (!isActive(composeEl) || !isCardOpen()) return;
    if (dockDirty) {
      dockDirty = false;
      refreshButtonPlacement(state);
      if (!isCardOpen()) return;
    }
    const rect = btn.getBoundingClientRect();
    if (rect.top !== lastTop || rect.left !== lastLeft) {
      lastTop = rect.top;
      lastLeft = rect.left;
      if (!isAnchorVisible(btn)) {
        hideCoachingCard();
        return;
      }
      positionCoachingCard(composeEl);
    }
    if (isCardOpen()) cardFollowRaf = requestAnimationFrame(frame);
  };
  cardFollowRaf = requestAnimationFrame(frame);

  const markDirty = () => {
    dockDirty = true;
    lastTop = null; // force a reposition on the next frame
  };
  cardFollowScrollHandler = (event) => {
    // Card-internal scroll should not thrash reposition.
    if (card.contains(event.target)) return;
    markDirty();
  };
  cardFollowResizeHandler = markDirty;

  document.addEventListener('scroll', cardFollowScrollHandler, true);
  window.addEventListener('resize', cardFollowResizeHandler);

  if (typeof ResizeObserver !== 'undefined' && state.host) {
    cardHostResizeObserver = new ResizeObserver(markDirty);
    cardHostResizeObserver.observe(state.host);
  }

  // Observe the compose itself, not the button: the button may sit in a Send
  // row Gmail keeps pinned after the compose has scrolled away.
  cardVisibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!composeEl.isConnected) {
          teardownCompose(state);
          return;
        }
        if (!entry.isIntersecting) {
          hideCoachingCard();
          return;
        }
      }
    },
    { threshold: 0 }
  );
  cardVisibilityObserver.observe(composeEl);
}

// Visible Send-row wrapper for this compose. Fail closed: never document.
// `.aDh` with a non-zero box — do not use [aria-label^=Send]; a 0×0 div.ua
// also matches that. Measured 2026-09-24: the row sits in `.aDj`, which is
// position:absolute inline and position:fixed in a popup (and when Gmail pins
// the inline row on a tall thread).
function findVisibleComposeFooter(composeEl, host) {
  const scopes = [];
  const dialog = composeEl.closest('[role="dialog"]');
  const aoP = composeEl.closest('table.aoP');
  const aoI = composeEl.closest('div.aoI');
  if (dialog) scopes.push(dialog);
  else if (aoP) scopes.push(aoP);
  else if (aoI) scopes.push(aoI);
  if (host && !scopes.includes(host)) scopes.push(host);

  for (const scope of scopes) {
    const nodes = scope.querySelectorAll('.aDh');
    for (const el of nodes) {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) return el;
    }
  }
  return null;
}

function visibleComposeDock(host, footer) {
  const hr = host.getBoundingClientRect();
  const top = Math.max(hr.top, 0);
  const bottom = Math.min(hr.bottom, window.innerHeight);
  const left = Math.max(hr.left, 0);
  const right = Math.min(hr.right, window.innerWidth);
  if (bottom - top < 8 || right - left < 8) return null;

  let dockBottom = bottom;
  // Only inset for a host that extends below the fold (tall expanded quote).
  // Collapsed compose: host bottom is on screen, keep bottom:8px of the host.
  if (footer && hr.bottom > window.innerHeight) {
    const fr = footer.getBoundingClientRect();
    if (fr.width > 0 && fr.top < dockBottom && fr.bottom > top) {
      dockBottom = Math.min(dockBottom, fr.top);
    }
  }
  if (dockBottom - top < 8) return null;
  return { top, bottom: dockBottom, left, right };
}

// ─── Button: one per compose, in Gmail's Send row ────────────────────
// The compose chrome around the editable. Used for visibility and for the
// body-mounted fallback's clamp; nothing is ever mounted in it. Must not be
// (inside) the editable: anything there ends up in the draft (WL-046).
function findHost(composeEl) {
  const candidates = [
    composeEl.closest('[role="dialog"]'),
    composeEl.closest('.aO7'),
    composeEl.closest('.Am')?.parentElement,
    composeEl.parentElement?.parentElement,
    composeEl.parentElement,
  ];
  return candidates.find((el) => el && !composeEl.contains(el)) || null;
}

function buildButton(state) {
  const wrap = document.createElement('span');
  wrap.className = 'wl-btn-wrap';
  wrap.dataset.wlOwner = state.owner;

  const btn = document.createElement('button');
  btn.className = 'wl-btn';
  btn.type = 'button'; // inside Gmail's compose form: never the implicit submit
  btn.innerHTML = WL_BTN_LOGO;
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', CARD_ID);
  // Keep the caret in the draft: the button never takes focus on click, so
  // clicking it is never a compose switch. Keyboard activation still works.
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onButtonClick(state);
  });

  const badge = document.createElement('span');
  badge.className = 'wl-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.hidden = true;

  wrap.append(btn, badge);
  state.wrap = wrap;
  state.btn = btn;
  state.badge = badge;
  state.el._wlBtn = btn;
  applyButtonVisuals(state);
  return wrap;
}

// Mount inside the Send row (`.aDh`): an absolutely positioned child resolves
// against `.aDj`, the row's own positioned wrapper on both surfaces, so it
// rides the row wherever Gmail puts it — pinned or not — with no measuring
// and no inline style on any Gmail node. Body mount is the fallback when no
// row exists; it is today's clamp, kept as is.
function mountButton(state) {
  const el = state.el;
  document
    .querySelectorAll(`.wl-btn-wrap[data-wl-owner="${state.owner}"]`)
    .forEach((n) => n.remove());
  const wrap = buildButton(state);

  const footer = findVisibleComposeFooter(el, state.host);
  if (footer && !footer.closest('[contenteditable="true"]')) {
    state.mount = 'row';
    state.footer = footer;
    wrap.classList.add('wl-btn-wrap--row');
    footer.appendChild(wrap);
    observeFooterSwap(state);
  } else {
    state.mount = 'body';
    state.footer = null;
    wrap.classList.add('wl-btn-wrap--body');
    document.body.appendChild(wrap);
  }
  observeHostResize(state);
  refreshButtonPlacement(state);
  syncBodyFollower();
}

// Gmail swaps the `.aDj` row (pinned ↔ static, full screen). `.aDg` above it is
// stable; one childList observer there rebuilds the button when the row goes.
function observeFooterSwap(state) {
  state.footerObserver?.disconnect();
  state.footerObserver = null;
  const stable = state.footer?.parentElement?.parentElement;
  if (!stable) return;
  state.footerObserver = new MutationObserver(() => ensureButton(state));
  state.footerObserver.observe(stable, { childList: true });
}

function observeHostResize(state) {
  state.hostResize?.disconnect();
  state.hostResize = null;
  if (typeof ResizeObserver === 'undefined' || !state.host) return;
  state.hostResize = new ResizeObserver(() => refreshButtonPlacement(state));
  state.hostResize.observe(state.host);
}

// Hot-path safe: an `isConnected` check only. Re-measuring happens inside
// mountButton when the button really has to be rebuilt.
function ensureButton(state) {
  if (!isAlive(state)) return;
  if (state.wrap?.isConnected) return;
  mountButton(state);
}

// Body-mounted buttons need viewport coordinates; row-mounted ones only need
// the visibility check. Never called per keystroke.
function refreshButtonPlacement(state) {
  if (!state?.wrap || !state.host) return;
  const footer = state.mount === 'row' ? state.footer : findVisibleComposeFooter(state.el, state.host);
  const dock = visibleComposeDock(state.host, footer);
  if (!dock) {
    state.wrap.style.visibility = 'hidden';
    if (isActive(state.el)) hideCoachingCard();
    return;
  }
  state.wrap.style.visibility = '';
  if (state.mount === 'body') {
    // Option B clamp (kept for the fallback): the 44px wrap centres the 32px button.
    const top = dock.bottom - BTN_BOTTOM_PAD_PX - BTN_SIZE_PX - BTN_WRAP_INSET_PX;
    const left = dock.right - BTN_RIGHT_PAD_PX - BTN_SIZE_PX - BTN_WRAP_INSET_PX;
    state.wrap.style.top = `${Math.round(top)}px`;
    state.wrap.style.left = `${Math.round(left)}px`;
  }
}

// One capture-phase scroll + resize follower for every body-mounted button,
// rAF-throttled, installed only while such a button exists (never per compose:
// that was WL-022).
function syncBodyFollower() {
  const needed = [...liveComposes].some((s) => s.mount === 'body');
  if (needed && !bodyFollowHandler) {
    bodyFollowHandler = () => {
      if (bodyFollowRaf !== null) return;
      bodyFollowRaf = requestAnimationFrame(() => {
        bodyFollowRaf = null;
        for (const s of liveComposes) if (s.mount === 'body') refreshButtonPlacement(s);
      });
    };
    document.addEventListener('scroll', bodyFollowHandler, true);
    window.addEventListener('resize', bodyFollowHandler);
  } else if (!needed && bodyFollowHandler) {
    document.removeEventListener('scroll', bodyFollowHandler, true);
    window.removeEventListener('resize', bodyFollowHandler);
    bodyFollowHandler = null;
    if (bodyFollowRaf !== null) {
      cancelAnimationFrame(bodyFollowRaf);
      bodyFollowRaf = null;
    }
  }
}

function onButtonClick(state) {
  const el = state.el;
  if (!isActive(el)) {
    activate(el);
    showCoachingCard(el);
    return;
  }
  if (isCardOpen()) hideCoachingCard();
  else showCoachingCard(el);
}

// ─── Button visuals: status × focus ──────────────────────────────────
// Status (idle, analyzing, ready, attention, error) and focus (filled, quiet)
// are independent axes. The badge is a sibling of the button, so the innerHTML
// writes below can never wipe it.
const BUTTON_LABELS = {
  idle: 'Wavelength',
  analyzing: 'Wavelength, writing a rewrite',
  ready: 'Wavelength, rewrite ready',
  'no-recipient': 'Wavelength, add a recipient',
  'no-profile': "Wavelength, recipient hasn't set up a profile",
  'error-recipients': 'Wavelength, one recipient at a time',
  'error-session': 'Wavelength, sign in again',
  error: 'Wavelength, something went wrong',
};

// The background answers a missing token with "Not authenticated" and an
// expired one with the sign-in sentence below; both mean this tab's token is gone.
const SESSION_ERROR_RE = /not authenticated|session (has )?expired|sign back in|sign in/i;
const SESSION_ERROR_MESSAGE = 'Your session has expired. Please sign in again.';

function isSessionError(message) {
  return SESSION_ERROR_RE.test(message || '');
}

function buttonLabelFor(state) {
  const data = state.card?.data;
  if (state.status === 'attention') return BUTTON_LABELS[data?.status] || BUTTON_LABELS.error;
  if (state.status === 'error') {
    const message = data?.message || '';
    if (/one recipient at a time/i.test(message)) return BUTTON_LABELS['error-recipients'];
    if (isSessionError(message)) return BUTTON_LABELS['error-session'];
    return BUTTON_LABELS.error;
  }
  return BUTTON_LABELS[state.status] || BUTTON_LABELS.idle;
}

function applyButtonVisuals(state) {
  const { btn, badge } = state;
  if (!btn || !badge) return;

  btn.classList.toggle('wl-loading', state.status === 'analyzing');
  btn.classList.toggle('wl-ready', state.status === 'ready');
  btn.classList.toggle('wl-quiet', !isActive(state.el));
  btn.innerHTML =
    state.status === 'analyzing' ? '<span class="wl-btn-spinner"></span>' : WL_BTN_LOGO;

  const label = buttonLabelFor(state);
  btn.setAttribute('aria-label', label);
  btn.setAttribute('data-tip', label);

  const showReady = state.status === 'ready' && !state.appliedEventId;
  const showAttention = state.status === 'attention' || state.status === 'error';
  badge.hidden = !(showReady || showAttention);
  badge.classList.toggle('wl-badge--ready', showReady);
  badge.classList.toggle('wl-badge--attention', showAttention);
  badge.textContent = showReady ? '1' : showAttention ? '!' : '';
}

function setButtonFocused(state, focused) {
  if (!state?.btn) return;
  if (!focused) state.btn.setAttribute('aria-expanded', 'false');
  applyButtonVisuals(state);
}

function statusForCard(cardStatus) {
  if (cardStatus === 'result') return 'ready';
  if (cardStatus === 'analyzing') return 'analyzing';
  if (cardStatus === 'error') return 'error';
  if (cardStatus === 'no-recipient' || cardStatus === 'no-profile') return 'attention';
  return 'idle';
}

// ─── Card content ────────────────────────────────────────────────────
// Every status change for a compose lands here. The snapshot and the badge
// always update; the shared card is painted only when this compose is the
// active one, and it opens only then (a result for another window is a badge).
function updateCard(composeEl, data) {
  const state = getState(composeEl);
  if (!state) return;
  state.card = { status: data.status, data };
  state.status = statusForCard(data.status);
  if (data.status === 'result') state.appliedEventId = null;
  if (data.status !== 'result' && data.status !== 'analyzing') composeEl._wlLastResult = null;
  applyButtonVisuals(state);
  if (!isActive(composeEl)) return;
  paintCard(composeEl, data, { autoOpen: true });
}

function resetCardBody() {
  const card = getCard();
  setCardHeader(card, null);
  card.querySelector('.wl-card-body').innerHTML =
    `<p class="wl-hint">Start typing to get suggestions…</p>`;
}

function paintCardFromState(state) {
  if (!state.card) {
    resetCardBody();
    return;
  }
  paintCard(state.el, state.card.data, { autoOpen: false });
}

function paintCard(composeEl, data, { autoOpen }) {
  const state = getState(composeEl);
  const card = getCard();
  const body = card.querySelector('.wl-card-body');
  if (!state || !body) return;

  switch (data.status) {
    case 'analyzing':
      rememberFooterOpt(composeEl, body);
      // Artifact state 10: keep recipient in the header when already known (e.g. regenerate).
      setCardHeader(card, composeEl._wlLastResult?.recipient_summary || null);
      body.innerHTML = `
        <div class="wl-card-loading">
          <div class="wl-spinner"></div>
          <p>Crafting your rewrite…</p>
        </div>
      `;
      break;

    case 'no-recipient':
      setCardHeader(card, null);
      body.innerHTML = `<p class="wl-hint">Add a recipient to get suggestions.</p>`;
      break;

    case 'no-profile':
      setCardHeader(card, null);
      body.innerHTML = `
        <p class="wl-hint">
          ${escapeHtml(data.emails?.[0] || 'This recipient')} hasn't set up their profile yet.
        </p>
        <a class="wl-invite-btn" href="${APP_URL}/invite" target="_blank" rel="noopener noreferrer">Invite them</a>
      `;
      break;

    case 'error':
      setCardHeader(card, null);
      body.innerHTML = `
        <div class="wl-reason" role="status">
          <span class="wl-reason-ico" aria-hidden="true">▲</span>
          <span>${escapeHtml(data.message || 'Something went wrong')}</span>
        </div>
      `;
      break;

    case 'result':
      setCardHeader(card, data.result?.recipient_summary || null);
      renderResult(body, data.result, data.recipientEmails, composeEl);
      // The Applied pill follows what is in the box, never the undo stack.
      if (state.appliedEventId && state.appliedEventId === data.result?.event_id) {
        markUseThisApplied(body);
      }
      // Auto-show when a result is ready — for the active compose only.
      if (autoOpen) showCoachingCard(composeEl);
      break;
  }
}

// Place the card in viewport coords, anchored to the button. Host-relative CSS
// placement was deleted — under position:fixed on body those rules pin to the
// viewport corner / use viewport percentages (WL-050 verification trap).
// WL-091: the card also stays clear of Gmail's Send row; when neither above nor
// below has room it moves to the left of the button.
function positionCoachingCard(composeEl) {
  if (!isActive(composeEl)) return;
  const state = getState(composeEl);
  const card = document.getElementById(CARD_ID);
  const btn = state?.btn;
  if (!card || !btn || card.style.display === 'none') return;

  if (!isAnchorVisible(btn)) {
    hideCoachingCard();
    return;
  }

  const btnRect = btn.getBoundingClientRect();
  const cardHeight = card.getBoundingClientRect().height || card.offsetHeight;
  const cardWidth = card.getBoundingClientRect().width || CARD_WIDTH_PX;
  if (cardHeight <= 0) return;

  // The button sits in the Send row; keep the whole row clear, not just the button.
  let anchorTop = btnRect.top;
  let anchorBottom = btnRect.bottom;
  const footer = state.footer || findVisibleComposeFooter(composeEl, state.host);
  if (footer) {
    const fr = footer.getBoundingClientRect();
    if (fr.height > 0 && fr.bottom > 0 && fr.top < window.innerHeight) {
      anchorTop = Math.min(anchorTop, fr.top);
      anchorBottom = Math.max(anchorBottom, fr.bottom);
    }
  }

  const minTop = GMAIL_TOP_CHROME_PX + CARD_VIEWPORT_PAD_PX;
  const maxBottom = window.innerHeight - CARD_VIEWPORT_PAD_PX;
  const spaceAbove = anchorTop - minTop - CARD_GAP_PX;
  const spaceBelow = maxBottom - anchorBottom - CARD_GAP_PX;

  let top;
  let left = btnRect.right - cardWidth;
  if (cardHeight <= spaceAbove) {
    top = anchorTop - CARD_GAP_PX - cardHeight;
  } else if (cardHeight <= spaceBelow) {
    top = anchorBottom + CARD_GAP_PX;
  } else {
    // No room either side: to the left of the button, clamped vertically.
    left = btnRect.left - CARD_GAP_PX - cardWidth;
    top = Math.min(btnRect.bottom - cardHeight, maxBottom - cardHeight);
    top = Math.max(minTop, top);
  }

  // Clamped inside the viewport.
  left = Math.max(
    CARD_VIEWPORT_PAD_PX,
    Math.min(left, window.innerWidth - CARD_VIEWPORT_PAD_PX - cardWidth)
  );

  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;
}

// ─── Dismissal: one click and one keydown listener for the one card ──
// A click inside the active compose keeps the card open (WL-008); Send and
// Discard close it at once; a click into another compose is a switch (the
// focusin already did it, and activate decided the card); Gmail's own popovers
// are neutral; anything else closes it. Escape closes it unless something
// closer to the user already consumed the key.
function isSendOrDiscard(el) {
  const control = el.closest('[role="button"]');
  if (!control || !control.closest('.aDh')) return false;
  const label = control.getAttribute('aria-label') || control.getAttribute('data-tooltip') || '';
  return /^(Send|Discard)/.test(label);
}

function onDocumentClick(e) {
  const target = e.target;
  if (!(target instanceof Node) || !target.isConnected) return;
  if (!isCardOpen()) return;
  const el = target instanceof Element ? target : target.parentElement;
  if (!el) return;
  if (el.closest('.wl-card, .wl-btn-wrap')) return;

  const active = getState(activeComposeEl);
  if (active) {
    const surface = composeSurfaceFor(el);
    if (surface && surface === composeSurfaceFor(active.el)) {
      if (isSendOrDiscard(el)) hideCoachingCard();
      return;
    }
    const other = composeForNode(el);
    if (other && other !== active.el && getState(other)) {
      activate(other);
      return;
    }
    if (el.closest('[role="menu"], [role="listbox"]')) return;
    if (el.closest('[role="dialog"]') && !other) return; // a Gmail popover, not a compose
  }
  hideCoachingCard();
}

function onDocumentKeydown(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !isCardOpen()) return;
  hideCoachingCard();
}

function renderResult(container, result, recipientEmails, composeEl) {
  let html = '';
  composeEl._wlLastResult = result;

  // Subject row is inserted by syncSubjectRow when the field is visibly present.

  // Suggested rewrite — render with paragraph formatting
  if (result.suggested_rewrite) {
    const formattedRewrite = escapeHtml(result.suggested_rewrite)
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>');

    // Artifact order: rewrite → actions → footer checkbox → tip (tip appended below).
    html += `
      <div class="wl-rewrite-section">
        <div class="wl-rewrite-text"><p>${formattedRewrite}</p></div>
        <div class="wl-actions">
          <button type="button" class="wl-btn-use" data-action="use" aria-label="Use this rewrite">Use this</button>
          <button type="button" class="wl-btn-icon" data-action="regen" aria-label="Regenerate" data-tip="Regenerate">
            ${WL_ICON_REGEN}
          </button>
        </div>
        <label class="wl-footer-opt">
          <input type="checkbox" data-action="footer-opt"${composeEl._wlWantFooter ? ' checked' : ''}>
          <span>Written with Wavelength</span>
        </label>
      </div>
    `;
  }

  // Coaching tip (compact)
  if (result.suggestions?.length > 0) {
    html += `
      <div class="wl-tip">
        <strong>Tip:</strong> ${escapeHtml(result.suggestions[0].explanation)}
      </div>
    `;
  } else if (result.recipient_summary?.key_tip) {
    html += `
      <div class="wl-tip">
        <strong>Tip:</strong> ${escapeHtml(result.recipient_summary.key_tip)}
      </div>
    `;
  }

  container.innerHTML = html;

  syncSubjectRow(container, result, composeEl);

  // Wire up "Use this" — store handler so wakeUseThisButton can re-bind after undo.
  container._wlOnUse = () =>
    applyRewrite(
      result.suggested_rewrite,
      container,
      composeEl,
      result.event_id,
    );
  const useBtn = container.querySelector('[data-action="use"]');
  if (useBtn) {
    useBtn.addEventListener('click', container._wlOnUse);
  }

  const footerOpt = container.querySelector('[data-action="footer-opt"]');
  if (footerOpt) {
    footerOpt.addEventListener('change', () => {
      onFooterOptChange(container, composeEl, footerOpt.checked === true);
    });
  }

  // Wire up "Regenerate" — does not push; wakes primary on next result.
  // Coaches the source draft behind this card, not the box (WL-004).
  const regenBtn = container.querySelector('[data-action="regen"]');
  if (regenBtn) {
    regenBtn.addEventListener('click', () => {
      analyzeCurrentDraft(composeEl, { regen: true });
    });
  }

  // Undo icon from stack length. Applied pill stays off for a fresh rewrite.
  rehydrateActionRow(container, composeEl);
  syncUseThisEligibility(container, composeEl);
}

// Two pieces of state that look alike and must never be merged:
//   state.lastDraft    — dedupe key. Always the live zone-1 text, on every path.
//   composeEl._wlSource — what the card on screen was coached from ({ draft,
//                         subject }). Apply never touches it; undo restores it.
// After "Use this" the box holds our own rewrite, so any path that reads the
// box to find "what the user wrote" gets the rewrite. Regenerate passes
// `{ regen: true }` and coaches the source instead (WL-004).
async function analyzeCurrentDraft(composeEl, opts = {}) {
  // This run belongs to one compose. After every await, bail if that compose is
  // gone or a newer run has started — otherwise a stale result paints (and
  // Apply writes) the wrong draft.
  const state = getState(composeEl);
  if (!isAlive(state)) return;

  // Zone 1 only — not the signature, quoted thread, or Wavelength footer.
  // See docs/plans/read-path-zone1.md. Must not mirror write-path refusal.
  const live = extractZone1Draft(composeEl);
  // Regenerate coaches the source — unless the box holds an edit nobody has
  // analysed yet (live !== lastDraft). The user typed that, so coach it.
  const source = opts.regen && live === state.lastDraft ? composeEl._wlSource : null;
  const draft = source ? source.draft : live;
  if (!draft || draft.length < 5) return;
  if (!opts.regen && live === state.lastDraft) return;
  const subject = source ? source.subject : extractSubjectFromCompose(composeEl);
  // Read here, before any await, so it describes the same DOM as the draft.
  // Live even on the regen path: the signature belongs to the compose now.
  const hasSignature = resolveZones(composeEl).signatureFollowsZone1;

  const recipientEmails = extractRecipientEmails(composeEl);

  if (recipientEmails.length === 0) {
    updateCard(composeEl, { status: 'no-recipient' });
    return;
  }

  if (recipientEmails.length > 1) {
    updateCard(composeEl, {
      status: 'error',
      message:
        'Wavelength coaches one recipient at a time. Remove one, or open a separate draft.',
    });
    return;
  }

  updateCard(composeEl, { status: 'analyzing' });

  const seq = ++state.runSeq;
  const stale = () => !isAlive(state) || seq !== state.runSeq;

  const recipientIds = await resolveEmails(recipientEmails);
  if (stale()) return;

  if (recipientIds.length === 0) {
    updateCard(composeEl, { status: 'no-profile', emails: recipientEmails });
    return;
  }

  // Stamp only once analysis actually starts. On the live path an early return
  // leaves lastDraft behind the box, so adding a recipient (or fixing a profile)
  // retries without a body edit. On the regen path the key already matches the
  // box, so that retry needs another Regenerate (which the hint cards do not
  // offer) or a body edit. Blanking it here instead would let the next Gmail
  // mutation re-coach the rewrite through a path nobody clicked.
  // The key is the LIVE text even on the source path, for the same reason.
  state.lastDraft = live;
  composeEl._wlSource = Object.freeze({ draft, subject });

  // Live path: blank so the next mutation retries. Source path: keep the key
  // aligned with the box, or that retry would coach the rewrite.
  const keyAfterError = source ? live : '';

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ANALYZE',
      body: {
        message_draft: draft,
        recipient_ids: recipientIds,
        platform: 'gmail',
        context_type: 'email',
        subject: subject || undefined,
        has_signature: hasSignature,
      },
    });

    if (stale()) return;

    if (result.error) {
      state.lastDraft = keyAfterError;
      reportAnalysisError(composeEl, result.error);
    } else {
      state.lastEventId = result.event_id || null;
      updateCard(composeEl, { status: 'result', result, recipientEmails });
    }
  } catch (err) {
    if (stale()) return;
    state.lastDraft = keyAfterError;
    reportAnalysisError(composeEl, err.message);
  }
}

// A session error means the token this tab believed in is gone (sign-out in
// the popup never reaches here, WL-024). Drop the flag so the next focus
// re-asks the background, and show the sign-in sentence, never the raw text.
function reportAnalysisError(composeEl, message) {
  const session = isSessionError(message);
  if (session) hasToken = false;
  updateCard(composeEl, { status: 'error', message: session ? SESSION_ERROR_MESSAGE : message });
}

// ─── Recipient extraction ────────────────────────────────────────────
// Walk up from the compose body until an ancestor contains recipient-row chips.
// Resolve at call time (not attach) so From-alias switches that move the To
// row mid-session are still found. Reject any ancestor that also contains a
// different message-body editable — that means we escaped into another thread.
// Thread message-header chips match RECIPIENT_CHIP_SELECTOR too; only chips
// inside a compose To/Cc/Bcc row count (WL-047 reopen-from-Drafts).
const RECIPIENT_CHIP_SELECTOR =
  '[data-hovercard-id], .afV [email], .aoD.hl [email], span[email]';
const RECIPIENT_ROW_SELECTOR = '.aoD, .afV, [aria-label*="To"], [aria-label*="Recipients"]';

function isComposeMessageEditable(el) {
  if (!(el instanceof Element)) return false;
  if (el.getAttribute('contenteditable') !== 'true') return false;
  const label = el.getAttribute('aria-label');
  if (!label) return false;
  // The same two surfaces discovery registers (COMPOSE_EDITABLE_SELECTOR).
  if (label === 'Message Body') return true;
  return !!el.closest('[role="dialog"]');
}

function isRecipientRowChip(el) {
  return !!(el instanceof Element && el.closest(RECIPIENT_ROW_SELECTOR));
}

function scopeHasRecipientRowChip(scope) {
  return [...scope.querySelectorAll(RECIPIENT_CHIP_SELECTOR)].some(isRecipientRowChip);
}

function findRecipientScope(composeEl) {
  if (!composeEl) return null;

  let node = composeEl.parentElement;
  let depth = 0;
  while (node && node !== document.body && depth < 24) {
    depth += 1;
    // Skip ancestors that only contain thread-header chips (no compose To row).
    if (!scopeHasRecipientRowChip(node)) {
      node = node.parentElement;
      continue;
    }

    const foreignCompose = [...node.querySelectorAll(
      '[contenteditable="true"][aria-label]'
    )].some(
      (ed) => ed !== composeEl && isComposeMessageEditable(ed)
    );
    if (foreignCompose) return null;
    return node;
  }
  return null;
}

function extractRecipientEmails(composeEl) {
  const emails = [];
  const scope = findRecipientScope(composeEl);
  if (!scope) return emails;

  const recipientChips = scope.querySelectorAll(RECIPIENT_CHIP_SELECTOR);

  recipientChips.forEach((el) => {
    if (!isRecipientRowChip(el)) return;
    const email =
      el.getAttribute('data-hovercard-id') ||
      el.getAttribute('email') ||
      el.getAttribute('data-name');
    if (email && email.includes('@')) {
      emails.push(email);
    }
  });

  return [...new Set(emails)];
}

// ─── Email → userId resolution ───────────────────────────────────────
async function resolveEmails(emails) {
  const ids = [];
  for (const email of emails.slice(0, 1)) {
    try {
      const hit = emailCache.get(email);
      if (hit && (hit.id || Date.now() - hit.at < EMAIL_NEGATIVE_TTL_MS)) {
        if (hit.id) ids.push(hit.id);
        continue;
      }
      const result = await chrome.runtime.sendMessage({ type: 'RESOLVE_EMAIL', email });
      if (result?.user_id) {
        emailCache.set(email, { id: result.user_id, at: Date.now() });
        ids.push(result.user_id);
      } else {
        emailCache.set(email, { id: null, at: Date.now() });
      }
    } catch {
      emailCache.set(email, { id: null, at: Date.now() });
    }
  }
  return ids;
}

// ─── "Use this" — replace zone 1 only (closes WL-002) ────────────────
var REFUSAL_REASON =
  "Gmail isn't marking where your signature starts here, so we can't replace just your message.";

function formatRewriteHtml(rewriteText) {
  const lines = rewriteText.split('\n');
  return lines
    .map((line) => {
      if (!line.trim()) return '<div><br></div>';
      let formatted = escapeHtml(line)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.+?)\*/g, '<i>$1</i>');
      return `<div>${formatted}</div>`;
    })
    .join('');
}

function syncUseThisEligibility(container, composeEl) {
  const useBtn = container?.querySelector('[data-action="use"]');
  if (!useBtn) return;

  const editable = getComposeEditable(composeEl);
  const zones = editable ? resolveZones(editable) : null;
  const refuse = !editable || shouldRefuseUseRewrite(zones, editable);
  const alreadyRefused = useBtn.disabled && useBtn.classList.contains('wl-btn-refused');
  const alreadyAllowed = !useBtn.disabled && !useBtn.classList.contains('wl-btn-refused');
  if (refuse ? alreadyRefused : alreadyAllowed) return;

  if (refuse) {
    useBtn.disabled = true;
    useBtn.setAttribute('aria-disabled', 'true');
    useBtn.classList.add('wl-btn-refused');
    useBtn.setAttribute('data-tip', REFUSAL_REASON);
    useBtn.setAttribute('title', REFUSAL_REASON);
    useBtn.setAttribute('aria-label', REFUSAL_REASON);
    showReasonPanel(container, REFUSAL_REASON, 'wl-refuse-reason');
  } else {
    useBtn.disabled = false;
    useBtn.removeAttribute('aria-disabled');
    useBtn.classList.remove('wl-btn-refused');
    useBtn.removeAttribute('data-tip');
    useBtn.removeAttribute('title');
    useBtn.setAttribute('aria-label', 'Use this rewrite');
    container.querySelector('.wl-refuse-reason')?.remove();
  }

  if (isActive(composeEl)) positionCoachingCard(composeEl);
}

function showRewriteRefusal(container, composeEl) {
  const useBtn = container.querySelector('[data-action="use"]');
  if (useBtn) {
    useBtn.disabled = true;
    useBtn.setAttribute('aria-disabled', 'true');
    useBtn.setAttribute('aria-label', REFUSAL_REASON);
    useBtn.classList.add('wl-btn-refused');
  }

  showReasonPanel(container, REFUSAL_REASON, 'wl-refuse-reason');

  // Condition 2: do not wipe the Undo icon when the stack is non-empty.
  if (composeEl) {
    rehydrateActionRow(container, composeEl);
    positionCoachingCard(composeEl);
  }
}

function rememberFooterOpt(composeEl, container) {
  const box = container?.querySelector('[data-action="footer-opt"]');
  if (!composeEl || !box) return;
  composeEl._wlWantFooter = box.checked === true;
}

function onFooterOptChange(container, composeEl, checked) {
  if (composeEl) composeEl._wlWantFooter = !!checked;

  // Pre-apply: checkbox state is read by applyRewrite. Nothing to write yet.
  if (!container?.querySelector('.wl-done')) return;

  const editable = getComposeEditable(composeEl);
  if (!editable) return;

  const state = getState(composeEl);
  setApplying(state);
  clearTimeout(state?.debounceTimer);
  try {
    if (checked) {
      insertZone4Footer(editable, buildWavelengthFooter());
    } else {
      stripWavelengthFooters(editable);
    }
    editable.dispatchEvent(new Event('input', { bubbles: true }));
    if (state) state.lastDraft = extractZone1Draft(editable);

    const stack = composeEl._wlUndoStack;
    if (stack && stack.length > 0) {
      stack[stack.length - 1].hadFooter = !!checked;
    }
  } finally {
    releaseApplying(state);
  }
}

function applyRewrite(rewriteText, container, composeEl, eventId) {
  if (!composeEl || !rewriteText) return;

  const includeFooter =
    container.querySelector('[data-action="footer-opt"]')?.checked === true;
  if (composeEl) composeEl._wlWantFooter = includeFooter;

  const state = getState(composeEl);

  // Record suggestion acceptance and re-score in the backend
  const acceptEventId = eventId || state?.lastEventId;
  if (acceptEventId) {
    chrome.runtime.sendMessage({
      type: 'ACCEPT_SUGGESTION',
      eventId: acceptEventId,
      rewrittenText: rewriteText,
    }).catch(() => {}); // fire-and-forget
  }

  const editable = getComposeEditable(composeEl);
  if (!editable) return;

  // Guard: prevent our own DOM changes from triggering detach/re-analysis.
  // Must clear on every path, including refusal.
  setApplying(state);
  clearTimeout(state?.debounceTimer);
  clearUndoRefusal(container);

  try {
    // Resolve at apply-click — never cache (alias switch / quote expand / async signature).
    const zones = resolveZones(editable);

    if (shouldRefuseUseRewrite(zones, editable)) {
      showRewriteRefusal(container, composeEl);
      return;
    }

    // Snapshot BEFORE the write (same tick).
    const subjectBefore = getSubjectValue(composeEl);
    const snapshot = {
      zone1Html: serializeZone1Html(editable),
      subject: subjectBefore,
      lastDraft: state?.lastDraft ?? '',
      source: composeEl._wlSource, // frozen; safe to share by reference
      hadFooter: includeFooter,
      wroteBody: true,
      subjectChanged: false,
      heldAtApply: gmailIsHoldingTrimmedContent(editable),
    };

    const rewriteHtml = formatRewriteHtml(rewriteText);
    const footerHtml = includeFooter ? buildWavelengthFooter() : '';
    const wrote = replaceZone1Content(editable, zones, rewriteHtml, footerHtml);
    if (!wrote.ok) {
      showRewriteRefusal(container, composeEl);
      return;
    }

    editable.dispatchEvent(new Event('input', { bubbles: true }));
    // Same string the analyse path stores — zone-1 plain text from the DOM.
    if (state) state.lastDraft = extractZone1Draft(editable);

    updateSubjectIfNeeded(rewriteText, composeEl);
    snapshot.subjectChanged = subjectBefore !== getSubjectValue(composeEl);
    pushUndoSnapshot(composeEl, snapshot);
    if (state) {
      state.appliedEventId = acceptEventId || null;
      applyButtonVisuals(state);
    }

    markUseThisApplied(container);
    rehydrateActionRow(container, composeEl);
    if (activeComposeEl) positionCoachingCard(activeComposeEl);
  } finally {
    releaseApplying(state);
  }
}

// ─── Wavelength footer ───────────────────────────────────────────────
function buildWavelengthFooter() {
  const divider = '<div><br></div>';
  const footerStyle = 'color:#64748b;font-size:13px;font-family:sans-serif;';
  const line1 = `<div style="${footerStyle}">✦ Written with <a href="https://mywavelength.ai" style="color:#94a3b8;" target="_blank">Wavelength</a></div>`;
  return divider + line1;
}

// ─── Backup auth relay (postMessage from web app → background) ───────
if (IN_EXTENSION) window.addEventListener('message', (event) => {
  if (event.origin !== APP_URL) return;
  if (event.source !== window) return;
  if (event.data?.type === 'WAVELENGTH_AUTH' && typeof event.data.token === 'string') {
    chrome.runtime
      .sendMessage({
        type: 'SET_TOKEN',
        token: event.data.token,
        refresh_token: event.data.refresh_token,
        expires_at: event.data.expires_at,
      })
      .then(() => checkAuth())
      .then(reconcileActive)
      .catch(() => {});
  }
});

// ─── Subject line handling ────────────────────────────────────────────
function updateSubjectIfNeeded(rewriteText, composeEl) {
  const subjectInput = findSubjectInput(composeEl);
  if (!subjectInput) return;

  // Check if the current subject is generic/empty
  const currentSubject = subjectInput.value.trim();
  if (currentSubject && !currentSubject.startsWith('Re:') && !currentSubject.startsWith('Fwd:')) {
    // User already has a custom subject, don't overwrite
    return;
  }

  // Extract a subject suggestion from the rewrite text (first line or first sentence)
  const firstLine = rewriteText.split('\n')[0]?.trim() || '';
  if (firstLine.length > 10 && firstLine.length < 80 && !currentSubject) {
    // Only suggest if subject is empty — use first line as subject
    subjectInput.value = firstLine;
    subjectInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function extractSubjectFromCompose(composeEl) {
  return getSubjectValue(composeEl).trim();
}

// ─── Utilities ───────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── CommonJS export (tests only) ────────────────────────────────────
// Mirrors the pattern in zones.js. Chrome ignores this: a content script has
// no `module`, so the guard is false and nothing here runs in the browser.
//
// This exists so the Jest suite can assert what gmail.js actually does instead
// of hand-copying its logic into the test file. card-dismiss.spec.js documents
// why that mattered: a reimplementation "will not fail if gmail.js changes or
// regresses", and three footer defects shipped past the suite for exactly that
// reason. Export what a test needs to drive real behaviour, nothing more.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderResult,
    rememberFooterOpt,
    buildWavelengthFooter,
    escapeHtml,
    registerCompose,
    activate,
    teardownCompose,
    installDiscovery,
    checkAuth,
    getComposeSnapshot,
  };
}
