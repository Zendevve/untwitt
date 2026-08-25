// In-memory processing queue and account-state machine.
// Pure ES module: no DOM, no X selectors, no global state.

export function createQueue() {
  const accounts = new Map();
  const order = [];

  const counts = {
    discovered: 0,
    queued: 0,
    unfollowed: 0,
    failed: 0,
    skipped: 0,
  };

  function add(identity) {
    const key = identity.key;
    if (accounts.has(key)) return false;

    const account = {
      key,
      handle: identity.handle,
      displayName: identity.displayName,
      state: "queued",
      addedAt: Date.now(),
    };
    accounts.set(key, account);
    order.push(key);
    counts.discovered += 1;
    counts.queued += 1;
    return true;
  }

  function markProcessing(key) {
    const account = accounts.get(key);
    if (!account) return null;
    if (account.state === "queued") counts.queued -= 1;
    account.state = "processing";
    return account;
  }

  function markResult(key, result) {
    const account = accounts.get(key);
    if (!account) return null;

    if (account.state === "queued") counts.queued -= 1;

    if (result === "success") counts.unfollowed += 1;
    else if (result === "failed") counts.failed += 1;
    else if (result === "skipped") counts.skipped += 1;

    account.state = result;
    account.processedAt = Date.now();
    accounts.delete(key);
    return account;
  }

  function queuedCount() {
    let n = 0;
    for (const account of accounts.values()) {
      if (account.state === "queued") n += 1;
    }
    return n;
  }

  function processingCount() {
    let n = 0;
    for (const account of accounts.values()) {
      if (account.state === "processing") n += 1;
    }
    return n;
  }

  function countsSnapshot() {
    return {
      discovered: counts.discovered,
      queued: counts.queued,
      unfollowed: counts.unfollowed,
      failed: counts.failed,
      skipped: counts.skipped,
    };
  }

  function peek() {
    for (const key of order) {
      const account = accounts.get(key);
      if (account && account.state === "queued") return account;
    }
    return null;
  }

  function popNext() {
    const account = peek();
    if (!account) return null;
    return markProcessing(account.key);
  }

  function reset() {
    accounts.clear();
    order.length = 0;
    counts.discovered = 0;
    counts.queued = 0;
    counts.unfollowed = 0;
    counts.failed = 0;
    counts.skipped = 0;
  }

  function all() {
    const list = [];
    for (const key of order) {
      const account = accounts.get(key);
      if (account) list.push(account);
    }
    return list;
  }

  return {
    add,
    markProcessing,
    markResult,
    queuedCount,
    processingCount,
    counts: countsSnapshot,
    peek,
    popNext,
    reset,
    all,
  };
}
