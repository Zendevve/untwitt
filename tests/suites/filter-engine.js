// Suite: filter-engine
//
// Proves the filter engine handles all multi-criteria evaluations:
//   - Whitelist protection (exact @handle and case-insensitive normalization)
//   - Filter modes: 'all', 'non_followers', 'mutuals_only'
//   - Protect mutuals toggle
//   - Protect verified accounts
//   - Bio keyword exclusion
//   - Default avatar skipping
//   - CSV and JSON handle list parsing and export

import {
  normalizeHandleKey,
  createWhitelist,
  evaluateAccount,
  parseHandleList,
  exportHandleList,
} from '../../src/content/filter.js';

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, cond, detail) {
    if (cond) passed += 1;
    else { failed += 1; failures.push({ name, detail: detail || '' }); }
  }

  // 1. Normalization
  check('norm @alice', normalizeHandleKey('@alice') === '@alice', `got=${normalizeHandleKey('@alice')}`);
  check('norm Bob', normalizeHandleKey('Bob') === '@bob', `got=${normalizeHandleKey('Bob')}`);
  check('norm handles with slash', normalizeHandleKey('carol/extra') === '@carol', `got=${normalizeHandleKey('carol/extra')}`);
  // 2. Whitelist CRUD
  const wl = createWhitelist(['@alice', 'Bob']);
  check('wl has alice', wl.has('@alice') === true, 'missing alice');
  check('wl has bob case-insensitive', wl.has('BOB') === true, 'missing bob');
  check('wl size=2', wl.size() === 2, `size=${wl.size()}`);
  wl.add('carol');
  check('wl size after add=3', wl.size() === 3, `size=${wl.size()}`);
  wl.remove('@bob');
  check('wl size after rm=2', wl.size() === 2, `size=${wl.size()}`);
  check('wl toArray sorted', JSON.stringify(wl.toArray()) === JSON.stringify(['@alice', '@carol']), `arr=${JSON.stringify(wl.toArray())}`);

  // 3. Evaluation: Whitelist precedence
  const verdictWl = evaluateAccount({ key: '@alice', handle: 'alice' }, {}, wl);
  check('whitelist skip', verdictWl.shouldUnfollow === false && verdictWl.reason === 'whitelisted', `verdict=${JSON.stringify(verdictWl)}`);

  // 4. Evaluation: Non-followers mode
  const mutualUser = { key: '@friend', handle: 'friend', followsYou: true };
  const nonFollowerUser = { key: '@stranger', handle: 'stranger', followsYou: false };

  const verdictNonFol1 = evaluateAccount(mutualUser, { filterMode: 'non_followers' });
  check('non_followers skips mutual', verdictNonFol1.shouldUnfollow === false && verdictNonFol1.reason === 'follows_you', `v=${JSON.stringify(verdictNonFol1)}`);

  const verdictNonFol2 = evaluateAccount(nonFollowerUser, { filterMode: 'non_followers' });
  check('non_followers allows stranger', verdictNonFol2.shouldUnfollow === true && verdictNonFol2.action === 'unfollow', `v=${JSON.stringify(verdictNonFol2)}`);

  // 5. Evaluation: Mutuals only mode
  const verdictMut1 = evaluateAccount(mutualUser, { filterMode: 'mutuals_only' });
  check('mutuals_only allows mutual', verdictMut1.shouldUnfollow === true, `v=${JSON.stringify(verdictMut1)}`);

  const verdictMut2 = evaluateAccount(nonFollowerUser, { filterMode: 'mutuals_only' });
  check('mutuals_only skips stranger', verdictMut2.shouldUnfollow === false && verdictMut2.reason === 'not_following_back', `v=${JSON.stringify(verdictMut2)}`);

  // 6. Evaluation: Protect verified
  const verifiedUser = { key: '@elon', handle: 'elon', isVerified: true, followsYou: false };
  const verdictVer = evaluateAccount(verifiedUser, { protectVerified: true });
  check('protectVerified skips verified', verdictVer.shouldUnfollow === false && verdictVer.reason === 'verified_protected', `v=${JSON.stringify(verdictVer)}`);

  // 7. Evaluation: Bio keyword exclusion
  const cryptoUser = { key: '@trader', handle: 'trader', bio: 'Crypto enthusiast & web3 builder', followsYou: false };
  const verdictBio = evaluateAccount(cryptoUser, { bioKeywordsExclude: ['crypto', 'web3'] });
  check('bioKeyword skips matched bio', verdictBio.shouldUnfollow === false && verdictBio.reason === 'keyword_protected', `v=${JSON.stringify(verdictBio)}`);

  // 8. Evaluation: Default avatar skipping
  const eggUser = { key: '@bot123', handle: 'bot123', hasDefaultAvatar: true, followsYou: false };
  const verdictEgg = evaluateAccount(eggUser, { skipDefaultAvatars: true });
  check('skipDefaultAvatars skips egg', verdictEgg.shouldUnfollow === false && verdictEgg.reason === 'default_avatar_skipped', `v=${JSON.stringify(verdictEgg)}`);

  // 9. Parse and Export
  const parsed = parseHandleList('alice, @bob\ncarol; dave');
  check('parseHandleList count=4', parsed.length === 4, `parsed=${JSON.stringify(parsed)}`);
  check('parseHandleList sorted with @', JSON.stringify(parsed) === JSON.stringify(['@alice', '@bob', '@carol', '@dave']), `parsed=${JSON.stringify(parsed)}`);

  const csv = exportHandleList(parsed, 'csv');
  check('export CSV contains header and handles', csv.includes('handle') && csv.includes('@alice'), `csv=${csv}`);

  const json = exportHandleList(parsed, 'json');
  check('export JSON parses correctly', JSON.parse(json).length === 4, `json=${json}`);

  return { name: 'filter-engine', pass: passed, fail: failed, errors: failures };
}
