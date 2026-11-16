function createKeyedQueue({ maxPending = 200, onOverflow, onError } = {}) {
  const configuredLimit = Number(maxPending);
  const limit =
    Number.isFinite(configuredLimit) && configuredLimit > 0
      ? Math.max(1, Math.trunc(configuredLimit))
      : 200;
  const tails = new Map();
  const pendingByKey = new Map();
  const overflowNotified = new Set();

  return function enqueue(key, task) {
    const pending = pendingByKey.get(key) || 0;
    if (pending >= limit) {
      if (!overflowNotified.has(key)) {
        overflowNotified.add(key);
        onOverflow?.(key, pending);
      }
      return false;
    }

    pendingByKey.set(key, pending + 1);
    const previous = tails.get(key) || Promise.resolve();
    let current;
    current = previous
      .then(task)
      .catch((error) => {
        if (onError) onError(error, key);
        else console.error("[event error]", error);
      })
      .finally(() => {
        const remaining = (pendingByKey.get(key) || 1) - 1;
        if (remaining > 0) pendingByKey.set(key, remaining);
        else {
          pendingByKey.delete(key);
          overflowNotified.delete(key);
        }
        if (tails.get(key) === current) tails.delete(key);
      });
    tails.set(key, current);
    return true;
  };
}

module.exports = { createKeyedQueue };
