// Sliding-window rate limiter shared across host callbacks.

const SUBMIT_WINDOW_MS = 10_000;
const SUBMIT_MAX_PER_WINDOW = 20;

export function createSubmitRateLimiter(): { allow: () => boolean } {
  const timestamps: number[] = [];
  return {
    allow() {
      const now = Date.now();
      while (timestamps.length > 0 && timestamps[0] <= now - SUBMIT_WINDOW_MS) {
        timestamps.shift();
      }
      if (timestamps.length >= SUBMIT_MAX_PER_WINDOW) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
  };
}
