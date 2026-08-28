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

    counterEl = host.ownerDocument.createElement('div');
    counterEl.className = 'counter';
    counterEl.textContent = '0';

    sublineEl = host.ownerDocument.createElement('div');
    sublineEl.className = 'subline';
    sublineEl.textContent = 'unfollowed';

    logEl = host.ownerDocument.createElement('div');
    logEl.className = 'log';

    root.appendChild(headerEl);
    root.appendChild(counterEl);
    root.appendChild(sublineEl);
    root.appendChild(logEl);

    host.appendChild(root);
  }

  function render(state) {
    ensureDom();
    if (!state || typeof state !== 'object') return;

    const sessionState = String(state.state || 'IDLE').toUpperCase();
    if (stateEl) stateEl.textContent = sessionState;
    if (stateEl) stateEl.setAttribute('data-state', sessionState.toLowerCase());

    const unfollowed = Number(state.unfollowedCount || 0);
    if (counterEl) counterEl.textContent = String(unfollowed);

    const parts = [];
    if (state.detectedCount != null) parts.push('detected ' + state.detectedCount);
    if (state.skippedCount != null) parts.push('skipped ' + state.skippedCount);
    if (state.failedCount != null) parts.push('failed ' + state.failedCount);
    if (state.mode) parts.push('mode ' + state.mode);
    if (state.speed) parts.push('speed ' + state.speed);
    if (sublineEl) sublineEl.textContent = parts.join(' • ') || 'unfollowed';

    if (logEl && Array.isArray(state.recent)) {
      logEl.replaceChildren();
      for (const entry of state.recent.slice(0, 8)) {
        const line = host.ownerDocument.createElement('div');
        line.className = 'log-row log-' + String(entry.type || 'info').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const handle = entry.account && entry.account.handle ? '@' + entry.account.handle : '';
        line.textContent = (entry.type || '') + ' ' + handle;
        logEl.appendChild(line);
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
      min-width: 220px;
      max-width: 320px;
      padding: 10px 12px;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      background: rgba(15, 18, 22, 0.92);
      color: #e6e9ec;
      border: 1px solid rgba(255,255,255,0.08);
      backdrop-filter: blur(8px);
      transition: transform 0.15s ease;
    }
    [data-untwitt-hud][data-theme="light"] {
      background: rgba(255, 255, 255, 0.96);
      color: #14181f;
      border-color: rgba(0,0,0,0.08);
    }
    [data-untwitt-hud][data-position="bottom-right"] { right: 16px; bottom: 16px; }
    [data-untwitt-hud][data-position="bottom-left"]  { left: 16px;  bottom: 16px; }
    [data-untwitt-hud][data-position="top-right"]    { right: 16px; top: 16px; }
    [data-untwitt-hud][data-position="top-left"]     { left: 16px;  top: 16px; }
    [data-untwitt-hud] .hdr { display: flex; align-items: center; gap: 8px; }
    [data-untwitt-hud] .title { font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
    [data-untwitt-hud] .state {
      margin-left: auto;
      font-size: 10px;
      letter-spacing: 0.08em;
      padding: 2px 6px;
      border-radius: 6px;
      background: rgba(255,255,255,0.08);
    }
    [data-untwitt-hud][data-theme="light"] .state { background: rgba(0,0,0,0.06); }
    [data-untwitt-hud] .state[data-state="running"] { color: #79c0ff; }
    [data-untwitt-hud] .state[data-state="paused"]  { color: #f0a64f; }
    [data-untwitt-hud] .state[data-state="done"]    { color: #4fcf8a; }
    [data-untwitt-hud] .state[data-state="error"]   { color: #ef4f4f; }
    [data-untwitt-hud] .toggle {
      background: transparent; color: inherit; border: 0; cursor: pointer;
      font: inherit; padding: 0 4px; line-height: 1;
    }
    [data-untwitt-hud] .counter {
      margin-top: 6px;
      font-size: 32px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    [data-untwitt-hud] .subline {
      font-size: 11px;
      opacity: 0.78;
      letter-spacing: 0.02em;
    }
    [data-untwitt-hud] .log {
      margin-top: 8px;
      max-height: 140px;
      overflow-y: auto;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      opacity: 0.92;
    }
    [data-untwitt-hud] .log-row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    [data-untwitt-hud] .log-row.log-account_unfollowed { color: #4fcf8a; }
    [data-untwitt-hud] .log-row.log-account_failed     { color: #ef4f4f; }
    [data-untwitt-hud] .log-row.log-account_skipped    { color: #f0a64f; }
    [data-untwitt-hud] .log-row.log-completed          { color: #79c0ff; }
    [data-untwitt-hud][data-collapsed="true"] .counter,
    [data-untwitt-hud][data-collapsed="true"] .subline,
    [data-untwitt-hud][data-collapsed="true"] .log { display: none; }
  `;
}

export default {
  DEFAULT_HUD_CONFIG,
  createHud,
};
