import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../src/limits.js';

describe('RateLimiter', () => {
  it('allows a burst up to the rate, then refills at the rate', () => {
    let now = 0;
    const limiter = new RateLimiter(60, () => now);
    for (let i = 0; i < 60; i += 1) expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(1000);
    now += 500;
    expect(limiter.take('a')).toBe(500);
    now += 500;
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(1000);
  });

  it('keeps each controller to its own allowance', () => {
    const limiter = new RateLimiter(1, () => 0);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBeGreaterThan(0);
    expect(limiter.take('b')).toBe(0);
  });

  it('forgets a controller once its bucket is full again', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    limiter.take('a');
    limiter.take('a');
    now += 60_000;
    limiter.sweep();
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBe(0);
    expect(limiter.take('a')).toBeGreaterThan(0);
  });
});
