const MAX_TRACKED_CLIENTS = 10_000;
const OVERFLOW_CLIENT = "__overflow_clients__";

interface RateBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(clientId: string): RateLimitDecision {
    const now = this.now();
    let bucketKey = clientId;
    let bucket = this.buckets.get(bucketKey);

    if (bucket === undefined && this.buckets.size >= MAX_TRACKED_CLIENTS - 1) {
      for (const [key, candidate] of this.buckets) {
        if (candidate.resetAt <= now) this.buckets.delete(key);
      }
      if (this.buckets.size >= MAX_TRACKED_CLIENTS - 1) {
        bucketKey = OVERFLOW_CLIENT;
        bucket = this.buckets.get(bucketKey);
      }
    }

    if (bucket === undefined || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    return {
      allowed: bucket.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  }
}
