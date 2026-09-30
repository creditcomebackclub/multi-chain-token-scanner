import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { config } from '../src/config.js';
import { Http } from '../src/providers/http.js';

const now = Date.parse('2026-09-05T00:00:00Z');
test('HTTP serializes concurrent callers and paces request starts globally', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const starts: number[] = [];
  let release!: (response: Response) => void;
  const http = new Http(10_000, async () => {
    starts.push(Date.now());
    return starts.length === 1 ? new Promise<Response>(resolve => { release = resolve; }) : Response.json({ ok: true });
  });
  const first = http.json('https://provider.invalid/first');
  const second = http.json('https://provider.invalid/second');
  await setImmediate();
  t.mock.timers.tick(20_000);
  await setImmediate();
  assert.equal(starts.length, 1, 'no concurrent fetch while first remains pending');
  release(Response.json({ ok: true }));
  await Promise.all([first, second]);
  const third = http.json('https://provider.invalid/third');
  await setImmediate();
  t.mock.timers.tick(9999);
  await setImmediate();
  assert.equal(starts.length, 2);
  t.mock.timers.tick(1);
  await third;
  assert.deepEqual(starts, [now, now + 20_000, now + 30_000]);
});

for (const [name, header, delay] of [
  ['seconds over one minute', '120', 120_000],
  ['HTTP date', new Date(now + 180_000).toUTCString(), 180_000],
  ['missing header', null, 60_000],
  ['malformed header', 'not-a-date', 60_000],
  ['negative seconds', '-1', 60_000],
  ['short header still respects request pacing', '1', 10_000],
] as const) {
  test(`429 retry honors ${name} before retrying the same request`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
    const starts: number[] = [];
    const http = new Http(10_000, async () => {
      starts.push(Date.now());
      return starts.length === 1 ? new Response('rate limited', { status: 429, headers: header ? { 'Retry-After': header } : {} }) : Response.json({ recovered: true });
    }, { rateLimitRetries: 2 });
    const request = http.json('https://provider.invalid/?token=secret');
    await setImmediate();
    t.mock.timers.tick(delay - 1);
    await setImmediate();
    assert.equal(starts.length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await request, { recovered: true });
    assert.deepEqual(starts, [now, now + delay]);
  });
}

test('exhausted retries retain the cooldown for queued callers and hide credentials', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const starts: number[] = [];
  const http = new Http(10_000, async () => {
    starts.push(Date.now());
    return starts.length <= 3 ? new Response('secret token in upstream error', { status: 429 }) : Response.json({ ok: true });
  }, { rateLimitRetries: 2 });
  const failure = assert.rejects(http.json('https://provider.invalid/?token=secret'), { message: 'Provider HTTP 429' });
  const queued = http.json('https://provider.invalid/next');
  await setImmediate();
  t.mock.timers.tick(60_000);
  await setImmediate();
  t.mock.timers.tick(60_000);
  await failure;
  await setImmediate();
  assert.equal(starts.length, 3, 'initial request plus only two retries');
  t.mock.timers.tick(60_000);
  assert.deepEqual(await queued, { ok: true });
  assert.deepEqual(starts, [now, now + 60_000, now + 120_000, now + 180_000]);
});

test('network failures are sanitized and do not poison the serial queue', async () => {
  let requests = 0;
  const http = new Http(0, async () => {
    if (++requests === 1) throw new Error('https://provider.invalid/?token=secret');
    return Response.json({ ok: true });
  });
  await assert.rejects(http.json('https://provider.invalid/?token=secret'), { message: 'Provider request timed out or connection failed' });
  assert.deepEqual(await http.json('https://provider.invalid/next'), { ok: true });
});

test('disconnect cancellation interrupts a retry cooldown without spending another request', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const controller = new AbortController();
  let requests = 0;
  const http = new Http(10_000, async () => {
    requests++;
    return new Response('limited', { status: 429 });
  }, { rateLimitRetries: 2 });
  const cancelled = assert.rejects(http.json('https://provider.invalid', { signal: controller.signal }), { message: 'Provider request cancelled' });
  await setImmediate();
  controller.abort('credential-bearing reason must not be exposed');
  await cancelled;
  t.mock.timers.tick(180_000);
  await setImmediate();
  assert.equal(requests, 1);
});

test('caller cancellation reaches the active fetch and prevents queued aborted work', async () => {
  const controller = new AbortController();
  let requests = 0;
  const http = new Http(0, async (_url, init) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('secret')), { once: true }));
  });
  const first = assert.rejects(http.json('https://provider.invalid', { signal: controller.signal }), { message: 'Provider request cancelled' });
  const second = assert.rejects(http.json('https://provider.invalid', { signal: controller.signal }), { message: 'Provider request cancelled' });
  await setImmediate();
  controller.abort();
  await Promise.all([first, second]);
  assert.equal(requests, 1);
});

test('Bitquery request allowance defaults conservatively and rejects invalid rates', () => {
  assert.equal(config({}).bitqueryRequestsPerMinute, 6);
  assert.equal(config({ BITQUERY_REQUESTS_PER_MINUTE: '9' }).bitqueryRequestsPerMinute, 9);
  for (const rate of ['0', '-1', 'NaN', 'Infinity', '601']) {
    assert.throws(() => config({ BITQUERY_REQUESTS_PER_MINUTE: rate }), /Invalid BITQUERY_REQUESTS_PER_MINUTE/);
  }
});

test('public feed minimum cooldown overrides a short Retry-After for the next caller',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now});
 let calls=0;const http=new Http(12000,async()=>++calls===1?new Response('',{status:429,headers:{'Retry-After':'1'}}):Response.json({ok:true}),{minRateLimitCooldownMs:60000});
 await assert.rejects(http.json('https://provider.invalid/a'),/429/);
 const next=http.json('https://provider.invalid/b');await setImmediate();
 t.mock.timers.tick(59999);await setImmediate();assert.equal(calls,1);
 t.mock.timers.tick(1);await next;assert.equal(calls,2);
});
