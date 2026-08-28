/**
 * @file hud.js
 *
 * Heads-up display overlay rendered into the X Following page. Pure DOM
 * module: no X selectors, no chrome.* APIs. The host page is
 * manipulated only by injecting a single root container with a
 * `data-untwitt-hud` attribute. The orchestrator pushes a status
 * snapshot; the HUD re-renders.
 */

/**
 * Default HUD configuration.
 *   - position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
 *   - theme: 'dark' | 'light'
 *   - collapsed: initial collapse state
 *   - parent: DOM node to attach to; defaults to document.body
 */
export const DEFAULT_HUD_CONFIG = Object.freeze({
  position: 'bottom-right',
  theme: 'dark',
  collapsed: false,
  parent: null,
});

/**
 * Create a HUD instance. The instance owns its DOM nodes; calling
 * destroy() removes them.
 *
 * @param {object} [config]
 * @returns {{
 *   render: (state: object) => void,
 *   destroy: () => void,
 *   element: () => HTMLElement|null,
 * }}
 */
export function createHud(config = {}) {
  const opts = { ...DEFAULT_HUD_CONFIG, ...config };
  const position = pickPosition(opts.position);
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const collapsed = !!opts.collapsed;
  const host = pickHost(opts.parent);

  let root = null;
  let headerEl = null;
  let stateEl = null;
  let counterEl = null;
  let sublineEl = null;
  let logEl = null;
  let toggleBtn = null;

  function ensureDom() {
    if (root && root.isConnected) return;

    root = host.ownerDocument.createElement('div');
    root.setAttribute('data-untwitt-hud', 'true');
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-position', position);
    if (collapsed) root.setAttribute('data-collapsed', 'true');

    const sheet = host.ownerDocument.createElement('style');
    sheet.textContent = buildStyles();
    root.appendChild(sheet);

    headerEl = host.ownerDocument.createElement('div');
    headerEl.className = 'hdr';

    const title = host.ownerDocument.createElement('span');
    title.className = 'title';
    title.textContent = 'untwitt';

    stateEl = host.ownerDocument.createElement('span');
    stateEl.className = 'state';
    stateEl.textContent = 'IDLE';
    stateEl.setAttribute('data-state', 'idle');

    toggleBtn = host.ownerDocument.createElement('button');
    toggleBtn.className = 'toggle';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-label', 'Toggle HUD');
    toggleBtn.textContent = collapsed ? '+' : '−';
    toggleBtn.addEventListener('click', () => {
      const isCollapsed = root && root.getAttribute('data-collapsed') === 'true';
      if (isCollapsed) {
        root.removeAttribute('data-collapsed');
        toggleBtn.textContent = '−';
      } else {
        root.setAttribute('data-collapsed', 'true');
        toggleBtn.textContent = '+';
      }
    });

    headerEl.appendChild(title);
    headerEl.appendChild(stateEl);
    headerEl.appendChild(toggleBtn);

    const counterWrap = host.ownerDocument.createElement('div');
    counterWrap.className = 'counter-wrap';

    counterEl = host.ownerDocument.createElement('div');
    counterEl.className = 'counter';
    counterEl.textContent = '0';

    const counterLbl = host.ownerDocument.createElement('span');
    counterLbl.className = 'counter-lbl';
    counterLbl.textContent = 'unfollowed';

    counterWrap.appendChild(counterEl);
    counterWrap.appendChild(counterLbl);

    sublineEl = host.ownerDocument.createElement('div');
    sublineEl.className = 'subline';
    sublineEl.textContent = 'Ready to clean';

    logEl = host.ownerDocument.createElement('div');
    logEl.className = 'log';

    root.appendChild(headerEl);
    root.appendChild(counterWrap);
    root.appendChild(sublineEl);
    root.appendChild(logEl);

    host.appendChild(root);
  }

  function render(state) {
    ensureDom();
    if (!state || typeof state !== 'object') return;

    const sessionState = String(state.state || 'IDLE').toUpperCase();
    if (stateEl) {
      stateEl.textContent = sessionState;
      stateEl.setAttribute('data-state', sessionState.toLowerCase());
    }

    const unfollowed = Number(state.unfollowedCount || 0);
    if (counterEl) counterEl.textContent = String(unfollowed);

    const parts = [];
    if (state.detectedCount != null) parts.push('detected ' + state.detectedCount);
    if (state.skippedCount != null) parts.push('skipped ' + state.skippedCount);
    if (state.failedCount != null) parts.push('failed ' + state.failedCount);
    if (state.mode) {
      const modeLabels = {
        non_followers: 'non-followers',
        all: 'all accounts',
        mutuals_only: 'mutuals',
        batch: 'batch',
      };
      parts.push(modeLabels[state.mode] || state.mode);
    }
    if (state.speed) parts.push(state.speed + ' speed');
    if (sublineEl) sublineEl.textContent = parts.join(' · ') || 'Ready to clean';

    if (logEl && Array.isArray(state.recent)) {
      logEl.replaceChildren();
      for (const entry of state.recent.slice(0, 8)) {
        const line = host.ownerDocument.createElement('div');
        const rawType = String(entry.type || 'info').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        line.className = 'log-row log-' + rawType;
        line.textContent = formatLogMessage(entry);
        logEl.appendChild(line);
      }
    }
  }

  function formatLogMessage(entry) {
    if (!entry || typeof entry !== 'object') return typeof entry === 'string' ? entry : '';
    if (typeof entry.message === 'string' && entry.message) return entry.message;
    const type = String(entry.type || '').toUpperCase();
    const handle = entry.account && entry.account.handle
      ? (entry.account.handle.startsWith('@') ? entry.account.handle : '@' + entry.account.handle)
      : (entry.handle ? (entry.handle.startsWith('@') ? entry.handle : '@' + entry.handle) : '');
    const name = entry.account && entry.account.displayName ? entry.account.displayName : (entry.displayName || '');
    const target = handle || name || (entry.target ? entry.target : 'account');

    switch (type) {
      case 'ACCOUNT_UNFOLLOWED':
      case 'UNFOLLOWED':
        return `✓ Unfollowed ${target}`;
      case 'ACCOUNT_SKIPPED':
      case 'SKIPPED': {
        const reasonMap = {
          whitelisted: 'protected',
          is_follower: 'follows you',
          mutual: 'mutual friend',
          verified: 'verified',
          default_avatar: 'default avatar',
        };
        const r = entry.reason ? ` (${reasonMap[entry.reason] || entry.reason})` : '';
        return `↷ Skipped ${target}${r}`;
      }
      case 'ACCOUNT_FAILED':
      case 'FAILED':
        return `✕ Couldn't unfollow ${target}`;
      case 'COMPLETED':
        return '★ Clean-up complete';
      case 'RATE_LIMITED':
      case 'COOLDOWN':
        return '⏳ Pausing briefly to stay safe...';
      default: {
        const friendlyType = type
          ? type.replace(/^ACCOUNT_/, '').toLowerCase().replace(/_/g, ' ')
          : 'processed';
        return friendlyType ? `${friendlyType} ${target}`.trim() : target;
      }
    }
  }

  function destroy() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    headerEl = null;
    stateEl = null;
    counterEl = null;
    sublineEl = null;
    logEl = null;
    toggleBtn = null;
  }

  function element() {
    return root;
  }

  return { render, destroy, element };
}

function pickPosition(value) {
  const allowed = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left']);
  return allowed.has(value) ? value : 'bottom-right';
}

function pickHost(parent) {
  if (parent && typeof parent.appendChild === 'function') return parent;
  if (typeof document !== 'undefined' && document.body) return document.body;
  return null;
}

function buildStyles() {
  return `
    [data-untwitt-hud] {
      position: fixed;
      z-index: 2147483646;
      min-width: 260px;
      max-width: 320px;
      padding: 14px 16px 14px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      color: #e7e9ea;
      background: rgba(0, 0, 0, 0.85);
      background: linear-gradient(145deg, rgba(18, 21, 26, 0.90), rgba(0, 0, 0, 0.85));
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 16px;
      box-shadow:
        0 12px 36px rgba(0, 0, 0, 0.50),
        0 0 0 1px rgba(255, 255, 255, 0.05),
        0 4px 12px rgba(0, 0, 0, 0.30);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      box-sizing: border-box;
      user-select: none;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1),
                  max-width 0.2s cubic-bezier(0.16, 1, 0.3, 1),
                  padding 0.2s cubic-bezier(0.16, 1, 0.3, 1),
                  box-shadow 0.2s ease,
                  transform 0.15s ease;
    }

    [data-untwitt-hud] * {
      box-sizing: border-box;
    }

    [data-untwitt-hud][data-theme="light"] {
      background: rgba(255, 255, 255, 0.88);
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.92), rgba(244, 247, 249, 0.88));
      color: #0f1419;
      border: 1px solid rgba(0, 0, 0, 0.12);
      box-shadow:
        0 12px 36px rgba(0, 0, 0, 0.15),
        0 0 0 1px rgba(0, 0, 0, 0.04),
        0 4px 12px rgba(0, 0, 0, 0.06);
    }

    [data-untwitt-hud][data-position="bottom-right"] { right: 18px; bottom: 18px; }
    [data-untwitt-hud][data-position="bottom-left"]  { left: 18px;  bottom: 18px; }
    [data-untwitt-hud][data-position="top-right"]    { right: 18px; top: 18px; }
    [data-untwitt-hud][data-position="top-left"]     { left: 18px;  top: 18px; }

    [data-untwitt-hud] .hdr {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    [data-untwitt-hud] .title {
      font-size: 13.5px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #f7f9f9;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    [data-untwitt-hud][data-theme="light"] .title {
      color: #0f1419;
    }

    [data-untwitt-hud] .title::before {
      content: "";
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #1d9bf0;
      box-shadow: 0 0 8px rgba(29, 155, 240, 0.6);
      flex-shrink: 0;
    }

    [data-untwitt-hud] .state {
      margin-left: auto;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.10);
      color: #71767b;
      border: 1px solid rgba(255, 255, 255, 0.08);
      line-height: 1.3;
      white-space: nowrap;
      transition: all 0.2s ease;
    }

    [data-untwitt-hud] .state[data-state="idle"] {
      background: rgba(113, 118, 123, 0.15);
      color: #71767b;
      border-color: rgba(113, 118, 123, 0.25);
    }

    [data-untwitt-hud] .state[data-state="running"] {
      background: rgba(0, 186, 124, 0.18);
      color: #00ba7c;
      border-color: rgba(0, 186, 124, 0.35);
      box-shadow: 0 0 10px rgba(0, 186, 124, 0.2);
    }

    [data-untwitt-hud] .state[data-state="paused"] {
      background: rgba(255, 212, 0, 0.18);
      color: #ffd400;
      border-color: rgba(255, 212, 0, 0.35);
    }

    [data-untwitt-hud] .state[data-state="stopped"] {
      background: rgba(113, 118, 123, 0.18);
      color: #e7e9ea;
      border-color: rgba(113, 118, 123, 0.3);
    }

    [data-untwitt-hud] .state[data-state="done"] {
      background: rgba(29, 155, 240, 0.18);
      color: #1d9bf0;
      border-color: rgba(29, 155, 240, 0.35);
    }

    [data-untwitt-hud] .state[data-state="error"] {
      background: rgba(244, 33, 46, 0.18);
      color: #f4212e;
      border-color: rgba(244, 33, 46, 0.35);
    }

    [data-untwitt-hud][data-theme="light"] .state {
      background: rgba(15, 20, 25, 0.06);
      color: #536471;
      border-color: rgba(15, 20, 25, 0.10);
    }

    [data-untwitt-hud][data-theme="light"] .state[data-state="running"] {
      background: rgba(0, 186, 124, 0.14);
      color: #007a52;
      border-color: rgba(0, 186, 124, 0.3);
      box-shadow: none;
    }

    [data-untwitt-hud][data-theme="light"] .state[data-state="paused"] {
      background: rgba(255, 212, 0, 0.20);
      color: #8f6b00;
      border-color: rgba(255, 212, 0, 0.4);
    }

    [data-untwitt-hud][data-theme="light"] .state[data-state="stopped"] {
      background: rgba(15, 20, 25, 0.08);
      color: #0f1419;
      border-color: rgba(15, 20, 25, 0.15);
    }

    [data-untwitt-hud][data-theme="light"] .state[data-state="done"] {
      background: rgba(29, 155, 240, 0.14);
      color: #0c7abf;
      border-color: rgba(29, 155, 240, 0.3);
    }

    [data-untwitt-hud][data-theme="light"] .state[data-state="error"] {
      background: rgba(244, 33, 46, 0.14);
      color: #d01724;
      border-color: rgba(244, 33, 46, 0.3);
    }

    [data-untwitt-hud] .toggle {
      background: transparent;
      color: #71767b;
      border: 1px solid transparent;
      cursor: pointer;
      font: inherit;
      font-size: 15px;
      line-height: 1;
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      padding: 0;
      transition: color 0.15s ease, background 0.15s ease;
      flex-shrink: 0;
    }

    [data-untwitt-hud] .toggle:hover {
      color: #f7f9f9;
      background: rgba(255, 255, 255, 0.10);
    }

    [data-untwitt-hud][data-theme="light"] .toggle {
      color: #536471;
    }

    [data-untwitt-hud][data-theme="light"] .toggle:hover {
      color: #0f1419;
      background: rgba(0, 0, 0, 0.06);
    }

    [data-untwitt-hud] .counter-wrap {
      display: flex;
      align-items: baseline;
      gap: 7px;
      margin-top: 2px;
      margin-bottom: 2px;
    }

    [data-untwitt-hud] .counter {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.02em;
      color: #f7f9f9;
      font-variant-numeric: tabular-nums;
      font-feature-settings: "tnum";
    }

    [data-untwitt-hud][data-theme="light"] .counter {
      color: #0f1419;
    }

    [data-untwitt-hud] .counter-lbl {
      font-size: 12px;
      font-weight: 500;
      color: #71767b;
      letter-spacing: 0.01em;
    }

    [data-untwitt-hud][data-theme="light"] .counter-lbl {
      color: #536471;
    }

    [data-untwitt-hud] .subline {
      font-size: 11.5px;
      color: #71767b;
      letter-spacing: 0;
      line-height: 1.45;
      word-break: break-word;
    }

    [data-untwitt-hud][data-theme="light"] .subline {
      color: #536471;
    }

    [data-untwitt-hud] .log {
      margin-top: 10px;
      padding-top: 8px;
      max-height: 140px;
      overflow-y: auto;
      font-size: 11.5px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    [data-untwitt-hud] .log::-webkit-scrollbar {
      width: 4px;
    }

    [data-untwitt-hud] .log::-webkit-scrollbar-track {
      background: transparent;
    }

    [data-untwitt-hud] .log::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 4px;
    }

    [data-untwitt-hud][data-theme="light"] .log {
      border-top-color: rgba(0, 0, 0, 0.08);
    }

    [data-untwitt-hud][data-theme="light"] .log::-webkit-scrollbar-thumb {
      background: rgba(0, 0, 0, 0.15);
    }

    [data-untwitt-hud] .log-row {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 4px 7px;
      border-radius: 6px;
      font-size: 11px;
      line-height: 1.35;
      color: #e7e9ea;
      background: rgba(255, 255, 255, 0.03);
    }

    [data-untwitt-hud] .log-row.log-account_unfollowed,
    [data-untwitt-hud] .log-row.log-unfollowed {
      color: #00ba7c;
      background: rgba(0, 186, 124, 0.10);
    }

    [data-untwitt-hud] .log-row.log-account_failed,
    [data-untwitt-hud] .log-row.log-failed {
      color: #f4212e;
      background: rgba(244, 33, 46, 0.10);
    }

    [data-untwitt-hud] .log-row.log-account_skipped,
    [data-untwitt-hud] .log-row.log-skipped {
      color: #ffd400;
      background: rgba(255, 212, 0, 0.10);
    }

    [data-untwitt-hud] .log-row.log-completed {
      color: #1d9bf0;
      background: rgba(29, 155, 240, 0.10);
    }

    [data-untwitt-hud] .log-row.log-cooldown,
    [data-untwitt-hud] .log-row.log-rate_limited {
      color: #bb86fc;
      background: rgba(187, 134, 252, 0.10);
    }

    [data-untwitt-hud] .log-row.log-info {
      color: #71767b;
      background: rgba(255, 255, 255, 0.03);
    }

    [data-untwitt-hud][data-theme="light"] .log-row {
      color: #0f1419;
      background: rgba(0, 0, 0, 0.03);
    }

    [data-untwitt-hud][data-theme="light"] .log-row.log-account_unfollowed,
    [data-untwitt-hud][data-theme="light"] .log-row.log-unfollowed {
      color: #007a52;
      background: rgba(0, 186, 124, 0.10);
    }

    [data-untwitt-hud][data-theme="light"] .log-row.log-account_failed,
    [data-untwitt-hud][data-theme="light"] .log-row.log-failed {
      color: #d01724;
      background: rgba(244, 33, 46, 0.10);
    }

    [data-untwitt-hud][data-theme="light"] .log-row.log-account_skipped,
    [data-untwitt-hud][data-theme="light"] .log-row.log-skipped {
      color: #8f6b00;
      background: rgba(255, 212, 0, 0.12);
    }

    [data-untwitt-hud][data-theme="light"] .log-row.log-completed {
      color: #0c7abf;
      background: rgba(29, 155, 240, 0.10);
    }

    [data-untwitt-hud][data-theme="light"] .log-row.log-cooldown,
    [data-untwitt-hud][data-theme="light"] .log-row.log-rate_limited {
      color: #6200ea;
      background: rgba(98, 0, 234, 0.08);
    }

    [data-untwitt-hud][data-theme="light"] .log-row.log-info {
      color: #536471;
      background: rgba(0, 0, 0, 0.03);
    }

    [data-untwitt-hud][data-collapsed="true"] {
      min-width: 0;
      max-width: fit-content;
      padding: 8px 12px;
    }

    [data-untwitt-hud][data-collapsed="true"] .hdr {
      margin-bottom: 0;
    }

    [data-untwitt-hud][data-collapsed="true"] .counter-wrap,
    [data-untwitt-hud][data-collapsed="true"] .subline,
    [data-untwitt-hud][data-collapsed="true"] .log {
      display: none !important;
    }
  `;
}

export default {
  DEFAULT_HUD_CONFIG,
  createHud,
};
