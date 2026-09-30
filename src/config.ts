import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const MAX_ALERTS_PER_24H = 10;
export const MAX_SCOUT_ALERTS_PER_24H = 3;
export const CHART_WATCHLIST_SIZE = 10;
export const CHAINS = {
  solana: { name: 'Solana', bid: 'bid:solana', dex: 'solana', securityId: 'solana', minLiquidity: 20_000, fomo: true },
  ethereum: { name: 'Ethereum', bid: 'bid:eth', dex: 'ethereum', securityId: '1', minLiquidity: 40_000, fomo: true },
  bnb: { name: 'BNB Chain', bid: 'bid:bsc', dex: 'bsc', securityId: '56', minLiquidity: 40_000, fomo: true },
  robinhood: { name: 'Robinhood', bid: 'bid:robinhood', dex: 'robinhood', securityId: '4663', minLiquidity: 20_000, fomo: true },
  base: { name: 'Base', bid: 'bid:base', dex: 'base', securityId: '8453', minLiquidity: 40_000, fomo: false },
} as const;
export type Chain = keyof typeof CHAINS;
const positive = z.number().finite().positive();
const fraction = z.number().min(0).max(1);
const ruleSchema = z.object({
  version: z.string().min(1), minPoolAgeMinutes: positive, maxPoolAgeHours: positive,
  minVolume5mUsd: positive, minSwaps5m: positive.int(), minBuyers5m: positive.int(),
  minBuySellCountRatio: positive, minBuySellUsdRatio: positive, maxBuyerShare: fraction,
  maxTopFiveShare: fraction, maxFdvLiquidity: positive, maxPriceChange5mPercent: positive,
  maxTax: fraction, maxHolderShare: fraction, maxTopTenHolderShare: fraction,
  alertThreshold: z.number().int().min(80).max(100), hitTargetPercent: positive,
  hitMaxDrawdownPercent: positive, evaluationOrderUsd: positive, maxPriceImpactPercent: positive,
}).strict();
export const rules = ruleSchema.parse(JSON.parse(readFileSync(new URL('../config/rules.json', import.meta.url), 'utf8')));
// Hash both thresholds and algorithm revision; approval cannot survive a rule change.
export const RULE_ID = `${rules.version}-${createHash('sha256').update(JSON.stringify({ rules, algorithm: 2, chains: CHAINS })).digest('hex').slice(0, 12)}`;
const bool = (v: string | undefined, fallback = false) => {
  if (!v) return fallback;
  if (!['true', 'false'].includes(v)) throw new Error('Boolean settings must be true or false');
  return v === 'true';
};
export function config(env = process.env) {
  const chains = (env.CHAINS || 'solana,ethereum,bnb,robinhood,base').split(',').map(c => c.trim());
  if (chains.some(c => !(c in CHAINS)) || new Set(chains).size !== chains.length) throw new Error('Invalid CHAINS');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const bitqueryRequestsPerMinute = Number(env.BITQUERY_REQUESTS_PER_MINUTE || 6);
  const researchRoundTripCostBps = Number(env.RESEARCH_ROUND_TRIP_COST_BPS || 200);
  const scanMode = z.enum(['full', 'shortlist']).parse(env.SCAN_MODE || 'full');
  if (!Number.isFinite(bitqueryRequestsPerMinute) || bitqueryRequestsPerMinute <= 0 || bitqueryRequestsPerMinute > 600) throw new Error('Invalid BITQUERY_REQUESTS_PER_MINUTE');
  if (!Number.isFinite(researchRoundTripCostBps) || researchRoundTripCostBps < 0 || researchRoundTripCostBps > 2000) throw new Error('Invalid RESEARCH_ROUND_TRIP_COST_BPS');
  return {
    chains: chains as Chain[], port, databaseUrl: env.DATABASE_URL || '', scanMode,
    bitqueryToken: env.BITQUERY_TOKEN || '', bitqueryRequestsPerMinute, heliusKey: env.HELIUS_API_KEY || '',
    coingeckoProKey: env.COINGECKO_PRO_API_KEY || '',
    heliusEnabled: bool(env.HELIUS_ENABLED),
    heliusPrograms: (env.HELIUS_PROGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    goplusToken: env.GOPLUS_TOKEN || '', telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    ingestionEnabled: bool(env.INGESTION_ENABLED, true),
    telegramChatId: env.TELEGRAM_CHAT_ID || '', pushEnabled: bool(env.PUSH_ENABLED),
    scoutPushEnabled: bool(env.SCOUT_PUSH_ENABLED),
    baseFomoConfirmed: bool(env.BASE_FOMO_CONFIRMED), walletWatchEnabled: bool(env.WALLET_WATCH_ENABLED),
    chartSetupsEnabled: bool(env.CHART_SETUPS_ENABLED), researchRoundTripCostBps,
  };
}
export type Config = ReturnType<typeof config>;
export const fomoAllowed = (chain: Chain, c: Config) => CHAINS[chain].fomo || (chain === 'base' && c.baseFomoConfirmed);
export function address(chain: Chain, value: unknown): string {
  if (typeof value !== 'string' || !(chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/).test(value)) throw new Error('Invalid token address');
  return chain === 'solana' ? value : value.toLowerCase();
}
export const key = (chain: Chain, token: string) => `${chain}:${address(chain, token)}`;
