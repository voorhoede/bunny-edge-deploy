const BACKOFF_MS = [500, 1000, 2000];

export const isTransientStatus = (status) => status === 429 || status >= 500;

/** Retries `attempt` on transient failures. `attempt` must throw an error with `transient: true` to be retried. */
export async function withRetry(attempt, { attempts = 3, sleep = defaultSleep } = {}) {
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      const canRetry = index + 1 < attempts && (error.transient || error instanceof TypeError);
      if (!canRetry) throw error;
      await sleep(BACKOFF_MS[Math.min(index, BACKOFF_MS.length - 1)]);
    }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
