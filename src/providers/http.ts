export type Fetch = typeof fetch;
interface HttpOptions { rateLimitRetries?: number; minRateLimitCooldownMs?: number }
const cancelled = () => new Error('Provider request cancelled');
const wait = (delay: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(cancelled()); return; }
  const cleanup = () => signal?.removeEventListener('abort', abort);
  const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
  const abort = () => { clearTimeout(timer); cleanup(); reject(cancelled()); };
  signal?.addEventListener('abort', abort, { once: true });
});
const retryDelay = (value: string | null, now: number) => {
  if (value !== null && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && Number.isFinite(seconds * 1000)) return Math.max(1000, seconds * 1000);
  } else if (value && /[a-z]/i.test(value)) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.max(1000, at - now);
  }
  return 60_000;
};
export class Http {
  private next = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private intervalMs: number, private fetcher: Fetch = fetch, private options: HttpOptions = {}) {}
  json(url: string, init: RequestInit = {}): Promise<any> {
    const task = this.queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        if (init.signal?.aborted) throw cancelled();
        // Keep retries in the same shared queue so every caller observes the cooldown.
        while (this.next > Date.now()) {
          await wait(Math.min(this.next - Date.now(), 2_147_483_647), init.signal);
        }
        if (init.signal?.aborted) throw cancelled();
        this.next = Date.now() + this.intervalMs;
        let response: Response;
        const timeout = AbortSignal.timeout(15_000);
        try { response = await this.fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout }); }
        catch { throw init.signal?.aborted ? cancelled() : new Error('Provider request timed out or connection failed'); } // never expose credential URLs
        if (!response.ok) {
          if (response.status === 429) {
            this.next = Math.max(this.next, Date.now() + Math.max(this.options.minRateLimitCooldownMs ?? 0, retryDelay(response.headers.get('retry-after'), Date.now())));
            await response.body?.cancel().catch(() => undefined);
            if (attempt < (this.options.rateLimitRetries ?? 0)) continue;
          }
          throw new Error(`Provider HTTP ${response.status}`);
        }
        try { return await response.json(); } catch { throw new Error('Provider returned invalid JSON'); }
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
