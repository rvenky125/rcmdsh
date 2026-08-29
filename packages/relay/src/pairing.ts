export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): boolean {
    const now = Date.now();
    const window = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (window.length >= this.limit) {
      this.hits.set(key, window);
      return false;
    }
    window.push(now);
    this.hits.set(key, window);
    return true;
  }
}
