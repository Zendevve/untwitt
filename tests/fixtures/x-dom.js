// JSDOM-backed fixture for the X "Following" page.
//
// The untwitt content scripts are designed to run against a real x.com
// tab. In the test harness we stand up a JSDOM document that contains the
// minimum stable testid surface X exposes (UserCell, the -unfollow button
// inside each cell, and the confirmationSheet dialog pair) so the
// XAdapter module's pure JS API works unchanged.
//
// The XAdapter queries `document` and `window` from `globalThis`. To make
// the adapter usable, withFixture() sets the globalThis.document and
// globalThis.window to the JSDOM values BEFORE calling the user fn, then
// restores the originals on exit.

import { JSDOM } from 'jsdom';

const ALLOWED_KEYS = new Set([
  'window',
  'document',
  'MutationObserver',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'HTMLDivElement',
  'HTMLSpanElement',
  'HTMLSectionElement',
  'HTMLImageElement',
  'HTMLInputElement',
  'HTMLLabelElement',
  'Node',
  'Element',
  'Event',
  'CustomEvent',
  'NodeFilter',
  'getComputedStyle',
]);

function buildFollowingDom({
  accounts = [],
  includeUnfollowButtons = true,
  includeConfirmDialog = true,
  url = 'https://x.com/me/following',
} = {}) {
  // Construct a DOM that satisfies the adapter's selectors:
  //   - <section role="region"><div data-testid="primaryColumn"><section>
  //   - each cell is <div data-testid="UserCell"> ... </div>
  //   - inside the cell: an <a href="/handle"> and a button with
  //     data-testid ending in "-unfollow"
  //   - the cell has a dir="auto" span with the display name
  //   - the confirm dialog lives anywhere on document, with
  //     data-testid="confirmationSheetDialog" and a nested
  //     data-testid="confirmationSheetConfirm" button
  const cellsHtml = accounts.map(({ handle, displayName }) => {
    const safeName = (displayName || handle)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const buttonHtml = includeUnfollowButtons
      ? `<button data-testid="${handle}-unfollow" type="button">Following</button>`
      : '';
    return `
      <div data-testid="UserCell">
        <a href="/${handle}">@${handle}</a>
        <span dir="auto">${safeName}</span>
        ${buttonHtml}
      </div>
    `;
  }).join('\n');

  const dialogHtml = includeConfirmDialog
    ? `<div data-testid="confirmationSheetDialog">
         <button data-testid="confirmationSheetConfirm" type="button">Unfollow</button>
       </div>`
    : '';

  const html = `<!doctype html>
<html>
  <head><title>X / Following</title></head>
  <body>
    <section role="region">
      <div data-testid="primaryColumn">
        <section>
          ${cellsHtml}
        </section>
      </div>
    </section>
    ${dialogHtml}
  </body>
</html>`;

  const jsdom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = jsdom;
  const { document } = window;

  // Each account is keyed by its raw handle; helpers look the cell up by
  // the data-testid="UserCell" container and use the link href to identify
  // it.
  const cellByHandle = new Map();
  for (const { handle } of accounts) {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    for (const cell of cells) {
      const a = cell.querySelector('a[href^="/"]');
      if (a && a.getAttribute('href') === `/${handle}`) {
        cellByHandle.set(handle, cell);
        break;
      }
    }
  }

  function appendAccount(handle, displayName) {
    const safeName = (displayName || handle)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const container = document.querySelector('[data-testid="primaryColumn"] section');
    if (!container) return;
    const wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'UserCell');
    wrap.innerHTML = `
      <a href="/${handle}">@${handle}</a>
      <span dir="auto">${safeName}</span>
      <button data-testid="${handle}-unfollow" type="button">Following</button>
    `;
    container.appendChild(wrap);
    cellByHandle.set(handle, wrap);
  }

  function removeAccount(handle) {
    const cell = cellByHandle.get(handle);
    if (cell && cell.parentNode) cell.parentNode.removeChild(cell);
    cellByHandle.delete(handle);
  }

  // Fire a synthetic mutation so XAdapter.waitForDomMutation can resolve.
  // We append a 0-width text node under the primary column.
  function triggerMutation() {
    const container = document.querySelector('[data-testid="primaryColumn"] section')
      || document.body;
    const t = document.createElement('span');
    t.textContent = '';
    container.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 0);
  }

  function ensureDialog() {
    let d = document.querySelector('[data-testid="confirmationSheetDialog"]');
    if (!d) {
      d = document.createElement('div');
      d.setAttribute('data-testid', 'confirmationSheetDialog');
      const btn = document.createElement('button');
      btn.setAttribute('data-testid', 'confirmationSheetConfirm');
      btn.type = 'button';
      btn.textContent = 'Unfollow';
      d.appendChild(btn);
      document.body.appendChild(d);
    }
    return d;
  }

  function simulateUnfollowSuccess(handle) {
    // For tests that drive the engine with a stubbed clickUnfollow, this is
    // a no-op -- the engine moves on by the confirmUnfollow promise
    // resolving true. We provide a helper that ensures the dialog exists
    // and the confirm button works.
    const d = ensureDialog();
    const btn = d.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (btn && typeof btn.click === 'function') btn.click();
  }

  function simulateUnfollowFailure(handle) {
    // Simulate a selector failure: no dialog is shown, so confirmUnfollow
    // times out. Helper merely guarantees no dialog is present.
    const d = document.querySelector('[data-testid="confirmationSheetDialog"]');
    if (d && d.parentNode) d.parentNode.removeChild(d);
  }

  function simulateUnfollowMissing(handle) {
    // Simulate the row not being in the DOM (already unfollowed earlier).
    removeAccount(handle);
  }

  return {
    window,
    document,
    jsdom,
    appendAccount,
    removeAccount,
    triggerMutation,
    simulateUnfollowSuccess,
    simulateUnfollowFailure,
    simulateUnfollowMissing,
    cellByHandle,
  };
}

async function withFixture(opts, fn) {
  // Build the DOM up front.
  const fixture = buildFollowingDom(opts);

  // Snapshot the relevant globals so we can restore them on exit. The
  // XAdapter only reads document and window from globalThis, but we save
  // anything in ALLOWED_KEYS defensively.
  const saved = {};
  for (const k of ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(globalThis, k)) {
      saved[k] = globalThis[k];
    }
  }

  globalThis.window = fixture.window;
  globalThis.document = fixture.document;
  for (const k of ALLOWED_KEYS) {
    if (k === 'window' || k === 'document') continue;
    const v = fixture.window[k];
    if (v === undefined) continue;
    if (k === 'getComputedStyle') {
      globalThis.getComputedStyle = v.bind(fixture.window);
    } else {
      globalThis[k] = v;
    }
  }

  try {
    return await fn(fixture.window, fixture.document, {
      appendAccount: fixture.appendAccount,
      removeAccount: fixture.removeAccount,
      triggerMutation: fixture.triggerMutation,
      simulateUnfollowSuccess: fixture.simulateUnfollowSuccess,
      simulateUnfollowFailure: fixture.simulateUnfollowFailure,
      simulateUnfollowMissing: fixture.simulateUnfollowMissing,
    });
  } finally {
    // Restore prior globals. Only delete keys we set.
    for (const k of ALLOWED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(saved, k)) {
        globalThis[k] = saved[k];
      } else {
        try { delete globalThis[k]; } catch (_) { globalThis[k] = undefined; }
      }
    }
    // Close the JSDOM window to release listeners.
    try { fixture.window.close(); } catch (_) { /* ignore */ }
  }
}

export { buildFollowingDom, withFixture };
export default { buildFollowingDom, withFixture };
