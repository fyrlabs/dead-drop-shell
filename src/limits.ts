import { performance } from 'node:perf_hooks';

/**
 * A token bucket per controller: `perMinute` requests, refilled continuously,
 * so a burst of up to `perMinute` goes through and a steady stream is held to
 * the rate.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Takes one request for `identity`: 0 when allowed, else milliseconds until one would be. */
  take(identity: string): number {
    const now = this.now();
    const bucket = this.refill(identity, now);
    this.buckets.set(identity, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - bucket.tokens) * 60_000) / this.perMinute);
  }

  /** Forgets controllers whose bucket has refilled: they are back to the default. */
  sweep(): void {
    const now = this.now();
    for (const identity of this.buckets.keys()) {
      if (this.refill(identity, now).tokens >= this.perMinute) this.buckets.delete(identity);
    }
  }

  private refill(identity: string, now: number): { tokens: number; at: number } {
    const bucket = this.buckets.get(identity);
    if (!bucket) return { tokens: this.perMinute, at: now };
    const tokens = bucket.tokens + ((now - bucket.at) * this.perMinute) / 60_000;
    return Object.assign(bucket, { tokens: Math.min(this.perMinute, tokens), at: now });
  }
}
