/**
 * Gmail compose zone detection (zones-v8).
 *
 * Pure helper: (Element) -> object. No globals, no DOM writes.
 * Resolve at apply-click — never cache the Range, boundary, or booleans.
 *
 * Content-script global when loaded via manifest; CommonJS export for Jest.
 */
(function (root) {
  'use strict';

  var EMPTY = {
    zone1: null,
    boundary: null,
    insertPoint: null,
    corroboratedSignature: false,
    corroboratedQuote: false,
    clearedSignature: false,
    imageOnlySignature: false,
  };

  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  function isText(node) {
    return !!node && node.nodeType === 3;
  }

  function isWlWidget(node) {
    if (!isElement(node)) return false;
    if (node.classList.contains('wl-card') || node.classList.contains('wl-btn')) {
      return true;
    }
    return !!(node.closest && node.closest('.wl-card, .wl-btn'));
  }

  function insideWlWidget(node) {
    if (!node) return false;
    if (isElement(node)) return isWlWidget(node);
    return !!(node.parentElement && node.parentElement.closest('.wl-card, .wl-btn'));
  }

  function insideGmailQuote(node) {
    if (!isElement(node)) node = node && node.parentElement;
    if (!node || !node.closest) return false;
    var quote = node.closest('div.gmail_quote');
    return !!quote && quote !== node;
  }

  function isSignatureMarker(el) {
    if (!isElement(el)) return false;
    if (el.getAttribute('data-smartmail') === 'gmail_signature') return true;
    return el.classList.contains('gmail_signature');
  }

  function isQuoteMarker(el) {
    return isElement(el) && el.tagName === 'DIV' && el.classList.contains('gmail_quote');
  }

  function isNonEmptySignature(el) {
    return isSignatureMarker(el) && (el.textContent || '').trim().length > 0;
  }

  /**
   * Gmail leaves an empty gmail_signature node when the user deletes their
   * signature in-compose. That is a positive signal they cleared it — not the
   * same as a compose that never had a marker (plain-text / unmarked).
   * An image-only signature is not "cleared": there is still something to protect.
   */
  function isClearedSignature(el) {
    if (!isSignatureMarker(el) || insideGmailQuote(el)) return false;
    if ((el.textContent || '').trim().length > 0) return false;
    if (el.querySelector && el.querySelector('img')) return false;
    return true;
  }

  /**
   * Signature-prelude chrome (zones-v8): `--`, <br clear="all">,
   * gmail_signature_prefix, plain <br> connectors, empty wrappers of those.
   * Applied only when the winning marker is a signature — not a quote.
   */
  function isSignatureChrome(node) {
    if (!node) return false;
    if (isText(node)) {
      var t = (node.textContent || '').trim();
      return t === '' || t === '--';
    }
    if (!isElement(node)) return false;
    if (isWlWidget(node)) return false;
    if (isSignatureMarker(node) || isQuoteMarker(node)) return false;
    if (node.classList.contains('gmail_signature_prefix')) return true;
    if (node.tagName === 'BR') return true;
    if (node.tagName !== 'DIV' && node.tagName !== 'SPAN') return false;
    var children = node.childNodes;
    if (children.length === 0) return true;
    for (var i = 0; i < children.length; i++) {
      if (!isSignatureChrome(children[i])) return false;
    }
    return true;
  }

  function expandBoundary(marker, editable) {
    if (isQuoteMarker(marker)) return marker;

    var boundary = marker;
    while (boundary && boundary !== editable) {
      while (boundary.previousSibling && isSignatureChrome(boundary.previousSibling)) {
        boundary = boundary.previousSibling;
      }
      var parent = boundary.parentNode;
      if (!parent || parent === editable) break;
      if (!boundary.previousSibling) {
        boundary = parent;
        continue;
      }
      break;
    }
    while (
      boundary &&
      boundary !== editable &&
      boundary.previousSibling &&
      isSignatureChrome(boundary.previousSibling)
    ) {
      boundary = boundary.previousSibling;
    }
    return boundary === editable ? marker : boundary;
  }

  function nodeBefore(a, b) {
    if (!a || !b || a === b) return false;
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function firstWlWidget(editable) {
    var nodes = editable.querySelectorAll('.wl-card, .wl-btn');
    return nodes.length ? nodes[0] : null;
  }

  /**
   * First zone-1 content node under editable that precedes `endBefore`
   * (exclusive). Skips wl widgets, signature/quote markers, and signature chrome.
   */
  function firstContentBefore(editable, endBefore) {
    var walker = document.createTreeWalker(
      editable,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (node === editable) return NodeFilter.FILTER_SKIP;
          if (endBefore && (node === endBefore || !nodeBefore(node, endBefore))) {
            return NodeFilter.FILTER_REJECT;
          }
          if (insideWlWidget(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    var n = walker.nextNode();
    while (n) {
      if (isSignatureMarker(n) || isQuoteMarker(n)) {
        n = walker.nextNode();
        continue;
      }
      if (endBefore && isElement(n) && n.contains && n.contains(endBefore)) {
        n = walker.nextNode();
        continue;
      }
      if (isSignatureChrome(n)) {
        n = walker.nextNode();
        continue;
      }
      if (isText(n)) {
        if ((n.textContent || '').trim() === '') {
          n = walker.nextNode();
          continue;
        }
        return n;
      }
      if (isElement(n)) {
        if (n.tagName === 'BR') return n;
        // Keep walking into wrappers; return a leaf-ish node when it has text
        // but does not contain the end boundary.
        if ((n.textContent || '').trim().length > 0 || n.querySelector('img')) {
          if (n.children.length === 0) return n;
          // Has element children — continue walk to reach text/br first.
          n = walker.nextNode();
          continue;
        }
      }
      n = walker.nextNode();
    }
    return null;
  }

  function lastContentNode(editable, endBefore) {
    var walker = document.createTreeWalker(
      editable,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (node === editable) return NodeFilter.FILTER_SKIP;
          if (endBefore && (node === endBefore || !nodeBefore(node, endBefore))) {
            return NodeFilter.FILTER_REJECT;
          }
          if (insideWlWidget(node)) return NodeFilter.FILTER_REJECT;
          if (isSignatureMarker(node) || isQuoteMarker(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    var last = null;
    var n = walker.nextNode();
    while (n) {
      last = n;
      n = walker.nextNode();
    }
    return last;
  }

  function buildZone1Range(editable, boundary) {
    var doc = editable.ownerDocument;
    // Range end: corroborated boundary, else first wl widget, else end of editable.
    // If a wl widget sits before the boundary, end there so zone1 never contains it.
    var endBefore = boundary;
    var wl = firstWlWidget(editable);
    if (wl && (!boundary || nodeBefore(wl, boundary))) {
      endBefore = wl;
    }

    var first = firstContentBefore(editable, endBefore);
    if (!first) return null;

    var range = doc.createRange();
    try {
      range.setStartBefore(first);
      if (endBefore) {
        range.setEndBefore(endBefore);
      } else {
        var last = lastContentNode(editable, null);
        if (!last) return null;
        range.setEndAfter(last);
      }
    } catch (e) {
      return null;
    }
    if (range.collapsed) return null;

    var probe = range.cloneContents();
    var tmp = doc.createElement('div');
    tmp.appendChild(probe);
    if ((tmp.textContent || '').trim() === '' && !tmp.querySelector('img')) {
      return null;
    }
    return range;
  }

  function resolveZones(editable) {
    if (!isElement(editable)) return Object.assign({}, EMPTY);

    var corroboratedSignature = false;
    var corroboratedQuote = false;
    var clearedSignature = false;
    var imageOnlySignature = false;
    var marker = null;

    var walker = document.createTreeWalker(editable, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (node) {
        if (insideWlWidget(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    var el = walker.nextNode();
    while (el) {
      if (isQuoteMarker(el)) {
        corroboratedQuote = true;
        if (!marker) marker = el;
      } else if (isSignatureMarker(el) && !insideGmailQuote(el)) {
        if (isNonEmptySignature(el)) {
          corroboratedSignature = true;
          if (!marker) marker = el;
        } else if (isClearedSignature(el)) {
          clearedSignature = true;
        } else {
          // Empty text, but an img (or similar) is still there to protect.
          imageOnlySignature = true;
        }
      }
      el = walker.nextNode();
    }

    if (!marker) {
      return {
        zone1: buildZone1Range(editable, null),
        boundary: null,
        insertPoint: null,
        corroboratedSignature: false,
        corroboratedQuote: false,
        clearedSignature: clearedSignature,
        imageOnlySignature: imageOnlySignature,
      };
    }

    var boundary = expandBoundary(marker, editable);
    if (boundary === editable) boundary = marker;

    return {
      zone1: buildZone1Range(editable, boundary),
      boundary: boundary,
      insertPoint: boundary,
      corroboratedSignature: corroboratedSignature,
      corroboratedQuote: corroboratedQuote,
      clearedSignature: clearedSignature,
      imageOnlySignature: imageOnlySignature,
    };
  }

  function isBoundaryAtIndexZero(editable, boundary) {
    if (!boundary || !editable || !editable.contains(boundary)) return false;
    var range = editable.ownerDocument.createRange();
    try {
      range.selectNodeContents(editable);
      range.setEndBefore(boundary);
    } catch (e) {
      return false;
    }
    if ((range.toString() || '').trim().length > 0) return false;
    var frag = range.cloneContents();
    var tmp = editable.ownerDocument.createElement('div');
    tmp.appendChild(frag);
    return !tmp.querySelector('img');
  }

  /**
   * Nearest compose surface that can own this editable's trimmed-content
   * control. Fail closed: no match → null. Never `.aO7` (too small) and
   * never `document` (a thread's visible `div.ajR.h4` would leak in).
   * Order measured 2026-08-26: dialog, then `table.aoP`, then `div.aoI`,
   * then `div.et` (obfuscated; last resort).
   */
  function composeSurface(editable) {
    if (!isElement(editable) || !editable.closest) return null;
    return (
      editable.closest('[role="dialog"]') ||
      editable.closest('table.aoP') ||
      editable.closest('div.aoI') ||
      editable.closest('div.et') ||
      null
    );
  }

  function isVisibleBox(el) {
    // Production signal: offsetWidth/Height, measured 24×11 when Gmail is
    // holding trimmed content and 0×0 when it is not. jsdom always reports
    // 0 — specs stub these properties. Do not substitute getComputedStyle;
    // display:block + 0×0 would then disagree with Gmail.
    return !!el && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  /**
   * True when Gmail is holding a trimmed quote/signature for this compose,
   * i.e. a whole-box write is recoverable from Gmail's own state (uet).
   *
   * Looks outside the editable (first helper in this module that does).
   * Pure: no writes, no cache, resolved at call time.
   *
   * Both filters are load-bearing:
   *   role="button" — the thread's control is `div.ajR.h4` with role null.
   *   visibility    — a new compose has a `div.ajR[role="button"]` that is
   *                   display:none, 0×0. Existence alone is a false positive.
   * aria-label is English; corroboration only, never required.
   */
  function gmailIsHoldingTrimmedContent(editable) {
    var surface = composeSurface(editable);
    if (!surface || !surface.querySelector) return false;
    var controls = surface.querySelectorAll('div.ajR[role="button"]');
    for (var i = 0; i < controls.length; i++) {
      if (isVisibleBox(controls[i])) return true;
    }
    return false;
  }

  /**
   * Write-policy (zones-v8). Pure decision — does not mutate.
   * Test separately from resolveZones so a wrong refusal cannot hide a wrong range.
   */
  function shouldRefuseUseRewrite(zones, editable) {
    if (!zones) return true;
    if (!zones.zone1 || zones.zone1.collapsed) return true;
    if (isBoundaryAtIndexZero(editable, zones.boundary)) return true;
    if (zones.corroboratedSignature || zones.corroboratedQuote) return false;
    // User deleted their signature in-compose. Gmail left an empty marker.
    // Whole-box write cannot destroy a signature that is already gone.
    if (zones.clearedSignature) return false;
    // Image-only signature: empty text so it does not corroborate, but the
    // img is still Gmail's to keep. A whole-box write would destroy it.
    if (zones.imageOnlySignature) return true;
    // No signature marker, no quote. The box is the message — including a
    // draft reopened after the user deleted their signature (Gmail drops the
    // empty node on save). Unmarked plain-text signatures are the residual
    // risk; Use this is allowed because blocking it is worse for the common case.
    return false;
  }

  function htmlToFragment(doc, html) {
    var tmp = doc.createElement('div');
    tmp.innerHTML = html;
    var frag = doc.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    return frag;
  }

  /**
   * Replace zone 1 only; optionally insert footer HTML before insertPoint.
   * Caller must refuse first via shouldRefuseUseRewrite. Mutates editable.
   * Returns { ok: true } or { ok: false, reason: 'refused'|'no-zone1' }.
   */
  function replaceZone1Content(editable, zones, rewriteHtml, footerHtml) {
    if (shouldRefuseUseRewrite(zones, editable)) {
      return { ok: false, reason: 'refused' };
    }
    if (!zones.zone1) {
      return { ok: false, reason: 'no-zone1' };
    }

    var doc = editable.ownerDocument;
    var insertPoint = zones.insertPoint;
    var range = zones.zone1;

    range.deleteContents();
    if (rewriteHtml) {
      range.insertNode(htmlToFragment(doc, rewriteHtml));
    }

    if (footerHtml) {
      var hasBoundary =
        !!zones.corroboratedSignature || !!zones.corroboratedQuote;
      // No-boundary (whole-box) path: insertPoint is null and append would
      // land at the end of the editable. Where that sits relative to the
      // signature after expand is unmeasured — skip rather than guess.
      if (hasBoundary) {
        var footerFrag = htmlToFragment(doc, footerHtml);
        if (insertPoint && insertPoint.parentNode) {
          insertPoint.parentNode.insertBefore(footerFrag, insertPoint);
        } else {
          editable.appendChild(footerFrag);
        }
      }
    }

    return { ok: true };
  }

  // ─── Read path (WL-002 read half) ───────────────────────────────────

  var BLOCK_TAGS = {
    DIV: 1,
    P: 1,
    LI: 1,
    TR: 1,
    H1: 1,
    H2: 1,
    H3: 1,
    H4: 1,
    H5: 1,
    H6: 1,
    BLOCKQUOTE: 1,
    PRE: 1,
    SECTION: 1,
    ARTICLE: 1,
    HEADER: 1,
    FOOTER: 1,
    TABLE: 1,
  };

  function isBlockElement(el) {
    return isElement(el) && !!BLOCK_TAGS[el.tagName];
  }

  function isFooterDivider(el) {
    if (!isElement(el) || el.tagName !== 'DIV') return false;
    var kids = el.childNodes;
    if (kids.length === 0) return true;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (isText(k) && !(k.textContent || '').trim()) continue;
      if (isElement(k) && k.tagName === 'BR') continue;
      return false;
    }
    return true;
  }

  /**
   * Remove Wavelength zone-4 chrome from a detached tree.
   * Match by href containing mywavelength.ai; skip anything inside a quote
   * (zone 3). Also drop the empty <div><br></div> divider that precedes the
   * footer line when present.
   */
  function stripWavelengthFooters(root) {
    if (!root || !root.querySelectorAll) return;
    var links = root.querySelectorAll('a[href]');
    var toRemove = [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute('href') || '';
      if (href.indexOf('mywavelength.ai') === -1) continue;
      if (insideGmailQuote(a)) continue;
      var container = a.parentElement;
      if (container && container.parentNode) {
        var prev = container.previousSibling;
        while (prev && isText(prev) && !(prev.textContent || '').trim()) {
          prev = prev.previousSibling;
        }
        if (prev && isFooterDivider(prev)) toRemove.push(prev);
        toRemove.push(container);
      } else {
        toRemove.push(a);
      }
    }
    for (var j = 0; j < toRemove.length; j++) {
      if (toRemove[j].parentNode) toRemove[j].parentNode.removeChild(toRemove[j]);
    }
  }

  /**
   * Serialize visible text with Gmail-like line breaks.
   * jsdom has no innerText (undefined); Range.toString()/textContent collapse
   * div-per-line markup. Walk blocks and <br> instead.
   */
  function serializeVisibleText(root) {
    var parts = [];

    function walk(node) {
      if (!node) return;
      if (isText(node)) {
        var t = node.textContent || '';
        // Skip inter-tag indentation whitespace (fixtures / pretty HTML).
        // Real Gmail compose trees rarely carry these as standalone nodes.
        if (!t.trim()) return;
        parts.push(t);
        return;
      }
      if (!isElement(node)) return;
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      if (node.tagName === 'BR') {
        parts.push('\n');
        return;
      }

      var block = isBlockElement(node);
      for (var c = node.firstChild; c; c = c.nextSibling) {
        walk(c);
      }
      if (block) parts.push('\n');
    }

    walk(root);
    return parts.join('');
  }

  function readVisibleText(el) {
    // Never prefer innerText on a detached clone. Chrome collapses block breaks
    // when there is no layout (measured live 2026-08-26: three Gmail <div> lines
    // became one run-on string). jsdom's innerText is undefined. Walk instead.
    return serializeVisibleText(el);
  }

  function normalizeDraftText(s) {
    return (s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function textFromDetachedRoot(root) {
    stripWavelengthFooters(root);
    return normalizeDraftText(readVisibleText(root));
  }

  function textFromRange(range) {
    if (!range) return '';
    var doc =
      (range.startContainer && range.startContainer.ownerDocument) || document;
    var tmp = doc.createElement('div');
    tmp.appendChild(range.cloneContents());
    return textFromDetachedRoot(tmp);
  }

  function textFromElement(el) {
    if (!isElement(el)) return '';
    var clone = el.cloneNode(true);
    return textFromDetachedRoot(clone);
  }

  /**
   * Plain text of zone 1 for analysis / lastDraft.
   *
   * - Corroborated boundary → zone1 Range text (signature/quote excluded).
   * - No boundary → whole editable (read must not mirror write refusal).
   * - Empty zone1 (e.g. signature-only) → '' so the analyze guard skips.
   * - Wavelength footer (zone 4) always stripped via href finder.
   */
  function extractZone1Draft(editable) {
    if (!isElement(editable)) return '';

    var zones = resolveZones(editable);
    var hasBoundary =
      !!zones.corroboratedSignature || !!zones.corroboratedQuote;

    if (!hasBoundary) {
      return textFromElement(editable);
    }

    if (!zones.zone1) return '';
    return textFromRange(zones.zone1);
  }

  /**
   * Serialise current zone-1 HTML (not live nodes). Used for undo snapshots.
   * Empty / missing zone1 → ''.
   */
  function serializeZone1Html(editable) {
    if (!isElement(editable)) return '';
    var zones = resolveZones(editable);
    if (!zones.zone1) return '';
    var tmp = editable.ownerDocument.createElement('div');
    tmp.appendChild(zones.zone1.cloneContents());
    return tmp.innerHTML;
  }

  /**
   * Restore zone 1 from a stored HTML snapshot.
   *
   * opts.heldAtApply: whether Gmail was holding trimmed content when the
   * snapshot was taken. Whole-box restore is only safe into the same state:
   *   held at apply AND still held  → collapsed box unchanged, restore
   *   held at apply AND now not held → user expanded → refuse 'tree-changed'
   *     (plain-text expand paints quote/signature with no markers; restoring
   *     the collapsed-era snapshot would overwrite them)
   *   not held at apply → safety net for a whole-box write on a nothing-held
   *     tree (the write path itself still refuses those)
   *
   * With a corroborated boundary the Range path applies, same as the write.
   * Never falls back to editable.innerHTML. On throw: tree may be partial;
   * caller must treat ok:false as "do not assume success".
   */
  function restoreZone1Html(editable, html, opts) {
    if (!isElement(editable)) {
      return { ok: false, reason: 'no-editable' };
    }
    var zones = resolveZones(editable);
    var hasBoundary =
      !!zones.corroboratedSignature || !!zones.corroboratedQuote;
    var heldAtApply = !!(opts && opts.heldAtApply);
    var heldNow = gmailIsHoldingTrimmedContent(editable);

    if (!hasBoundary && heldAtApply && !heldNow) {
      return { ok: false, reason: 'tree-changed' };
    }
    if (!zones.zone1) {
      return { ok: false, reason: 'no-zone1' };
    }
    try {
      var range = zones.zone1;
      range.deleteContents();
      if (html) {
        range.insertNode(htmlToFragment(editable.ownerDocument, html));
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'throw', error: err };
    }
  }

  root.resolveZones = resolveZones;
  root.shouldRefuseUseRewrite = shouldRefuseUseRewrite;
  root.replaceZone1Content = replaceZone1Content;
  root.extractZone1Draft = extractZone1Draft;
  root.serializeZone1Html = serializeZone1Html;
  root.restoreZone1Html = restoreZone1Html;
  root.stripWavelengthFooters = stripWavelengthFooters;
  root.gmailIsHoldingTrimmedContent = gmailIsHoldingTrimmedContent;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      resolveZones: resolveZones,
      shouldRefuseUseRewrite: shouldRefuseUseRewrite,
      replaceZone1Content: replaceZone1Content,
      extractZone1Draft: extractZone1Draft,
      serializeZone1Html: serializeZone1Html,
      restoreZone1Html: restoreZone1Html,
      stripWavelengthFooters: stripWavelengthFooters,
      gmailIsHoldingTrimmedContent: gmailIsHoldingTrimmedContent,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
