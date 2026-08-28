/**
 * @file filter.js
 *
 * Account filter and whitelist evaluation engine.
 * Pure ES module: no DOM access, no external network dependencies.
 *
 * Evaluates discovered account records against user-configured criteria:
 *   - Whitelist protection (handles explicitly excluded from unfollowing)
 *   - Reciprocity filtering (non-followers vs mutuals vs all)
 *   - Verification status protection
 *   - Bio keyword protection
 *   - Default avatar detection
 * @param {string} raw - Raw handle or key (e.g. '@user', 'User', or a full URL string)
 * @returns {string} Normalized handle (e.g. '@user')
 */
export function normalizeHandleKey(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (s.startsWith('@')) s = s.slice(1);
  s = s.split(/[?#/]/, 1)[0].trim().toLowerCase();
  return s ? '@' + s : '';
}

/**
 * Creates a normalized Whitelist set from an iterable of handle strings.
 *
 * @param {Iterable<string>} [initialHandles=[]]
 * @returns {{
 *   has: (handle: string) => boolean,
 *   add: (handle: string) => boolean,
 *   remove: (handle: string) => boolean,
 *   clear: () => void,
 *   size: () => number,
 *   toArray: () => string[],
 * }}
 */
export function createWhitelist(initialHandles = []) {
  const set = new Set();

  if (initialHandles && typeof initialHandles[Symbol.iterator] === 'function') {
    for (const h of initialHandles) {
      const key = normalizeHandleKey(h);
      if (key) set.add(key);
    }
  }

  return {
    has(handle) {
      const key = normalizeHandleKey(handle);
      return key ? set.has(key) : false;
    },
    add(handle) {
      const key = normalizeHandleKey(handle);
      if (!key || set.has(key)) return false;
      set.add(key);
      return true;
    },
    remove(handle) {
      const key = normalizeHandleKey(handle);
      if (!key) return false;
      return set.delete(key);
    },
    clear() {
      set.clear();
    },
    size() {
      return set.size;
    },
    toArray() {
      return Array.from(set).sort();
    },
  };
}

/**
 * Default filter configuration.
 */
export const DEFAULT_FILTER_CONFIG = Object.freeze({
  filterMode: 'all', // 'all' | 'non_followers' | 'mutuals_only'
  protectMutuals: false,
  protectVerified: false,
  bioKeywordsExclude: [], // array of lowercase keywords to protect
  skipDefaultAvatars: false,
});

/**
 * Evaluates an account identity against a filter configuration and whitelist.
 *
 * @param {object} account - Account identity object
 * @param {string} account.key - '@handle'
 * @param {string} account.handle - 'handle'
 * @param {string} [account.displayName] - Human name
 * @param {boolean} [account.followsYou=false] - True if account follows the user back
 * @param {boolean} [account.isVerified=false] - True if account has verified badge
 * @param {string} [account.bio=''] - Bio description text
 * @param {boolean} [account.hasDefaultAvatar=false] - True if default egg avatar
 * @param {object} [config={}] - Filter configuration options
 * @param {object} [whitelist=null] - Whitelist instance or set
 * @returns {{ shouldUnfollow: boolean, action: 'unfollow' | 'skip', reason?: string }}
 */
export function evaluateAccount(account, config = {}, whitelist = null) {
  if (!account || !account.key) {
    return { shouldUnfollow: false, action: 'skip', reason: 'invalid_account' };
  }

  const opts = { ...DEFAULT_FILTER_CONFIG, ...config };
  const key = normalizeHandleKey(account.key || account.handle);

  // 1. Whitelist check (highest precedence)
  if (whitelist) {
    const isWhitelisted = typeof whitelist.has === 'function'
      ? whitelist.has(key)
      : (whitelist instanceof Set ? whitelist.has(key) : false);

    if (isWhitelisted) {
      return { shouldUnfollow: false, action: 'skip', reason: 'whitelisted' };
    }
  }

  // 2. Protect mutuals override
  if (opts.protectMutuals && account.followsYou === true) {
    return { shouldUnfollow: false, action: 'skip', reason: 'mutual_protected' };
  }

  // 3. Protect verified accounts
  if (opts.protectVerified && account.isVerified === true) {
    return { shouldUnfollow: false, action: 'skip', reason: 'verified_protected' };
  }

  // 4. Bio keyword protection
  if (Array.isArray(opts.bioKeywordsExclude) && opts.bioKeywordsExclude.length > 0 && account.bio) {
    const bioLower = account.bio.toLowerCase();
    for (const kw of opts.bioKeywordsExclude) {
      const trimmed = (typeof kw === 'string' ? kw.trim().toLowerCase() : '');
      if (trimmed && bioLower.includes(trimmed)) {
        return { shouldUnfollow: false, action: 'skip', reason: 'keyword_protected' };
      }
    }
  }

  // 5. Default avatar skip
  if (opts.skipDefaultAvatars && account.hasDefaultAvatar === true) {
    return { shouldUnfollow: false, action: 'skip', reason: 'default_avatar_skipped' };
  }

  // 6. Filter Mode evaluation
  if (opts.filterMode === 'non_followers') {
    // Only unfollow accounts that DO NOT follow you back
    if (account.followsYou === true) {
      return { shouldUnfollow: false, action: 'skip', reason: 'follows_you' };
    }
  } else if (opts.filterMode === 'mutuals_only') {
    // Only unfollow accounts that DO follow you back
    if (account.followsYou !== true) {
      return { shouldUnfollow: false, action: 'skip', reason: 'not_following_back' };
    }
  }

  // Eligible for unfollow
  return { shouldUnfollow: true, action: 'unfollow' };
}

/**
 * Parses handle lists from raw text or CSV/JSON strings.
 *
 * @param {string} text - Raw CSV, JSON, or newline-delimited handle list
 * @returns {string[]} Array of normalized '@handle' strings
 */
export function parseHandleList(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const trimmed = text.trim();

  // Try JSON array first
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const out = [];
        for (const item of parsed) {
          const str = typeof item === 'string' ? item : (item && (item.handle || item.key || item.username));
          if (str) {
            const key = normalizeHandleKey(String(str));
            if (key) out.push(key);
          }
        }
        return Array.from(new Set(out)).sort();
      }
    } catch (_) {
      // Fall through to text delimiter parsing
    }
  }

  // Split on commas, semicolons, whitespace, or newlines
  const tokens = trimmed.split(/[\r\n,;\s]+/);
  const out = [];
  for (const token of tokens) {
    const key = normalizeHandleKey(token);
    if (key) out.push(key);
  }
  return Array.from(new Set(out)).sort();
}

/**
 * Serializes a list of handles to CSV or JSON format.
 *
 * @param {string[]} handles
 * @param {'json' | 'csv'} [format='csv']
 * @returns {string}
 */
export function exportHandleList(handles, format = 'csv') {
  const normalized = Array.isArray(handles)
    ? handles.map(normalizeHandleKey).filter(Boolean)
    : [];

  if (format === 'json') {
    return JSON.stringify(normalized, null, 2);
  }

  // CSV format with header
  return 'handle\n' + normalized.join('\n');
}

export default {
  normalizeHandleKey,
  createWhitelist,
  DEFAULT_FILTER_CONFIG,
  evaluateAccount,
  parseHandleList,
  exportHandleList,
};
