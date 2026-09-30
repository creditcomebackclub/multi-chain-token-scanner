import { address, MINUTE, type Chain } from '../config.js';
import { Http } from './http.js';

export interface DiscoveryCandidate {
  chain: Chain; token: string; pool: string; createdAt: number; fetchedAt: number; liquidity: number;
  volume5m: number; volume24h?: number | null; buys5m: number; sells5m: number; buyers5m: number | null; sellers5m: number | null;
  name: string; symbol: string; priceUsd: number | null; source: 'geckoterminal'; url: string;
}
export interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  health: Partial<Record<Chain, { ok: boolean; detail: string }>>;
}
export const networks: Record<Chain, string> = { solana: 'solana', ethereum: 'eth', bnb: 'bsc', robinhood: 'robinhood', base: 'base' };
const numeric = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const count = (value: unknown): number | null => {
  const n = numeric(value);
  return n !== null && Number.isSafeInteger(n) ? n : null;
};
function parse(chain: Chain, raw: any, included: any[], now: number): DiscoveryCandidate | null {
  try {
    const network = networks[chain], a = raw?.attributes, identity = raw?.relationships?.base_token?.data;
    if (raw?.type !== 'pool' || identity?.type !== 'token' || typeof identity.id !== 'string' || !identity.id.startsWith(`${network}_`)) return null;
    const token = address(chain, identity.id.slice(network.length + 1));
    const metadata = included.find(item => item?.type === 'token' && item.id === identity.id)?.attributes;
    if (metadata?.address !== undefined && address(chain, metadata.address) !== token) return null;
    if (typeof a?.address !== 'string') return null;
    const pool = chain === 'solana' ? address(chain, a.address) : /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(a.address) ? a.address.toLowerCase() : null;
    if (!pool || typeof a.pool_created_at !== 'string') return null;
    const createdAt = Date.parse(a.pool_created_at), liquidity = numeric(a.reserve_in_usd), volume5m = numeric(a.volume_usd?.m5);
    const buys5m = count(a.transactions?.m5?.buys), sells5m = count(a.transactions?.m5?.sells);
    if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt > now || liquidity === null || volume5m === null || buys5m === null || sells5m === null) return null;
    const price = numeric(a.base_token_price_usd);
    return {
      chain, token, pool, createdAt, fetchedAt: now, liquidity, volume5m, volume24h: numeric(a.volume_usd?.h24), buys5m, sells5m,
      buyers5m: count(a.transactions?.m5?.buyers), sellers5m: count(a.transactions?.m5?.sellers),
      name: typeof metadata?.name === 'string' && metadata.name ? metadata.name.slice(0, 100) : 'Unknown token',
      symbol: typeof metadata?.symbol === 'string' && metadata.symbol ? metadata.symbol.slice(0, 30) : '?',
      priceUsd: price !== null && price > 0 ? price : null,
      source: 'geckoterminal', url: `https://www.geckoterminal.com/${network}/pools/${encodeURIComponent(pool)}`,
    };
  } catch { return null; }
}

export class FreeDiscovery {
  private chainOffset = 0;
  constructor(private http = new Http(9000), private cycleTimeoutMs = 285_000) {}
  async discover(chains: Chain[]): Promise<DiscoveryResult> {
    const candidates: DiscoveryCandidate[] = [], health: DiscoveryResult['health'] = {};
    const signal = AbortSignal.timeout(this.cycleTimeoutMs);
    const unique=[...new Set(chains)];
    const offset=this.chainOffset++ % Math.max(1,unique.length);
    const ordered=[...unique.slice(offset),...unique.slice(0,offset)];
    for (const chain of ordered) {
      const selected = new Map<string, DiscoveryCandidate>();
      const failures: string[] = [];
      let successes = 0, ignored = 0;
      for (const endpoint of ['new_pools', 'trending_pools']) {
        try {
          const data = await this.http.json(`https://api.geckoterminal.com/api/v2/networks/${networks[chain]}/${endpoint}?page=1&include=base_token`, { signal });
          if (!Array.isArray(data?.data) || (data.included !== undefined && !Array.isArray(data.included))) throw new Error('Invalid discovery response');
          const now = Date.now();
          for (const row of data.data.slice(0, 20)) {
            const candidate = parse(chain, row, data.included ?? [], now);
            if (candidate) selected.set(candidate.pool, candidate); else ignored++;
          }
          successes++;
        } catch (error) {
          const reason = signal.aborted ? 'refresh time budget exhausted' : error instanceof Error && /^Provider HTTP \d+$/.test(error.message) ? error.message : 'unavailable or invalid response';
          failures.push(`${endpoint}: ${reason}`);
        }
      }
      candidates.push(...selected.values());
      health[chain] = { ok: successes === 2, detail: `${successes}/2 public pool feeds available; ${selected.size} pools; ${ignored} incomplete rows skipped. Discovery coverage is limited.${failures.length ? ` ${failures.join('; ')}` : ''}` };
    }
    // An earlier chain's response must not look fresh after later feeds stall.
    const fresh = candidates.filter(candidate => Date.now() - candidate.fetchedAt <= 2 * MINUTE);
    for (const chain of new Set(candidates.filter(candidate => !fresh.includes(candidate)).map(candidate => candidate.chain))) {
      health[chain] = { ok: false, detail: `${health[chain]?.detail ?? ''} Stale responses discarded.` };
    }
    return { candidates: fresh, health };
  }
}
