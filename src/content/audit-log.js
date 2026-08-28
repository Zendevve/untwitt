/**
 * @file audit-log.js
 *
 * In-memory audit log for per-account events emitted by the unfollow
 * engine. Bounded ring buffer with optional persistence via a pluggable
 * sink. Pure ES module: no DOM, no chrome.* APIs.
 *
 * The log is intended to be drained and shipped to chrome.storage.local
 * by the content-script orchestrator (or a background sink). It is not a
 * general-purpose event bus; it is specifically for the "what did we do
 * to whom" record.
 */

/**
 * Default log configuration.
 *   - maxEntries: ring-buffer cap (oldest entries drop first)
 *   - now: time source (defaults to Date.now)
 *   - sink: optional { write(entry) } sink for persistence
 */
export const DEFAULT_LOG_CONFIG = Object.freeze({
  maxEntries: 2000,
  now: () => Date.now(),
  sink: null,
});

/**
 * Creates a new audit log.
 *
 * @param {object} [config]
 * @returns {{
 *   record: (type: string, account: object, extra?: object) => object,
 *   all: () => object[],
 *   clear: () => void,
 *   size: () => number,
 *   exportJson: () => string,
 *   exportCsv: () => string,
 *   filter: (predicate: (entry: object) => boolean) => object[],
 *   snapshot: () => object,
 * }}
 */
export function createAuditLog(config = {}) {
  const opts = { ...DEFAULT_LOG_CONFIG, ...config };
  const max = Math.max(1, Math.trunc(Number(opts.maxEntries) || 2000));
  const now = typeof opts.now === 'function' ? opts.now : (() => Date.now());
  const sink = typeof opts.sink === 'function' ? opts.sink : null;

  const buffer = [];

  function record(type, account, extra) {
    const entry = {
      ts: now(),
      type: String(type || 'unknown'),
      account: {
        key: account && account.key,
        handle: account && account.handle,
        displayName: account && account.displayName,
      },
    };
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) entry[k] = extra[k];
    }
    buffer.push(entry);
    if (buffer.length > max) buffer.splice(0, buffer.length - max);
    if (sink) {
      try { sink(entry); } catch (_) { /* sink failures never break the engine */ }
    }
    return entry;
  }

  function all() {
    return buffer.slice();
  }

  function clear() {
    buffer.length = 0;
  }

  function size() {
    return buffer.length;
  }

  function exportJson() {
    return JSON.stringify(buffer.slice(), null, 2);
  }

  function exportCsv() {
    const header = ['ts', 'type', 'reason', 'key', 'handle', 'displayName'];
    const lines = [header.join(',')];
    for (const e of buffer) {
      const row = [
        e.ts,
        csvEscape(e.type),
        csvEscape(e.reason || ''),
        csvEscape(e.account && e.account.key || ''),
        csvEscape(e.account && e.account.handle || ''),
        csvEscape(e.account && e.account.displayName || ''),
      ];
      lines.push(row.join(','));
    }
    return lines.join('\n');
  }

  function filter(predicate) {
    if (typeof predicate !== 'function') return buffer.slice();
    return buffer.filter(predicate);
  }

  function snapshot() {
    return {
      size: buffer.length,
      maxEntries: max,
      oldestTs: buffer.length > 0 ? buffer[0].ts : null,
      newestTs: buffer.length > 0 ? buffer[buffer.length - 1].ts : null,
    };
  }

  return {
    record,
    all,
    clear,
    size,
    exportJson,
    exportCsv,
    filter,
    snapshot,
  };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export default {
  DEFAULT_LOG_CONFIG,
  createAuditLog,
};
