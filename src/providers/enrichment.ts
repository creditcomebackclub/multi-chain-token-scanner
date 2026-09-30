import { CHAINS, address, type Chain } from '../config.js';
import { checkSecurity, number, object, unknownSecurity } from '../security.js';
import type { Market, Security } from '../types.js';
import { Http } from './http.js';

export function parseMarket(chain: Chain, token: string, raw: unknown, now: number): Market | null {
  const p = object(raw);
  try {
    if (p.chainId !== CHAINS[chain].dex || address(chain, p.baseToken?.address) !== token) return null;
    const price = number(p.priceUsd), liquidity = number(p.liquidity?.usd), fdv = number(p.fdv), createdAt = number(p.pairCreatedAt);
    const priceChange5m = typeof p.priceChange?.m5 === 'number' && Number.isFinite(p.priceChange.m5) ? p.priceChange.m5 : null;
    if (price === null || price <= 0 || liquidity === null || fdv === null || fdv <= 0 || createdAt === null || createdAt > now || priceChange5m === null || typeof p.pairAddress !== 'string' || !p.pairAddress) return null;
    const url = new URL(p.url);
    if (url.protocol !== 'https:' || url.hostname !== 'dexscreener.com') return null;
    return { chain, token, pool: chain === 'solana' ? p.pairAddress : p.pairAddress.toLowerCase(), name: String(p.baseToken.name || 'Unnamed').slice(0, 100), symbol: String(p.baseToken.symbol || '?').slice(0, 30), chart: url.href, createdAt, fetchedAt: now, price, liquidity, fdv, marketCap: number(p.marketCap), priceChange5m, raw };
  } catch { return null; }
}
export class DexScreener {
  private cache = new Map<string, { at: number; markets: Market[] }>();
  constructor(private http = new Http(250)) {}
  async batch(chain: Chain, tokens: string[], now = Date.now()): Promise<Map<string, Market[]>> {
    const missing = [...new Set(tokens)].filter(t => now - (this.cache.get(`${chain}:${t}`)?.at ?? 0) >= 30_000);
    for (let i = 0; i < missing.length; i += 30) {
      const group = missing.slice(i, i + 30);
      const data = await this.http.json(`https://api.dexscreener.com/tokens/v1/${CHAINS[chain].dex}/${group.map(encodeURIComponent).join(',')}`);
      if (!Array.isArray(data)) throw new Error('DEX Screener schema mismatch');
      for (const t of group) this.cache.set(`${chain}:${t}`, { at: now, markets: data.map(p => parseMarket(chain, t, p, now)).filter((p): p is Market => p !== null).sort((a, b) => b.liquidity - a.liquidity) });
    }
    for (const [k, v] of this.cache) if (now - v.at > 60_000) this.cache.delete(k);
    return new Map(tokens.map(t => [t, this.cache.get(`${chain}:${t}`)?.markets || []]));
  }
}
export class GoPlus {
  constructor(private token = '', private http = new Http(2100)) {}
  async check(chain: Chain, token: string, exactPool?: string): Promise<Security> {
    const headers: Record<string, string> = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    try {
      const route = chain === 'solana' ? 'solana/token_security' : `token_security/${CHAINS[chain].securityId}`;
      const data = await this.http.json(`https://api.gopluslabs.io/api/v1/${route}?contract_addresses=${encodeURIComponent(token)}`, { headers });
      if (chain !== 'solana') {
        const record = Object.entries(object(data.result)).find(([k]) => k.toLowerCase() === token)?.[1];
        const creator = object(record).creator_address;
        if (typeof creator === 'string' && /^0x[0-9a-fA-F]{40}$/.test(creator)) data.creatorSecurity = await this.http.json(`https://api.gopluslabs.io/api/v1/address_security/${encodeURIComponent(creator)}?chain_id=${CHAINS[chain].securityId}`, { headers });
      }
      return checkSecurity(chain, token, data, Date.now(), exactPool);
    } catch { return unknownSecurity(Date.now(), 'GoPlus unavailable'); }
  }
}
