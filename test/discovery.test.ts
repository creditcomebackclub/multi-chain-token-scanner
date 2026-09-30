import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chain } from '../src/config.js';
import { FreeDiscovery } from '../src/providers/discovery.js';
import { Http } from '../src/providers/http.js';

const sol = 'So11111111111111111111111111111111111111112';
const evm = '0x' + 'aB'.repeat(20), pool = '0x' + 'cD'.repeat(20);
const networks: Record<Chain, string> = { solana: 'solana', ethereum: 'eth', bnb: 'bsc', base: 'base', robinhood: 'robinhood' };
function fixture(chain: Chain = 'ethereum', index = 0): any {
  const token = chain === 'solana' ? sol : evm;
  return { data: [{
    type: 'pool', id: 'ignored-pool-id',
    attributes: {
      address: chain === 'solana' ? sol : index ? `0x${index.toString(16).padStart(40, '0')}` : pool,
      name: 'UNTRUSTED_NAME / NOT_THE_TOKEN', pool_created_at: '2026-09-01T00:00:00Z',
      reserve_in_usd: '50000', volume_usd: { m5: '20000' }, base_token_price_usd: '0.001',
      transactions: { m5: { buys: 35, sells: 15, buyers: 26, sellers: 10 } },
    },
    relationships: { base_token: { data: { type: 'token', id: `${networks[chain]}_${token}` } } },
  }], included: [{ type: 'token', id: `${networks[chain]}_${token}`, attributes: { address: token, name: 'Actual token', symbol: 'ACTUAL' } }] };
}
test('public discovery maps every configured chain and uses explicit base-token identity', async () => {
  const requested: string[] = [];
  const chains = ['solana', 'ethereum', 'bnb', 'robinhood', 'base'] as Chain[];
  const discovery = new FreeDiscovery(new Http(0, async url => {
    requested.push(String(url));
    const chain = chains.find(c => String(url).includes(`/networks/${networks[c]}/`))!;
    return Response.json(fixture(chain));
  }));
  const result = await discovery.discover(chains);
  assert.equal(requested.length, 10);
  assert.equal(result.candidates.length, 5, 'same pool in new and trending feeds is deduplicated');
  for (const c of result.candidates) {
    assert.equal(c.token, c.chain === 'solana' ? sol : evm.toLowerCase());
    assert.equal(c.name, 'Actual token'); assert.equal(c.symbol, 'ACTUAL');
    assert.equal(c.volume5m, 20000); assert.equal(c.buyers5m, 26);
    assert.equal(c.liquidity, 50000); assert.equal(c.priceUsd, 0.001);
    assert.ok(Date.now() - c.fetchedAt < 1000);
    assert.equal(c.url, `https://www.geckoterminal.com/${networks[c.chain]}/pools/${c.pool}`);
    assert.equal(result.health[c.chain]?.ok, true);
  }
  assert.ok(requested.every(url => url.endsWith('?page=1&include=base_token')));
});

test('malformed identities and missing required market data never become candidates', async () => {
  const mutations = [
    (p: any) => delete p.data[0].relationships,
    (p: any) => p.data[0].relationships.base_token.data.id = 'base_' + evm,
    (p: any) => p.data[0].relationships.base_token.data.id = 'eth_bad',
    (p: any) => p.included[0].attributes.address = '0x' + '11'.repeat(20),
    (p: any) => p.data[0].attributes.address = 'https://evil.invalid',
    (p: any) => p.data[0].attributes.pool_created_at = 'not-a-date',
    (p: any) => p.data[0].attributes.pool_created_at = '2999-01-01T00:00:00Z',
    (p: any) => delete p.data[0].attributes.reserve_in_usd,
    (p: any) => p.data[0].attributes.reserve_in_usd = '',
    (p: any) => p.data[0].attributes.volume_usd.m5 = null,
    (p: any) => p.data[0].attributes.volume_usd.m5 = '-1',
    (p: any) => p.data[0].attributes.transactions.m5.buys = 1.5,
    (p: any) => delete p.data[0].attributes.transactions.m5.sells,
  ];
  for (const mutate of mutations) {
    const data = fixture(); mutate(data);
    const result = await new FreeDiscovery(new Http(0, async () => Response.json(data))).discover(['ethereum']);
    assert.equal(result.candidates.length, 0);
  }
});

test('unknown optional buyer counts and price stay null while observed zero is retained', async () => {
  const data = fixture();
  delete data.data[0].attributes.transactions.m5.buyers;
  data.data[0].attributes.transactions.m5.sellers = 0;
  data.data[0].attributes.base_token_price_usd = null;
  data.data[0].attributes.volume_usd.m5 = '0';
  data.included = [];
  const { candidates: [candidate] } = await new FreeDiscovery(new Http(0, async () => Response.json(data))).discover(['ethereum']);
  assert.equal(candidate.buyers5m, null); assert.equal(candidate.sellers5m, 0);
  assert.equal(candidate.priceUsd, null); assert.equal(candidate.volume5m, 0);
  assert.equal(candidate.name, 'Unknown token'); assert.equal(candidate.symbol, '?');
});

test('endpoint failures preserve available candidates and report partial health', async () => {
  const result = await new FreeDiscovery(new Http(0, async url => String(url).includes('trending_pools') ? new Response('unavailable', { status: 503 }) : Response.json(fixture('robinhood')))).discover(['robinhood']);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.health.robinhood?.ok, false);
  assert.match(result.health.robinhood!.detail, /1\/2 public pool feeds/);
  assert.match(result.health.robinhood!.detail, /trending_pools: Provider HTTP 503/);
  const empty = await new FreeDiscovery(new Http(0, async () => Response.json({ errors: ['unavailable'] }))).discover(['robinhood']);
  assert.equal(empty.health.robinhood?.ok, false); assert.equal(empty.candidates.length, 0);
});

test('discovery caps each chain to forty pools and preserves singleton pool IDs', async () => {
  let calls = 0;
  const http = new Http(0, async () => {
    const start = ++calls === 1 ? 1 : 101;
    const data = fixture('robinhood');
    data.data = Array.from({ length: 25 }, (_, i) => fixture('robinhood', start + i).data[0]);
    if (calls === 1) data.data[0].attributes.address = '0x' + 'EF'.repeat(32);
    return Response.json(data);
  });
  const result = await new FreeDiscovery(http).discover(['robinhood', 'robinhood']);
  assert.equal(calls, 2); assert.equal(result.candidates.length, 40);
  assert.equal(result.candidates[0].pool, '0x' + 'ef'.repeat(32));
});

test('a shared refresh deadline cancels rate-limit waits instead of stalling every chain', async () => {
  let calls = 0;
  const http = new Http(0, async () => { calls++; return new Response('limited', { status: 429 }); });
  const result = await new FreeDiscovery(http, 10).discover(['ethereum', 'robinhood']);
  assert.equal(calls, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.health.ethereum?.ok, false);
  assert.equal(result.health.robinhood?.ok, false);
  assert.match(result.health.robinhood!.detail, /refresh time budget exhausted/);
});

test('old chain responses keep their fetch time and are discarded after a stalled cycle', async t => {
  const start = Date.parse('2026-09-06T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const http = new Http(0, async url => {
    if (String(url).includes('/robinhood/')) {
      t.mock.timers.setTime(start + 3 * 60_000);
      return Response.json(fixture('robinhood'));
    }
    return Response.json(fixture('ethereum'));
  });
  const result = await new FreeDiscovery(http).discover(['ethereum', 'robinhood']);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].chain, 'robinhood');
  assert.equal(result.candidates[0].fetchedAt, start + 3 * 60_000);
  assert.equal(result.health.ethereum?.ok, false);
  assert.match(result.health.ethereum!.detail, /Stale responses discarded/);
});

test('discovery rotates chain order so deadline pressure cannot always exclude the same chains',async()=>{
 const calls:string[]=[];const d=new FreeDiscovery(new Http(0,async u=>{const chain=String(u).includes('/eth/')?'ethereum':'bnb';calls.push(chain);return Response.json(fixture(chain));}));
 await d.discover(['ethereum','bnb']);await d.discover(['ethereum','bnb']);
 assert.deepEqual(calls,['ethereum','ethereum','bnb','bnb','bnb','bnb','ethereum','ethereum']);
});
