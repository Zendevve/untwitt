/**
 * @file x-adapter.js
 *
 * THE SINGLE SOURCE OF TRUTH for X (Twitter) DOM selectors in the untwitt
 * extension. The PRD mandate is that every X-specific CSS selector, every
 * X-specific text match, and every X-specific DOM assumption lives in this
 * file. No other content-script file may reach into the X DOM with a raw
 * selector. When X changes its markup, this is the ONLY file that should
 * need editing.
 *
 * Adapter contract (consumed by every later content-script slice):
 *
 *   XAdapter.findAccountCells()                       -> HTMLElement[]
 *   XAdapter.getAccountIdentity(cell)                -> { key, handle, displayName } | null
 *   XAdapter.findUnfollowButton(cell)                 -> HTMLButtonElement | null
 *   XAdapter.clickUnfollow(button)                    -> void
 *   XAdapter.confirmUnfollow(timeoutMs?)              -> Promise<boolean>
 *   XAdapter.scrollFollowingList()                    -> void
 *   XAdapter.isFollowingPage()                       -> boolean
 *   XAdapter.waitForDomMutation(timeoutMs?)           -> Promise<void>
 *   XAdapter.SELECTORS                               -> { accountCell, unfollowButton,
 *                                                          confirmDialogButton,
 *                                                          followingListContainer,
 *                                                          userCellLink }
 *
 * Safety: every method MUST guard against being called when not on a
 * Following page, when the document is not ready, or when the relevant
 * element is absent. The adapter must never throw for the caller; it must
 * degrade to [] / null / false / a rejected promise on absence.
 *
 * Selectors (X.com DOM circa 2024-2025):
 *   accountCell:
 *     '[data-testid="UserCell"]' -- wraps one account row in the Following
 *     list. This is X's stable testid for the per-account cell container.
 *
 *   unfollowButton:
 *     Primary: '[data-testid="UserCell"] [data-testid$="-unfollow"]'
 *     X appends a verb testid to the per-row follow/unfollow button. The
 *     `-unfollow` suffix is the "you are currently following this account"
 *     state. It MUST NOT match a `data-testid$="-follow"` button (a
 *     "Follow back" or "Follow" affordance).
 *     Fallback: any button inside the cell whose aria-label starts with
 *     "Following @".
 *
 *   confirmDialogButton:
 *     Primary: '[data-testid="confirmationSheetDialog"] [data-testid="confirmationSheetConfirm"]'
 *     X's unfollow confirmation sheet uses the confirmationSheet testid pair.
 *     Fallback: any button with text "Unfollow" inside [role="alertdialog"].
 *
 *   followingListContainer:
 *     'section[role="region"] [data-testid="primaryColumn"] section'
 *     Best-effort; the inner section inside the primary column inside the
 *     region. scrollFollowingList() falls back to window.scrollBy(0, 600)
 *     when this selector yields no scrollable element.
 *
 *   userCellLink:
 *     '[data-testid="UserCell"] a[href^="/"]'
 *     The first absolute-path anchor inside the cell; the URL segment after
 *     the leading "/" is the @handle. Restricted to href^="/" to skip
 *     external links (e.g. t.co redirects) and the in-page hashtag links.
 *
 * Pure ES module. No imports. No external state.
 *
 * Two import forms are supported so downstream slices can pick whichever
 * fits their style:
 *   import XAdapter from './x-adapter.js';          // default form
 *   import { XAdapter } from './x-adapter.js';      // named form
 *   import { SELECTORS } from './x-adapter.js';     // selectors only
 * SELECTORS is also re-exported as a named export so the test harness can
 * assert the isolation contract without going through the methods object.
 */

// ---------- Selector constants (the ONLY place these strings live) ----------

const SELECTORS = Object.freeze({
  accountCell: '[data-testid="UserCell"]',
  unfollowButton: '[data-testid="UserCell"] [data-testid$="-unfollow"]',
  confirmDialogButton:
    '[data-testid="confirmationSheetDialog"] [data-testid="confirmationSheetConfirm"]',
  followingListContainer:
    'section[role="region"] [data-testid="primaryColumn"] section',
  userCellLink: '[data-testid="UserCell"] a[href^="/"]',
  followsYouBadge: '[data-testid="userFollowIndicator"]',
  verifiedBadge: '[data-testid="icon-verified"], [aria-label="Verified account"]',
  bioBlock: '[data-testid="UserDescription"]',
  avatarImage: '[data-testid="UserCell"] img[src]',
});

// ---------- Internal helpers (not exported) ----------

function safeDocument() {
  return typeof document !== 'undefined' ? document : null;
}

function safeWindow() {
  if (typeof window !== 'undefined') return window;
  if (typeof globalThis !== 'undefined' && globalThis.window) return globalThis.window;
  return null;
}

function htmlButtonCtor() {
  if (typeof HTMLButtonElement !== 'undefined') return HTMLButtonElement;
  const w = safeWindow();
  return w && w.HTMLButtonElement ? w.HTMLButtonElement : null;
}

function normalizeHandle(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (s.startsWith('@')) s = s.slice(1);
  // Handles are ASCII letters, digits, and underscores per X.
  s = s.split(/[?#/]/, 1)[0];
  return s.toLowerCase();
}

function readHandleFromHref(href) {
  if (typeof href !== 'string') return '';
  // The href begins with "/" (guaranteed by the userCellLink selector), so
  // the handle is the first non-empty path segment.
  const parts = href.split('/');
  if (parts.length < 2) return '';
  const first = parts[1] || '';
  return normalizeHandle(first);
}

function readDisplayNameFromCell(cell) {
  // X renders the display name as a dir="auto" span near the top of the
  // cell. The selector is intentionally narrow (only inside the cell) and
  // does not rely on a testid, because X varies this between list and grid
  // views. dir="auto" is the strongest stable marker; dir="ltr" appears on
  // the @handle and the bio, so we exclude it.
  const dirNodes = cell.querySelectorAll('[dir="auto"]');
  for (const node of dirNodes) {
    const text = (node.textContent || '').trim();
    if (!text) continue;
    if (text.length > 50) continue; // display names are short; bios are long
    if (text.startsWith('@')) continue; // skip handle nodes
    if (text.startsWith('http')) continue; // skip link previews
    return text;
  }
  return '';
}

function detectFollowsYou(cell) {
  if (!cell) return false;
  const badge = cell.querySelector(SELECTORS.followsYouBadge);
  if (badge) return true;
  const aria = cell.querySelector('[aria-label*="ollows you" i]');
  if (aria) return true;
  const spans = cell.querySelectorAll('span');
  for (const s of spans) {
    const t = (s.textContent || '').trim().toLowerCase();
    if (t === 'follows you' || t === 'follows you ') return true;
  }
  return false;
}

function detectVerified(cell) {
  if (!cell) return false;
  const badge = cell.querySelector(SELECTORS.verifiedBadge);
  if (badge) return true;
  return false;
}

function detectBio(cell) {
  if (!cell) return '';
  const bio = cell.querySelector(SELECTORS.bioBlock);
  if (bio) {
    const text = (bio.textContent || '').trim();
    if (text) return text;
  }
  return '';
}

function detectHasDefaultAvatar(cell) {
  if (!cell) return false;
  const img = cell.querySelector(SELECTORS.avatarImage);
  if (!img) return false;
  const src = (img.getAttribute('src') || '').toLowerCase();
  if (!src) return false;
  if (src.includes('default_profile') || src.includes('egg') || src.includes('absolutely') || src.includes('unknown')) {
    return true;
  }
  return false;
}

function isFollowingButtonInCell(cell, button) {
  if (!cell || !button) return false;
  if (!cell.contains(button)) return false;
  const testid = (button.getAttribute('data-testid') || '').toLowerCase();
  // Must end in "-unfollow" (the "you are following" state) and NOT
  // "-follow" (the "you are not following" state, e.g. "Follow back").
  if (testid.endsWith('-unfollow')) return true;
  const aria = (button.getAttribute('aria-label') || '').toLowerCase();
  if (aria.startsWith('following @') || aria === 'following' || aria.includes('following @') || aria.includes('following')) return true;
  const text = (button.textContent || '').trim().toLowerCase();
  if (text === 'following' || text.startsWith('following')) return true;
  return false;
}

function findUnfollowButtonWithFallback(cell) {
  // Primary path: selector-based.
  const direct = cell.querySelector(SELECTORS.unfollowButton);
  if (direct && isFollowingButtonInCell(cell, direct)) return direct;
  // Fallback: check buttons and role="button" elements inside the cell
  const candidates = cell.querySelectorAll('button, [role="button"], [data-testid$="-unfollow"]');
  for (const b of candidates) {
    if (isFollowingButtonInCell(cell, b)) return b;
  }
  return null;
}

function findConfirmButtonInDialog(dialog) {
  if (!dialog) return null;
  const direct = dialog.querySelector('[data-testid="confirmationSheetConfirm"]');
  if (direct && direct instanceof HTMLElement) return direct;
  // Fallback: any button or role="button" with the text/aria/testid "Unfollow" inside dialog
  const candidates = dialog.querySelectorAll('button, [role="button"]');
  for (const b of candidates) {
    const txt = (b.textContent || '').trim().toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
    const testid = (b.getAttribute('data-testid') || '').toLowerCase();
    if (txt === 'unfollow' || aria === 'unfollow' || testid.includes('confirm') || txt.includes('unfollow')) return b;
  }
  return null;
}

function findDialogRoot() {
  const doc = safeDocument();
  if (!doc) return null;
  return doc.querySelector('[data-testid="confirmationSheetDialog"]')
    || doc.querySelector('[role="alertdialog"]');
}

function isVisible(node) {
  if (!node) return false;
  const win = safeWindow();
  if (!win || typeof win.getComputedStyle !== 'function') return true;
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = win.getComputedStyle(node);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  return true;
}

// ---------- The adapter ----------

const XAdapter = {
  SELECTORS,

  /**
   * Returns every currently-rendered account cell in the Following list, or
   * [] when the DOM does not contain any (e.g. wrong page, list still
   * loading, list scrolled past the rendered window).
   */
  findAccountCells() {
    const doc = safeDocument();
    if (!doc) return [];
    const nodes = doc.querySelectorAll(SELECTORS.accountCell);
    const out = [];
    for (const n of nodes) {
      if (n instanceof HTMLElement) out.push(n);
    }
    return out;
  },

  /**
   * Extract the dedupe key, the @handle, the human display name, and
   * additional profile attributes (follows-you, verified, bio, default
   * avatar) from a cell. Returns null if the cell is missing the link
   * that carries the handle -- that cell is unidentifiable and must be
   * skipped. Existing consumers reading the {key, handle, displayName}
   * triplet are unaffected; the new fields are optional additions.
   */
  getAccountIdentity(cell) {
    if (!(cell instanceof HTMLElement)) return null;
    const link = cell.querySelector(SELECTORS.userCellLink);
    if (!link) return null;
    const handle = readHandleFromHref(link.getAttribute('href') || '');
    if (!handle) return null;
    const displayName = readDisplayNameFromCell(cell);
    return {
      key: '@' + handle,
      handle,
      displayName,
      followsYou: detectFollowsYou(cell),
      isVerified: detectVerified(cell),
      bio: detectBio(cell),
      hasDefaultAvatar: detectHasDefaultAvatar(cell),
    };
  },

  /**
   * Locate the "Following" / unfollow button inside a cell. MUST NOT match
   * a "Follow back" or "Follow" button. Returns null when the row is in a
   * non-Following state or the button is not currently rendered.
   */
  findUnfollowButton(cell) {
    if (!(cell instanceof HTMLElement)) return null;
    const b = findUnfollowButtonWithFallback(cell);
    if (!b || !(b instanceof HTMLElement)) return null;
    return isFollowingButtonInCell(cell, b) ? b : null;
  },

  /**
   * Synthesize a real click on the unfollow button. Does not await the
   * confirmation dialog; the caller drives confirmation separately.
   */
  clickUnfollow(button) {
    if (!button || !(button instanceof HTMLElement)) return;
    if (typeof button.click === 'function') {
      button.click();
    } else {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  },
  /**
   * Wait for the confirmation dialog to appear, click its Unfollow button,
   * then wait for the dialog to disappear. Resolves true on a confirmed
   * unfollow, false on timeout. Safe to call when no dialog is open: it
   * simply times out and resolves false.
   */
  confirmUnfollow(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const doc = safeDocument();
      if (!doc) { resolve(false); return; }

      const startedAt = Date.now();
      let dialog = findDialogRoot();
      let observer = null;
      let pollTimer = null;
      let resolved = false;

      const finish = (ok) => {
        if (resolved) return;
        resolved = true;
        if (observer) {
          try { observer.disconnect(); } catch (_) { /* ignore */ }
          observer = null;
        }
        if (pollTimer !== null) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        resolve(ok);
      };

      const tryConfirm = () => {
        if (resolved) return;
        const d = findDialogRoot();
        if (!d) return;
        const btn = findConfirmButtonInDialog(d);
        if (!btn) return;
        if (typeof btn.click === 'function') btn.click();
        // Mark as confirmed; we don't poll for dialog disappearance because
        // X re-uses the same node in some flows and would loop. Returning
        // true here means "the confirm button was clicked".
        finish(true);
      };

      // Observe the document for the dialog appearing.
      observer = new MutationObserver(() => {
        if (resolved) return;
        if (Date.now() - startedAt >= timeoutMs) {
          finish(false);
          return;
        }
        tryConfirm();
      });
      try {
        observer.observe(doc.documentElement || doc, {
          childList: true,
          subtree: true,
        });
      } catch (_) {
        // Document not ready or detached; degrade to polling.
      }

      // If the dialog is already present, attempt immediately.
      if (dialog) tryConfirm();

      // Hard timeout fallback -- the observer does not fire on
      // disconnected documents.
      const tick = () => {
        if (resolved) return;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= timeoutMs) { finish(false); return; }
        tryConfirm();
        if (!resolved) pollTimer = setTimeout(tick, 100);
      };
      pollTimer = setTimeout(tick, 100);
    });
  },

  /**
   * Scroll the Following list container down by ~600px so X renders the
   * next batch of rows. Falls back to window.scrollBy(0, 600) when the
   * container cannot be located. Silently no-ops when there is no
   * document/window.
   */
  scrollFollowingList() {
    const doc = safeDocument();
    const win = safeWindow();
    if (!doc || !win) return;
    try {
      const container = doc.querySelector(SELECTORS.followingListContainer);
      if (container && typeof container.scrollBy === 'function') {
        container.scrollBy(0, 600);
        return;
      }
      if (typeof win.scrollBy === 'function') {
        win.scrollBy(0, 600);
      }
    } catch (_) {
      // JSDOM environment or detached container
    }
  },
  /**
   * True iff the current URL matches an X Following page: /<user>/following
   * with optional query string or trailing slash. Matches both x.com and
   * twitter.com hosts.
   */
  isFollowingPage() {
    const win = safeWindow();
    if (!win || !win.location) return false;
    const host = (win.location.hostname || '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com') return false;
    const path = (win.location.pathname || '').toLowerCase();
    return /\/following(\/|$)/i.test(path);
  },

  /**
   * Wait for the next significant DOM mutation under documentElement.
   * Resolves on the first MutationObserver batch after attaching. Rejects
   * (via resolve -- never throws) on timeout, so callers can `await` it
   * without try/catch.
   */
  waitForDomMutation(timeoutMs = 4000) {
    return new Promise((resolve) => {
      const doc = safeDocument();
      if (!doc) { resolve(); return; }
      const root = doc.documentElement || doc.body || doc;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { observer.disconnect(); } catch (_) { /* ignore */ }
        clearTimeout(timer);
        resolve();
      };
      const observer = new MutationObserver(() => finish());
      try {
        observer.observe(root, { childList: true, subtree: true });
      } catch (_) {
        // Cannot observe; resolve immediately rather than hang.
        finish();
        return;
      }
      const timer = setTimeout(finish, timeoutMs);
    });
  },
};

// Re-export SELECTORS as a named export so test code can assert the
// isolation contract without going through the methods object.
export { SELECTORS, XAdapter };
export default XAdapter;
