function createSlidingWindowRateLimiter(limit, windowMs, now = Date.now) {
  const hits = new Map();

  return function isRateLimited(key) {
    const timestamp = now();
    const recentHits = (hits.get(key) || []).filter(
      (hit) => timestamp - hit < windowMs,
    );
    recentHits.push(timestamp);
    hits.set(key, recentHits);

    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return recentHits.length > limit;
  };
}

module.exports = { createSlidingWindowRateLimiter };
