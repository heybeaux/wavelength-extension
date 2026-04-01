// Wavelength Gmail Content Script — Grammarly-style floating button + card
// Small circular button in compose window, floating card with suggestions

const DEBOUNCE_MS = 1500;
const APP_URL = 'https://mywavelength.ai';

let activeComposeEl = null;
let activeDialog = null;
let debounceTimer = null;
let lastDraft = '';
let lastRewrite = '';
let emailCache = new Map();
let hasToken = false;

// Track injected buttons per compose element
const injectedComposes = new WeakSet();

// ─── Bootstrap ─────────────────────────────────────────────────────── 
// ─── Auth check ──────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const token = await chrome.runtime.sendMessage({ type: 'GET_TOKEN' });
    hasToken = !!token;
  } catch {
    hasToken = false;
  }
}

// Re-check auth whenever token changes (e.g. after sign-in)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'AUTH_SUCCESS' || message.type === 'SET_TOKEN') {
    hasToken = true;
    // Trigger observer re-scan in case compose is already open
    if (activeComposeEl === null) {
      const editors = document.querySelectorAll(
        '[role="dialog"] [contenteditable="true"][aria-label], [contenteditable="true"][aria-label="Message Body"]'
      );
      if (editors.length > 0) attachToCompose(editors[0]);
    }
  }
});

// Also listen for postMessage auth (from the extension auth page)
window.addEventListener('message', (event) => {
  if (event.data?.type === 'WAVELENGTH_AUTH' && event.data?.token) {
    chrome.runtime.sendMessage({ type: 'SET_TOKEN', token: event.data.token });
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

function attachToCompose(composeEl) {
  if (activeComposeEl) detachCompose();

  composeEl.dataset.wavelengthAttached = 'true';
  activeComposeEl = composeEl;
  activeDialog = composeEl.closest('[role="dialog"]') || composeEl.closest('.aO7');

  injectFloatingButton(composeEl);

  // Listen for input with debounce
  composeEl.addEventListener('input', onComposeInput);

  // Watch for compose close
  if (activeDialog?.parentNode) {
    const closeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node === activeDialog || node.contains?.(composeEl)) {
            detachCompose();
            closeObserver.disconnect();
            return;
          }
        }
      }
    });
    closeObserver.observe(activeDialog.parentNode, { childList: true });
  }
}

function detachCompose() {
  if (activeComposeEl) {
    activeComposeEl.removeEventListener('input', onComposeInput);
  }
  activeComposeEl = null;
  activeDialog = null;
  lastDraft = '';
  lastRewrite = '';
  clearTimeout(debounceTimer);
  emailCache.clear();
}

// ─── Floating button injection ───────────────────────────────────────
function injectFloatingButton(composeEl) {
  // Try multiple Gmail compose body selectors
  const composeBody = composeEl.closest('.Am')
    || composeEl.closest('[role="textbox"]')?.parentElement
    || composeEl.parentElement?.parentElement
    || composeEl.parentElement;
  if (!composeBody || injectedComposes.has(composeBody)) return;
  injectedComposes.add(composeBody);

  // Ensure container has relative positioning for absolute button
  const originalPosition = window.getComputedStyle(composeBody).position;
  if (originalPosition === 'static') {
    composeBody.style.position = 'relative';
  }

  // Create the floating button
  const btn = document.createElement('button');
  btn.className = 'wl-btn';
  btn.textContent = 'W';
  btn.title = 'Wavelength — Communication Coach';
  composeBody.appendChild(btn);

  // Create the floating card (hidden by default)
  const card = document.createElement('div');
  card.className = 'wl-card';
  card.style.display = 'none';
  composeBody.appendChild(card);

  // Initial card content
  card.innerHTML = `
    <div class="wl-card-header">
      <span class="wl-card-logo">\u{1F30A}</span>
      <span class="wl-card-title">Wavelength</span>
      <button class="wl-card-close">\u00D7</button>
    </div>
    <div class="wl-card-body">
      <p class="wl-hint">Start typing to get suggestions...</p>
    </div>
  `;

  // Toggle card on button click
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = card.style.display !== 'none';
    card.style.display = isVisible ? 'none' : 'block';
  });

  // Close button inside card
  card.querySelector('.wl-card-close').addEventListener('click', (e) => {
    e.stopPropagation();
    card.style.display = 'none';
  });

  // Dismiss card on outside click
  document.addEventListener('click', (e) => {
    if (!card.contains(e.target) && e.target !== btn) {
      card.style.display = 'none';
    }
  });

  // Dismiss on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      card.style.display = 'none';
    }
  });

  // Store references for updating
  composeEl._wlBtn = btn;
  composeEl._wlCard = card;
}

// ─── Button state helpers ────────────────────────────────────────────
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
  btn.textContent = 'W';
}

function setBtnIdle(composeEl) {
  const btn = composeEl?._wlBtn;
  if (!btn) return;
  btn.classList.remove('wl-loading', 'wl-ready');
  btn.textContent = 'W';
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
      body.innerHTML = `
        <div class="wl-card-loading">
          <div class="wl-spinner"></div>
          <p>Crafting your rewrite...</p>
        </div>
      `;
      break;

    case 'no-recipient':
      setBtnIdle(composeEl);
      body.innerHTML = `<p class="wl-hint">Add a recipient to get suggestions.</p>`;
      break;

    case 'no-profile':
      setBtnIdle(composeEl);
      body.innerHTML = `
        <p class="wl-hint">
          ${escapeHtml(data.emails?.[0] || 'This recipient')} hasn't set up their profile yet.
          <br><br>
          <a href="${APP_URL}/invite" target="_blank">Invite them</a>
        </p>
      `;
      break;

    case 'error':
      setBtnIdle(composeEl);
      body.innerHTML = `<p class="wl-error">${escapeHtml(data.message || 'Something went wrong')}</p>`;
      break;

    case 'result':
      setBtnReady(composeEl);
      renderResult(body, data.result, data.recipientEmails, composeEl);
      // Auto-show card when result is ready
      card.style.display = 'block';
      break;
  }
}

function renderResult(container, result, recipientEmails, composeEl) {
  let html = '';

  // Recipient badge
  if (result.recipient_summary) {
    html += `
      <div class="wl-recipient-badge">
        <strong>${escapeHtml(result.recipient_summary.name)}</strong>
        <span class="wl-tag">${escapeHtml(result.recipient_summary.comm_style)}</span>
      </div>
    `;
  }

  // Suggested subject line
  if (result.suggested_subject) {
    html += `
      <div class="wl-subject-section">
        <div class="wl-subject-label">Subject:</div>
        <div class="wl-subject-row">
          <span class="wl-subject-text">${escapeHtml(result.suggested_subject)}</span>
          <button class="wl-btn-use-subject" data-action="use-subject" title="Apply subject">Use</button>
        </div>
      </div>
    `;
  }

  // Suggested rewrite — render with paragraph formatting
  if (result.suggested_rewrite) {
    const formattedRewrite = escapeHtml(result.suggested_rewrite)
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>');

    html += `
      <div class="wl-rewrite-section">
        <div class="wl-rewrite-text"><p>${formattedRewrite}</p></div>
        <div class="wl-actions">
          <button class="wl-btn-use" data-action="use">Use this \u2713</button>
          <button class="wl-btn-regen" data-action="regen">\u21BB</button>
        </div>
        <div class="wl-applied-container"></div>
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

  // Wire up "Use subject" button
  const useSubjectBtn = container.querySelector('[data-action="use-subject"]');
  if (useSubjectBtn && result.suggested_subject) {
    useSubjectBtn.addEventListener('click', () => {
      const dialog = composeEl.closest('[role="dialog"]') || composeEl.closest('.aO7');
      if (!dialog) return;
      const subjectInput = dialog.querySelector('input[name="subjectbox"], input[aria-label="Subject"]');
      if (subjectInput) {
        subjectInput.value = result.suggested_subject;
        subjectInput.dispatchEvent(new Event('input', { bubbles: true }));
        useSubjectBtn.textContent = '\u2713';
        useSubjectBtn.disabled = true;
      }
    });
  }

  // Wire up "Use this" button
  const useBtn = container.querySelector('[data-action="use"]');
  if (useBtn) {
    useBtn.addEventListener('click', () => applyRewrite(result.suggested_rewrite, container, composeEl));
  }

  // Wire up "Regenerate" button
  const regenBtn = container.querySelector('[data-action="regen"]');
  if (regenBtn) {
    regenBtn.addEventListener('click', () => {
      lastDraft = '';
      analyzeCurrentDraft();
    });
  }
}

// ─── Input handler with debounce ─────────────────────────────────────
function onComposeInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => analyzeCurrentDraft(), DEBOUNCE_MS);
}

async function analyzeCurrentDraft() {
  if (!activeComposeEl) return;

  const draft = activeComposeEl.innerText?.trim();
  if (!draft || draft.length < 5 || draft === lastDraft) return;
  lastDraft = draft;

  const recipientEmails = extractRecipientEmails(activeDialog);

  if (recipientEmails.length === 0) {
    updateCard(activeComposeEl, { status: 'no-recipient' });
    return;
  }

  updateCard(activeComposeEl, { status: 'analyzing' });

  const recipientIds = await resolveEmails(recipientEmails);

  if (recipientIds.length === 0) {
    updateCard(activeComposeEl, { status: 'no-profile', emails: recipientEmails });
    return;
  }

  try {
    const currentSubject = extractSubjectFromCompose(activeDialog);
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

    if (result.error) {
      updateCard(activeComposeEl, { status: 'error', message: result.error });
    } else {
      lastRewrite = result.suggested_rewrite || '';
      updateCard(activeComposeEl, { status: 'result', result, recipientEmails });
    }
  } catch (err) {
    updateCard(activeComposeEl, { status: 'error', message: err.message });
  }
}

// ─── Recipient extraction (scoped to compose dialog) ─────────────────
function extractRecipientEmails(dialog) {
  const emails = [];
  const scope = dialog || document;

  const recipientChips = scope.querySelectorAll(
    '[data-hovercard-id], .afV [email], .aoD.hl [email], span[email]'
  );

  recipientChips.forEach((el) => {
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
  for (const email of emails.slice(0, 5)) {
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

// ─── "Use this" — replace compose content ────────────────────────────
function applyRewrite(rewriteText, container, composeEl) {
  if (!composeEl || !rewriteText) return;

  const editable =
    composeEl.getAttribute('contenteditable') === 'true'
      ? composeEl
      : composeEl.querySelector('[contenteditable="true"]');

  if (!editable) return;

  // Preserve Gmail's rich formatting: convert newlines to proper Gmail divs
  // and maintain paragraph structure
  const lines = rewriteText.split('\n');
  const htmlLines = lines.map((line) => {
    if (!line.trim()) return '<div><br></div>';
    // Preserve basic formatting: **bold** → <b>, *italic* → <i>
    let formatted = escapeHtml(line)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>');
    return `<div>${formatted}</div>`;
  });

  editable.innerHTML = htmlLines.join('');
  editable.dispatchEvent(new Event('input', { bubbles: true }));
  lastDraft = rewriteText;

  // Also update subject line if the rewrite includes a subject suggestion
  updateSubjectIfNeeded(rewriteText, composeEl);

  const appliedContainer = container.querySelector('.wl-applied-container');
  if (appliedContainer) {
    appliedContainer.innerHTML = `<div class="wl-applied">\u2713 Applied</div>`;
    setTimeout(() => { appliedContainer.innerHTML = ''; }, 2500);
  }

  // Hide card after applying
  const card = composeEl._wlCard;
  if (card) {
    setTimeout(() => { card.style.display = 'none'; }, 1200);
  }
}

// ─── Backup auth relay (postMessage from web app → background) ───────
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://mywavelength.ai') return;
  if (event.data?.type === 'WAVELENGTH_AUTH' && event.data.token) {
    chrome.runtime.sendMessage({ type: 'SET_TOKEN', token: event.data.token });
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
  // Find the subject input in the compose dialog
  const dialog = composeEl.closest('[role="dialog"]') || composeEl.closest('.aO7');
  if (!dialog) return;

  const subjectInput = dialog.querySelector('input[name="subjectbox"], input[aria-label="Subject"]');
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

function extractSubjectFromCompose(dialog) {
  if (!dialog) return '';
  const subjectInput = dialog.querySelector('input[name="subjectbox"], input[aria-label="Subject"]');
  return subjectInput?.value?.trim() || '';
}

// ─── Utilities ───────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
