// Wavelength Gmail Content Script — Grammarly-style floating button + card
// Small circular button in compose window, floating card with suggestions

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

// ─── Font injection (MV3-safe) ──────────────────────────────────────
(function injectFonts() {
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

let activeComposeEl = null;
let activeDialog = null;
let debounceTimer = null;
let recipientPollTimer = null;
let cardFollowRaf = null;
let cardFollowScrollHandler = null;
let cardFollowResizeHandler = null;
let cardHostResizeObserver = null;
let cardVisibilityObserver = null;
let lastDraft = '';
let lastRewrite = '';
let emailCache = new Map();
let hasToken = false;
let cachedUserInfo = null;
let applyingRewrite = false;

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
let lastEventId = null;
let contentObserver = null;
let closeObserver = null;

// Track injected buttons per compose element
const injectedComposes = new WeakSet();

// ─── Bootstrap ───────────────────────────────────────────────────────
// ─── Auth check ──────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const token = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
    hasToken = !!token;
    if (hasToken) fetchUserInfo();
  } catch {
    hasToken = false;
  }
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

// Re-check auth whenever token changes (e.g. after sign-in or expiry)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'AUTH_SUCCESS' || message.type === 'SET_TOKEN') {
    hasToken = true;
    fetchUserInfo();
    // Trigger observer re-scan in case compose is already open
    if (activeComposeEl === null) {
      const editors = document.querySelectorAll(
        '[role="dialog"] [contenteditable="true"][aria-label], [contenteditable="true"][aria-label="Message Body"]'
      );
      if (editors.length > 0) attachToCompose(editors[0]);
    }
  }
  if (message.type === 'AUTH_EXPIRED') {
    hasToken = false;
    if (activeComposeEl) {
      updateCard(activeComposeEl, {
        status: 'error',
        message: 'Your Wavelength session expired. Click the Wavelength icon in your toolbar to sign back in.',
      });
    }
  }
});

checkAuth().then(() => {
  observeComposeWindows();
  // Scan immediately in case compose is already open when extension loads
  const editors = document.querySelectorAll(
    '[role="dialog"] [contenteditable="true"][aria-label], [contenteditable="true"][aria-label="Message Body"]'
  );
  if (editors.length > 0 && hasToken) {
    attachToCompose(editors[0]);
  }
});

// ─── Compose window detection ────────────────────────────────────────
function observeComposeWindows() {
  const observer = new MutationObserver(() => {
    if (!hasToken) return;
    // Skip observer during our own rewrite to prevent self-detach
    if (applyingRewrite) return;

    // Detect dialog-based compose
    const dialogEditors = document.querySelectorAll(
      '[role="dialog"] [contenteditable="true"][aria-label]'
    );
    // Detect inline compose (reply/forward)
    const inlineEditors = document.querySelectorAll(
      '[contenteditable="true"][aria-label="Message Body"]'
    );

    const allEditors = new Set([...dialogEditors, ...inlineEditors]);

    if (allEditors.size === 0) {
      if (activeComposeEl) {
        detachCompose();
      }
      return;
    }

    // Attach to the first unattached compose, or keep current
    for (const el of allEditors) {
      if (el === activeComposeEl) return;
      if (!el.dataset.wavelengthAttached) {
        attachToCompose(el);
        return;
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function clearRecipientPoll() {
  if (recipientPollTimer !== null) {
    clearInterval(recipientPollTimer);
    recipientPollTimer = null;
  }
}

// Wait for extractRecipientEmails to resolve, then analyse once. Replaces the
// bare attach-time call — Gmail often renders the body before the To row.
// Non-empty is safe: extractRecipientEmails only counts chips in a compose
// To/Cc/Bcc row, so thread-header chips cannot satisfy the stop (WL-047).
function pollForRecipientThenAnalyze(composeEl) {
  clearRecipientPoll();
  const startedAt = Date.now();
  let done = false;

  function tick() {
    if (activeComposeEl !== composeEl) {
      clearRecipientPoll();
      return;
    }

    const emails = extractRecipientEmails(composeEl);
    const elapsed = Date.now() - startedAt;

    if (emails.length > 0 || elapsed >= RECIPIENT_POLL_CEILING_MS) {
      done = true;
      clearRecipientPoll();
      if (activeComposeEl !== composeEl) return;
      analyzeCurrentDraft();
    }
  }

  tick();
  if (!done) recipientPollTimer = setInterval(tick, RECIPIENT_POLL_MS);
}

function onComposeSubtreeMutated() {
  if (applyingRewrite) return;
  if (activeComposeEl) {
    const body = activeComposeEl._wlCard?.querySelector('.wl-card-body');
    if (body) syncUseThisEligibility(body, activeComposeEl);
  }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => analyzeCurrentDraft(), DEBOUNCE_MS);
}

function attachToCompose(composeEl) {
  if (activeComposeEl) detachCompose();

  composeEl.dataset.wavelengthAttached = 'true';
  activeComposeEl = composeEl;
  activeDialog = composeEl.closest('[role="dialog"]') || composeEl.closest('.aO7');

  injectFloatingButton(composeEl);

  // Listen for input with debounce
  composeEl.addEventListener('input', onComposeInput);

  // Expand/collapse mutates the editable without firing input (Probe B).
  contentObserver = new MutationObserver(onComposeSubtreeMutated);
  contentObserver.observe(composeEl, { childList: true, subtree: true });

  // Watch for compose close (but not during our own rewrite)
  if (activeDialog?.parentNode) {
    closeObserver = new MutationObserver((mutations) => {
      if (applyingRewrite) return;
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node === activeDialog || node.contains?.(composeEl)) {
            detachCompose();
            return;
          }
        }
      }
    });
    closeObserver.observe(activeDialog.parentNode, { childList: true });
  }

  // Periodically verify our button/card still exist in the DOM; re-inject if Gmail removed them
  const integrityCheck = setInterval(() => {
    if (!activeComposeEl || activeComposeEl !== composeEl) {
      clearInterval(integrityCheck);
      return;
    }
    if (!document.contains(composeEl)) {
      detachCompose();
      return;
    }
    const btn = composeEl._wlBtn;
    if (!btn || !document.contains(btn)) {
      // Button was removed from DOM — re-inject. Body-mounted: must replace,
      // not stack, or each redraw leaves another .wl-btn on document.body.
      injectedComposes.delete(composeEl);
      injectFloatingButton(composeEl);
    }
  }, 1000);

  // Analyse once on attach so drafts (and any pre-filled compose) coach without waiting for input.
  // Empty composes stay silent — analyzeCurrentDraft already guards on length.
  pollForRecipientThenAnalyze(composeEl);
}

function detachCompose() {
  if (contentObserver) {
    contentObserver.disconnect();
    contentObserver = null;
  }
  if (closeObserver) {
    closeObserver.disconnect();
    closeObserver = null;
  }
  stopFollowingCard();
  if (activeComposeEl) {
    activeComposeEl.removeEventListener('input', onComposeInput);
    removePageDismissListeners(activeComposeEl);
    activeComposeEl._wlBtn?.remove();
    activeComposeEl._wlCard?.remove();
    activeComposeEl._wlBtn = null;
    activeComposeEl._wlCard = null;
    activeComposeEl._wlUndoStack = null;
    activeComposeEl._wlHost = null;
  }
  activeComposeEl = null;
  activeDialog = null;
  lastDraft = '';
  lastRewrite = '';
  lastEventId = null;
  clearTimeout(debounceTimer);
  clearRecipientPoll();
  emailCache.clear();
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
        lastDraft,
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
  applyingRewrite = true;
  clearTimeout(debounceTimer);
  clearUndoRefusal(container);

  try {
    const editable = getComposeEditable(composeEl);

    if (entry.wroteBody) {
      if (!editable) {
        stack.length = 0;
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

    lastDraft = entry.lastDraft;
    stack.pop();

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
    setTimeout(() => {
      applyingRewrite = false;
    }, 500);
  }
}

// ─── Floating button injection ───────────────────────────────────────
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

function hideCoachingCard(composeEl) {
  const card = composeEl?._wlCard;
  const btn = composeEl?._wlBtn;
  if (card) card.style.display = 'none';
  if (btn) btn.setAttribute('aria-expanded', 'false');
  // Do not stopFollowingCard — the button is body-mounted and must keep
  // tracking the visible compose after the card closes.
}

function showCoachingCard(composeEl) {
  const card = composeEl?._wlCard;
  const btn = composeEl?._wlBtn;
  if (!card || !btn) return;
  // Button lives inside the clipper — if it is gone, do not float an orphan card.
  if (!isAnchorVisible(btn)) return;

  card.style.display = 'block';
  btn.setAttribute('aria-expanded', 'true');
  // Subject visibility can change while the card was closed (e.g. Edit subject).
  const body = card.querySelector('.wl-card-body');
  if (body && composeEl._wlLastResult) {
    syncSubjectRow(body, composeEl._wlLastResult, composeEl);
  }
  positionCoachingCard(composeEl);
  startFollowingCard(composeEl);
}

function startFollowingCard(composeEl) {
  stopFollowingCard();

  const btn = composeEl?._wlBtn;
  const card = composeEl?._wlCard;
  if (!btn || !card) return;

  const scheduleReposition = () => {
    if (cardFollowRaf !== null) return;
    cardFollowRaf = requestAnimationFrame(() => {
      cardFollowRaf = null;
      if (activeComposeEl !== composeEl) {
        hideCoachingCard(composeEl);
        return;
      }
      positionFloatingButton(composeEl);
      if (!card || card.style.display === 'none') return;
      if (!isAnchorVisible(btn)) {
        hideCoachingCard(composeEl);
        return;
      }
      positionCoachingCard(composeEl);
    });
  };

  cardFollowScrollHandler = (event) => {
    // Card-internal scroll should not thrash reposition.
    if (card.contains(event.target)) return;
    scheduleReposition();
  };
  cardFollowResizeHandler = () => scheduleReposition();

  document.addEventListener('scroll', cardFollowScrollHandler, true);
  window.addEventListener('resize', cardFollowResizeHandler);

  if (typeof ResizeObserver !== 'undefined' && composeEl._wlHost) {
    cardHostResizeObserver = new ResizeObserver(() => scheduleReposition());
    cardHostResizeObserver.observe(composeEl._wlHost);
  }

  cardVisibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          hideCoachingCard(composeEl);
          return;
        }
      }
    },
    { threshold: 0 }
  );
  cardVisibilityObserver.observe(btn);
}

function removePageDismissListeners(composeEl) {
  if (!composeEl) return;
  if (composeEl._wlDocClick) {
    document.removeEventListener('click', composeEl._wlDocClick);
    composeEl._wlDocClick = null;
  }
  if (composeEl._wlDocKeydown) {
    document.removeEventListener('keydown', composeEl._wlDocKeydown);
    composeEl._wlDocKeydown = null;
  }
}

// Visible Send-row wrapper for this compose. Fail closed: never document.
// `.aDh` with a non-zero box — do not use [aria-label^=Send]; a 0×0 div.ua
// also matches that. Measured 2026-08-26: inline overlay is `.aDj.ahe`
// (position:fixed); popup footer is `.aDj.aDn` (position:static).
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

// Option B: body-mount + viewport clamp. Not A — inline Send's `.aDj.ahe` is
// position:fixed and stays on screen after the compose scrolls off the thread
// (check 5). Not C — `.qz.aiL { overflow:auto }` traps sticky. Popup already
// sits on the dialog; this clamp is a no-op while the dialog is on screen.
function positionFloatingButton(composeEl) {
  const btn = composeEl?._wlBtn;
  const host = composeEl?._wlHost;
  if (!btn || !host) return;

  const footer = findVisibleComposeFooter(composeEl, host);
  const dock = visibleComposeDock(host, footer);
  if (!dock) {
    btn.style.top = '-9999px';
    btn.style.left = '0px';
    return;
  }
  const top = dock.bottom - BTN_BOTTOM_PAD_PX - BTN_SIZE_PX;
  const left = dock.right - BTN_RIGHT_PAD_PX - BTN_SIZE_PX;
  btn.style.top = `${Math.round(top)}px`;
  btn.style.left = `${Math.round(left)}px`;
}

function injectFloatingButton(composeEl) {
  const candidates = [
    composeEl.closest('[role="dialog"]'),
    composeEl.closest('.aO7'),
    composeEl.closest('.Am')?.parentElement,
    composeEl.parentElement?.parentElement,
    composeEl.parentElement,
  ];
  const host = candidates.find((el) => el && !composeEl.contains(el));
  if (!host) {
    console.warn('WL: no host outside the compose editable; not injecting');
    return;
  }
  if (injectedComposes.has(composeEl)) return;
  injectedComposes.add(composeEl);

  stopFollowingCard();
  composeEl._wlBtn?.remove();
  composeEl._wlCard?.remove();
  // Body-mounted widgets are not cleaned by Gmail. Sweep strays before recreate.
  document.querySelectorAll('.wl-card, .wl-btn').forEach((el) => el.remove());

  composeEl._wlHost = host;

  // Create the floating button with logo SVG — body-mounted, clamped to the
  // visible compose (see positionFloatingButton).
  const btn = document.createElement('button');
  btn.className = 'wl-btn';
  btn.type = 'button';
  btn.innerHTML = `<svg viewBox="0 0 200 200" width="20" height="20"><defs><linearGradient id="wl-btn-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#FFFDFB"/><stop offset="100%" stop-color="#FFFDFB"/></linearGradient></defs><path d="M 44 54 L 76 146 L 108 85 L 128 128 L 156 92" fill="none" stroke="#FFFDFB" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  btn.title = 'Wavelength — Communication Coach';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', CARD_ID);
  btn.style.top = '-9999px';
  btn.style.left = '0px';
  document.body.appendChild(btn);

  // Card on document.body — escapes .qz.aiL clip. Positioned fixed against the viewport.
  const card = document.createElement('div');
  card.className = 'wl-card';
  card.id = CARD_ID;
  card.style.display = 'none';
  document.body.appendChild(card);

  // Initial card content — uses inline SVG logo mark from design system
  card.innerHTML = `
    <div class="wl-card-header">
      <svg class="wl-card-logo" viewBox="0 0 200 200" width="20" height="20">
        <defs><linearGradient id="wl-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#B8372B"></stop><stop offset="55%" stop-color="#D46A3A"></stop><stop offset="100%" stop-color="#EDA324"></stop></linearGradient></defs><circle cx="100" cy="100" r="96" fill="url(#wl-g)"></circle>
        <path d="M 44 54 L 76 146 L 108 85 L 128 128 L 156 92" fill="none" stroke="#FFFDFB" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
      <span class="wl-card-title">Wavelength</span>
      <button class="wl-card-close" type="button" aria-label="Close">\u00D7</button>
    </div>
    <div class="wl-card-body">
      <p class="wl-hint">Start typing to get suggestions\u2026</p>
    </div>
  `;

  // Toggle card on button click
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = card.style.display !== 'none';
    if (isVisible) {
      hideCoachingCard(composeEl);
    } else {
      showCoachingCard(composeEl);
    }
  });

  // Close button inside card
  card.querySelector('.wl-card-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hideCoachingCard(composeEl);
  });

  // Dismiss card on outside click.
  // Skip detached targets — Apply / Regen / Undo / subject Use re-render the
  // action row and remove the clicked node before this bubbles. contains() on a
  // detached node is false, which would hide the card on its own controls.
  function onDocClick(e) {
    if (!(e.target instanceof Node) || !e.target.isConnected) return;
    if (!card.contains(e.target) && e.target !== btn) {
      hideCoachingCard(composeEl);
    }
  }
  function onDocKeydown(e) {
    if (e.key === 'Escape') {
      hideCoachingCard(composeEl);
    }
  }
  // Integrity re-injects without detachCompose — drop any stored pair first
  // or each redraw stacks a handler that hides the live card.
  removePageDismissListeners(composeEl);
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKeydown);
  composeEl._wlDocClick = onDocClick;
  composeEl._wlDocKeydown = onDocKeydown;

  // Store references for updating
  composeEl._wlBtn = btn;
  composeEl._wlCard = card;
  positionFloatingButton(composeEl);
  startFollowingCard(composeEl);
}

// ─── Button state helpers ────────────────────────────────────────────
const WL_BTN_LOGO = `<svg viewBox="0 0 200 200" width="20" height="20"><path d="M 44 54 L 76 146 L 108 85 L 128 128 L 156 92" fill="none" stroke="#FFFDFB" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function setBtnLoading(composeEl) {
  const btn = composeEl?._wlBtn;
  if (!btn) return;
  btn.classList.remove('wl-ready');
  btn.classList.add('wl-loading');
  btn.innerHTML = '<span class="wl-btn-spinner"></span>';
}

function setBtnReady(composeEl) {
  const btn = composeEl?._wlBtn;
  if (!btn) return;
  btn.classList.remove('wl-loading');
  btn.classList.add('wl-ready');
  btn.innerHTML = WL_BTN_LOGO;
}

function setBtnIdle(composeEl) {
  const btn = composeEl?._wlBtn;
  if (!btn) return;
  btn.classList.remove('wl-loading', 'wl-ready');
  btn.innerHTML = WL_BTN_LOGO;
}

// ─── Card content update ─────────────────────────────────────────────
function updateCard(composeEl, data) {
  const card = composeEl?._wlCard;
  if (!card) return;
  const body = card.querySelector('.wl-card-body');
  if (!body) return;

  switch (data.status) {
    case 'analyzing':
      setBtnLoading(composeEl);
      // Artifact state 10: keep recipient in the header when already known (e.g. regenerate).
      setCardHeader(card, composeEl._wlLastResult?.recipient_summary || null);
      body.innerHTML = `
        <div class="wl-card-loading">
          <div class="wl-spinner"></div>
          <p>Crafting your rewrite\u2026</p>
        </div>
      `;
      break;

    case 'no-recipient':
      setBtnIdle(composeEl);
      setCardHeader(card, null);
      body.innerHTML = `<p class="wl-hint">Add a recipient to get suggestions.</p>`;
      break;

    case 'no-profile':
      setBtnIdle(composeEl);
      setCardHeader(card, null);
      body.innerHTML = `
        <p class="wl-hint">
          ${escapeHtml(data.emails?.[0] || 'This recipient')} hasn't set up their profile yet.
        </p>
        <a class="wl-invite-btn" href="${APP_URL}/invite" target="_blank" rel="noopener noreferrer">Invite them</a>
      `;
      break;

    case 'error':
      setBtnIdle(composeEl);
      setCardHeader(card, null);
      body.innerHTML = `
        <div class="wl-reason" role="status">
          <span class="wl-reason-ico" aria-hidden="true">\u25B2</span>
          <span>${escapeHtml(data.message || 'Something went wrong')}</span>
        </div>
      `;
      break;

    case 'result':
      setBtnReady(composeEl);
      setCardHeader(card, data.result?.recipient_summary || null);
      renderResult(body, data.result, data.recipientEmails, composeEl);
      // Auto-show card when result is ready
      showCoachingCard(composeEl);
      break;
  }
}

// Place the card in viewport coords, anchored to the button. Host-relative CSS
// placement was deleted — under position:fixed on body those rules pin to the
// viewport corner / use viewport percentages (WL-050 verification trap).
function positionCoachingCard(composeEl) {
  const card = composeEl?._wlCard;
  const btn = composeEl?._wlBtn;
  if (!card || !btn || card.style.display === 'none') return;

  if (!isAnchorVisible(btn)) {
    hideCoachingCard(composeEl);
    return;
  }

  const btnRect = btn.getBoundingClientRect();
  const cardHeight = card.getBoundingClientRect().height || card.offsetHeight;
  const cardWidth = card.getBoundingClientRect().width || CARD_WIDTH_PX;
  if (cardHeight <= 0) return;

  const minTop = GMAIL_TOP_CHROME_PX + CARD_VIEWPORT_PAD_PX;
  const maxBottom = window.innerHeight - CARD_VIEWPORT_PAD_PX;
  const spaceAbove = btnRect.top - minTop - CARD_GAP_PX;
  const spaceBelow = maxBottom - btnRect.bottom - CARD_GAP_PX;

  let top;
  if (cardHeight <= spaceAbove) {
    top = btnRect.top - CARD_GAP_PX - cardHeight;
  } else if (cardHeight <= spaceBelow) {
    top = btnRect.bottom + CARD_GAP_PX;
  } else if (spaceBelow >= spaceAbove) {
    top = Math.min(btnRect.bottom + CARD_GAP_PX, maxBottom - cardHeight);
    top = Math.max(minTop, top);
  } else {
    top = Math.max(minTop, btnRect.top - CARD_GAP_PX - cardHeight);
    top = Math.min(top, maxBottom - cardHeight);
    top = Math.max(minTop, top);
  }

  // Align to the button's right edge, clamped inside the viewport.
  let left = btnRect.right - cardWidth;
  left = Math.max(
    CARD_VIEWPORT_PAD_PX,
    Math.min(left, window.innerWidth - CARD_VIEWPORT_PAD_PX - cardWidth)
  );

  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;
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
          <input type="checkbox" data-action="footer-opt">
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

  // Wire up "Regenerate" — does not push; wakes primary on next result.
  const regenBtn = container.querySelector('[data-action="regen"]');
  if (regenBtn) {
    regenBtn.addEventListener('click', () => {
      lastDraft = '';
      analyzeCurrentDraft();
    });
  }

  // Undo icon from stack length. Applied pill stays off for a fresh rewrite.
  rehydrateActionRow(container, composeEl);
  syncUseThisEligibility(container, composeEl);
}

// ─── Input handler with debounce ─────────────────────────────────────
function onComposeInput() {
  if (applyingRewrite) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => analyzeCurrentDraft(), DEBOUNCE_MS);
}

async function analyzeCurrentDraft() {
  if (!activeComposeEl) return;

  // Bind this run to the compose that started it. After every await, bail if the
  // user has switched away — otherwise a stale result paints (and Apply writes) the wrong draft.
  const composeEl = activeComposeEl;

  // Zone 1 only — not the signature, quoted thread, or Wavelength footer.
  // See docs/plans/read-path-zone1.md. Must not mirror write-path refusal.
  const draft = extractZone1Draft(composeEl);
  if (!draft || draft.length < 5 || draft === lastDraft) return;

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

  const recipientIds = await resolveEmails(recipientEmails);
  if (activeComposeEl !== composeEl) return;

  if (recipientIds.length === 0) {
    updateCard(composeEl, { status: 'no-profile', emails: recipientEmails });
    return;
  }

  // Stamp only once analysis actually starts. Earlier returns must leave lastDraft
  // clear so adding a recipient (or fixing profile) can retry without a body edit.
  lastDraft = draft;

  try {
    const currentSubject = extractSubjectFromCompose(composeEl);
    const result = await chrome.runtime.sendMessage({
      type: 'ANALYZE',
      body: {
        message_draft: draft,
        recipient_ids: recipientIds,
        platform: 'gmail',
        context_type: 'email',
        subject: currentSubject || undefined,
      },
    });

    if (activeComposeEl !== composeEl) return;

    if (result.error) {
      lastDraft = '';
      updateCard(composeEl, { status: 'error', message: result.error });
    } else {
      lastRewrite = result.suggested_rewrite || '';
      lastEventId = result.event_id || null;
      updateCard(composeEl, { status: 'result', result, recipientEmails });
    }
  } catch (err) {
    if (activeComposeEl !== composeEl) return;
    lastDraft = '';
    updateCard(composeEl, { status: 'error', message: err.message });
  }
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
  // Same surfaces observeComposeWindows attaches to.
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
      if (emailCache.has(email)) {
        const cachedId = emailCache.get(email);
        if (cachedId) ids.push(cachedId);
        continue;
      }
      const result = await chrome.runtime.sendMessage({ type: 'RESOLVE_EMAIL', email });
      if (result?.user_id) {
        emailCache.set(email, result.user_id);
        ids.push(result.user_id);
      } else {
        emailCache.set(email, null);
      }
    } catch {
      emailCache.set(email, null);
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

  if (activeComposeEl) positionCoachingCard(activeComposeEl);
}

function showRewriteRefusal(container) {
  const useBtn = container.querySelector('[data-action="use"]');
  if (useBtn) {
    useBtn.disabled = true;
    useBtn.setAttribute('aria-disabled', 'true');
    useBtn.setAttribute('aria-label', REFUSAL_REASON);
    useBtn.classList.add('wl-btn-refused');
  }

  showReasonPanel(container, REFUSAL_REASON, 'wl-refuse-reason');

  // Condition 2: do not wipe the Undo icon when the stack is non-empty.
  if (activeComposeEl) {
    rehydrateActionRow(container, activeComposeEl);
    positionCoachingCard(activeComposeEl);
  }
}

function applyRewrite(rewriteText, container, composeEl, eventId) {
  if (!composeEl || !rewriteText) return;

  const includeFooter =
    container.querySelector('[data-action="footer-opt"]')?.checked === true;

  // Record suggestion acceptance and re-score in the backend
  const acceptEventId = eventId || lastEventId;
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
  applyingRewrite = true;
  clearTimeout(debounceTimer);
  clearUndoRefusal(container);

  try {
    // Resolve at apply-click — never cache (alias switch / quote expand / async signature).
    const zones = resolveZones(editable);

    if (shouldRefuseUseRewrite(zones, editable)) {
      showRewriteRefusal(container);
      return;
    }

    // Snapshot BEFORE the write (same tick).
    const subjectBefore = getSubjectValue(composeEl);
    const snapshot = {
      zone1Html: serializeZone1Html(editable),
      subject: subjectBefore,
      lastDraft,
      hadFooter: includeFooter,
      wroteBody: true,
      subjectChanged: false,
      heldAtApply: gmailIsHoldingTrimmedContent(editable),
    };

    const rewriteHtml = formatRewriteHtml(rewriteText);
    const footerHtml = includeFooter ? buildWavelengthFooter() : '';
    const wrote = replaceZone1Content(editable, zones, rewriteHtml, footerHtml);
    if (!wrote.ok) {
      showRewriteRefusal(container);
      return;
    }

    editable.dispatchEvent(new Event('input', { bubbles: true }));
    // Same string the analyse path stores — zone-1 plain text from the DOM.
    lastDraft = extractZone1Draft(editable);

    updateSubjectIfNeeded(rewriteText, composeEl);
    snapshot.subjectChanged = subjectBefore !== getSubjectValue(composeEl);
    pushUndoSnapshot(composeEl, snapshot);

    markUseThisApplied(container);
    rehydrateActionRow(container, composeEl);
    if (activeComposeEl) positionCoachingCard(activeComposeEl);
  } finally {
    // Release the guard after Gmail has settled its DOM updates
    setTimeout(() => {
      applyingRewrite = false;
    }, 500);
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
window.addEventListener('message', (event) => {
  if (event.origin !== APP_URL) return;
  if (event.source !== window) return;
  if (event.data?.type === 'WAVELENGTH_AUTH' && typeof event.data.token === 'string') {
    chrome.runtime.sendMessage({
      type: 'SET_TOKEN',
      token: event.data.token,
      refresh_token: event.data.refresh_token,
      expires_at: event.data.expires_at,
    });
  }
});

// Listen for auth success from background to re-check auth state
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'AUTH_SUCCESS') {
    hasToken = true;
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
