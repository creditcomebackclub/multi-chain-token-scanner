import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import WebSocket from 'ws';
import { z } from 'zod';
import { type Chain, type Config } from './config.js';
import type { Store } from './store.js';
import type { WalletTrade } from './types.js';
import type { Telegram } from './telegram.js';
import type { DexScreener } from './providers/enrichment.js';

const walletSchema = z.array(z.object({
  name: z.string().min(1).max(40),
  solana: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  evm: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase()),
}).strict()).min(1);

export const watchedWallets = walletSchema.parse(JSON.parse(readFileSync(new URL('../config/watched-wallets.json', import.meta.url), 'utf8')));
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const RPC: Record<Exclude<Chain, 'solana'>, { http: string; ws?: string; explorer: string }> = {
  ethereum: { http: 'https://ethereum-rpc.publicnode.com', ws: 'wss://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io/tx/' },
  bnb: { http: 'https://bsc-rpc.publicnode.com', ws: 'wss://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com/tx/' },
  base: { http: 'https://base-rpc.publicnode.com', ws: 'wss://base-rpc.publicnode.com', explorer: 'https://basescan.org/tx/' },
  robinhood: { http: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com/tx/' },
};
interface Quote { symbol: string; decimals: number; stable: boolean }
export const EVM_QUOTES: Record<Exclude<Chain, 'solana'>, Record<string, Quote>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, stable: false },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, stable: true },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, stable: true },
  },
  bnb: {
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18, stable: false },
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18, stable: true },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18, stable: true },
  },
  base: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, stable: false },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, stable: true },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6, stable: true },
  },
  robinhood: {
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { symbol: 'WETH', decimals: 18, stable: false },
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6, stable: true },
  },
};
const SOL_QUOTES: Record<string, Quote> = {
  So11111111111111111111111111111111111111112: { symbol: 'WSOL', decimals: 9, stable: false },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6, stable: true },
  Es9vMFrzaCERmJfrF4H2FYDtmqA8pM8YMfP8PEkz4U7: { symbol: 'USDT', decimals: 6, stable: true },
  native: { symbol: 'SOL', decimals: 9, stable: false },
};

interface RawSwap { side: 'buy' | 'sell'; token: string; tokenRaw: bigint; quote: string; quoteRaw: bigint }
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const fromTopic = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? `0x${value.slice(-40).toLowerCase()}` : null;
const raw = (value: unknown) => {
  try { return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : null; }
  catch { return null; }
};
const decimal = (value: bigint, decimals: number) => new Decimal(value.toString()).div(new Decimal(10).pow(decimals)).toSignificantDigits(10).toFixed();
const deadline = <T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> => Promise.race([
  promise.catch(() => fallback),
  new Promise<T>(resolve => setTimeout(() => resolve(fallback), milliseconds)),
]);
const chooseSwap = (deltas: Map<string, bigint>, quotes: Record<string, Quote>): RawSwap | null => {
  const quoteLegs = [...deltas].filter(([token]) => token in quotes && token !== ZERO && deltas.get(token) !== 0n);
  const tokens = [...deltas].filter(([token, amount]) => !(token in quotes) && token !== ZERO && amount !== 0n);
  for (const [quote, quoteDelta] of quoteLegs) {
    const token = tokens.find(([, tokenDelta]) => (quoteDelta < 0n && tokenDelta > 0n) || (quoteDelta > 0n && tokenDelta < 0n));
    if (token) return { side: quoteDelta < 0n ? 'buy' : 'sell', token: token[0], tokenRaw: token[1] < 0n ? -token[1] : token[1], quote, quoteRaw: quoteDelta < 0n ? -quoteDelta : quoteDelta };
  }
  return null;
};

export function evmSwap(receipt: any, wallet: string, quotes: Record<string, Quote>): RawSwap | null {
  const target = wallet.toLowerCase(), deltas = new Map<string, bigint>();
  if (!Array.isArray(receipt?.logs) || receipt.status === '0x0') return null;
  for (const log of receipt.logs) {
    if (!Array.isArray(log?.topics) || String(log.topics[0]).toLowerCase() !== TRANSFER || typeof log.address !== 'string') continue;
    const from = fromTopic(log.topics[1]), to = fromTopic(log.topics[2]), amount = raw(log.data), token = log.address.toLowerCase();
    if (amount === null || amount === 0n || from === to) continue;
    if (from === target) deltas.set(token, (deltas.get(token) ?? 0n) - amount);
    if (to === target) deltas.set(token, (deltas.get(token) ?? 0n) + amount);
  }
  return chooseSwap(deltas, quotes);
}

const solAmount = (balance: any) => {
  try {
    if (typeof balance?.uiTokenAmount?.amount !== 'string' || !Number.isInteger(balance.uiTokenAmount.decimals)) return null;
    return new Decimal(balance.uiTokenAmount.amount).div(new Decimal(10).pow(balance.uiTokenAmount.decimals));
  } catch { return null; }
};
export function solanaSwap(transaction: any, wallet: string): Omit<RawSwap, 'tokenRaw' | 'quoteRaw'> & { tokenAmount: string; quoteAmount: string } | null {
  const meta = transaction?.meta, message = transaction?.transaction?.message;
  if (!meta || meta.err || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return null;
  const deltas = new Map<string, Decimal>();
  const balances = new Map<string, { pre: Decimal; post: Decimal }>();
  for (const [side, rows] of [['pre', meta.preTokenBalances], ['post', meta.postTokenBalances]] as const) {
    for (const item of rows) {
      if (item?.owner !== wallet || typeof item.mint !== 'string') continue;
      const amount = solAmount(item); if (!amount) continue;
      const record = balances.get(item.mint) ?? { pre: new Decimal(0), post: new Decimal(0) };
      record[side] = record[side].plus(amount); balances.set(item.mint, record);
    }
  }
  for (const [mint, value] of balances) deltas.set(mint, value.post.minus(value.pre));
  const keys = Array.isArray(message?.accountKeys) ? message.accountKeys.map((item: any) => typeof item === 'string' ? item : item?.pubkey) : [];
  const index = keys.indexOf(wallet);
  if (index >= 0 && Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    let lamports = new Decimal(meta.postBalances[index] ?? 0).minus(meta.preBalances[index] ?? 0);
    if (index === 0 && Number.isFinite(meta.fee)) lamports = lamports.plus(meta.fee);
    if (!lamports.isZero()) deltas.set('native', lamports.div(1e9));
  }
  const quoteLegs = [...deltas].filter(([mint, amount]) => mint in SOL_QUOTES && !amount.isZero());
  const tokens = [...deltas].filter(([mint, amount]) => !(mint in SOL_QUOTES) && !amount.isZero());
  for (const [quote, quoteDelta] of quoteLegs) {
    const token = tokens.find(([, tokenDelta]) => (quoteDelta.isNegative() && tokenDelta.isPositive()) || (quoteDelta.isPositive() && tokenDelta.isNegative()));
    if (token) return { side: quoteDelta.isNegative() ? 'buy' : 'sell', token: token[0], tokenAmount: token[1].abs().toSignificantDigits(10).toFixed(), quote, quoteAmount: quoteDelta.abs().toSignificantDigits(10).toFixed() };
  }
  return null;
}

interface JsonRpc { result?: any; error?: { message?: string } }
export class WalletWatch {
  private stopped = false;
  private sockets = new Map<string, WebSocket>();
  private reconnects = new Map<string, NodeJS.Timeout>();
  private pending = new Set<string>();
  private solanaTimer?: NodeJS.Timeout;
  private robinhoodTimer?: NodeJS.Timeout;
  private solanaRunning = false;
  private robinhoodRunning = false;
  private rpcId = 0;
  constructor(private c: Config, private store: Store, private telegram: Telegram, private dex: DexScreener, private fetcher: typeof fetch = fetch) {}

  async start() {
    if (!this.c.walletWatchEnabled) return;
    if (this.c.chains.includes('solana')) {
      await this.pollSolana();
      this.solanaTimer = setInterval(() => void this.pollSolana(), 4000);
    }
    for (const chain of ['ethereum', 'bnb', 'base'] as const) if (this.c.chains.includes(chain)) this.connect(chain);
    if (this.c.chains.includes('robinhood')) {
      await this.pollRobinhood();
      this.robinhoodTimer = setInterval(() => void this.pollRobinhood(), 2500);
    }
  }
  stop() {
    this.stopped = true;
    if (this.solanaTimer) clearInterval(this.solanaTimer);
    if (this.robinhoodTimer) clearInterval(this.robinhoodTimer);
    for (const timer of this.reconnects.values()) clearTimeout(timer);
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
  }
  private async jsonRpc(url: string, method: string, params: unknown[]): Promise<any> {
    const response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const data = await response.json() as JsonRpc;
    if (data.error) throw new Error(String(data.error.message || 'RPC error').slice(0, 200));
    return data.result;
  }
  private connect(chain: 'ethereum' | 'bnb' | 'base') {
    const endpoint = RPC[chain].ws!;
    const socket = new WebSocket(endpoint, { handshakeTimeout: 15_000 });
    this.sockets.set(chain, socket);
    socket.on('open', () => {
      const addresses = watchedWallets.map(wallet => topic(wallet.evm));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { topics: [TRANSFER, addresses] }] }));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['logs', { topics: [TRANSFER, null, addresses] }] }));
      void this.store.health(`watch:${chain}`, 'healthy', `${watchedWallets.length} verified wallets subscribed for confirmed token transfers`);
    });
    socket.on('message', value => {
      try {
        const data = JSON.parse(String(value));
        const tx = data?.params?.result?.transactionHash;
        if (data?.method === 'eth_subscription' && typeof tx === 'string') this.queue(chain, tx);
      } catch { /* malformed provider frames are ignored */ }
    });
    socket.on('error', () => void this.store.health(`watch:${chain}`, 'degraded', 'Public chain subscription error; reconnecting').catch(() => undefined));
    socket.on('close', () => {
      this.sockets.delete(chain);
      if (this.stopped) return;
      void this.store.health(`watch:${chain}`, 'degraded', 'Public chain subscription disconnected; reconnecting').catch(() => undefined);
      const timer = setTimeout(() => { this.reconnects.delete(chain); this.connect(chain); }, 5000);
      this.reconnects.set(chain, timer);
    });
  }
  private queue(chain: Exclude<Chain, 'solana'>, tx: string) {
    const key = `${chain}:${tx.toLowerCase()}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    setTimeout(() => void this.processEvm(chain, tx).finally(() => this.pending.delete(key)), 900);
  }
  private async processEvm(chain: Exclude<Chain, 'solana'>, tx: string) {
    try {
      let receipt: any = null;
      for (let attempt = 0; attempt < 4 && !receipt; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 1200));
        receipt = await this.jsonRpc(RPC[chain].http, 'eth_getTransactionReceipt', [tx]);
      }
      if (!receipt) throw new Error('Receipt unavailable');
      for (const owner of watchedWallets) {
        const swap = evmSwap(receipt, owner.evm, EVM_QUOTES[chain]);
        if (!swap) continue;
        const tokenMeta = await deadline(this.evmTokenMeta(chain, swap.token), 750, { decimals: 18, symbol: null });
        const quoteMeta = EVM_QUOTES[chain][swap.quote];
        await this.deliver({
          id: createHash('sha256').update(`${owner.name}:${chain}:${tx}:${swap.token}:${swap.side}`).digest('hex'),
          trader: owner.name, wallet: owner.evm, chain, tx, at: Date.now(), side: swap.side,
          token: swap.token, tokenAmount: decimal(swap.tokenRaw, tokenMeta.decimals), tokenSymbol: tokenMeta.symbol,
          quoteSymbol: quoteMeta.symbol, quoteAmount: decimal(swap.quoteRaw, quoteMeta.decimals),
          quoteUsd: quoteMeta.stable ? Number(decimal(swap.quoteRaw, quoteMeta.decimals)) : null, chart: null,
        });
      }
      await this.store.health(`watch:${chain}`, 'healthy', `${watchedWallets.length} verified wallets subscribed; latest matching transaction checked`, Date.now());
    } catch {
      await this.store.health(`watch:${chain}`, 'degraded', 'Could not verify a matching transaction; live subscription remains connected').catch(() => undefined);
    }
  }
  private async evmTokenMeta(chain: Exclude<Chain, 'solana'>, token: string) {
    const endpoint = RPC[chain].http;
    try {
      const [decimalsData, symbolData] = await Promise.all([
        this.jsonRpc(endpoint, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']),
        this.jsonRpc(endpoint, 'eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']),
      ]);
      const decimals = Number(BigInt(decimalsData));
      return { decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18, symbol: decodeAbiString(symbolData) };
    } catch { return { decimals: 18, symbol: null }; }
  }
  private async deliver(trade: WalletTrade) {
    const markets = await deadline(this.dex.batch(trade.chain, [trade.token]), 750, new Map());
    const market = markets.get(trade.token)?.[0];
    if (market) { trade.tokenSymbol = market.symbol; trade.chart = market.chart; }
    await this.telegram.walletTrade(trade);
  }
  private async pollSolana() {
    if (this.solanaRunning || this.stopped) return;
    this.solanaRunning = true;
    try {
      for (const owner of watchedWallets) {
        const source = 'solana', old = await this.store.walletCursor(source, owner.solana);
        const options: Record<string, unknown> = { limit: 50, commitment: 'confirmed' };
        if (old) options.until = old;
        const signatures = await this.jsonRpc(SOLANA_RPC, 'getSignaturesForAddress', [owner.solana, options]);
        if (!Array.isArray(signatures)) throw new Error('Invalid Solana response');
        if (!old) {
          if (signatures[0]?.signature) await this.store.saveWalletCursor(source, owner.solana, signatures[0].signature);
          continue;
        }
        for (const item of [...signatures].reverse()) {
          if (item?.err || typeof item?.signature !== 'string') continue;
          const transaction = await this.jsonRpc(SOLANA_RPC, 'getTransaction', [item.signature, { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
          const swap = solanaSwap(transaction, owner.solana);
          if (!swap) continue;
          const quote = SOL_QUOTES[swap.quote];
          await this.deliver({
            id: createHash('sha256').update(`${owner.name}:solana:${item.signature}:${swap.token}:${swap.side}`).digest('hex'),
            trader: owner.name, wallet: owner.solana, chain: 'solana', tx: item.signature,
            at: Number(transaction?.blockTime) > 0 ? Number(transaction.blockTime) * 1000 : Date.now(), side: swap.side,
            token: swap.token, tokenAmount: swap.tokenAmount, tokenSymbol: null,
            quoteSymbol: quote.symbol, quoteAmount: swap.quoteAmount,
            quoteUsd: quote.stable ? Number(swap.quoteAmount) : null, chart: null,
          });
        }
        if (signatures[0]?.signature) await this.store.saveWalletCursor(source, owner.solana, signatures[0].signature);
      }
      await this.store.health('watch:solana', 'healthy', `${watchedWallets.length} verified wallets polled for confirmed swaps`, Date.now());
    } catch {
      await this.store.health('watch:solana', 'degraded', 'Public Solana RPC unavailable; retrying').catch(() => undefined);
    } finally { this.solanaRunning = false; }
  }
  private async pollRobinhood() {
    if (this.robinhoodRunning || this.stopped) return;
    this.robinhoodRunning = true;
    try {
      const endpoint = RPC.robinhood.http, latestHex = await this.jsonRpc(endpoint, 'eth_blockNumber', []), latest = Number(BigInt(latestHex));
      const old = await this.store.walletCursor('evm:robinhood', 'all');
      if (!old) { await this.store.saveWalletCursor('evm:robinhood', 'all', latestHex); return; }
      const previous = Number(BigInt(old));
      if (latest <= previous) return;
      const from = Math.max(previous + 1, latest - 499), addresses = watchedWallets.map(wallet => topic(wallet.evm));
      const filter = { fromBlock: `0x${from.toString(16)}`, toBlock: latestHex };
      const [outgoing, incoming] = await Promise.all([
        this.jsonRpc(endpoint, 'eth_getLogs', [{ ...filter, topics: [TRANSFER, addresses] }]),
        this.jsonRpc(endpoint, 'eth_getLogs', [{ ...filter, topics: [TRANSFER, null, addresses] }]),
      ]);
      const transactions = new Set<string>();
      for (const log of [...(Array.isArray(outgoing) ? outgoing : []), ...(Array.isArray(incoming) ? incoming : [])]) if (typeof log?.transactionHash === 'string') transactions.add(log.transactionHash);
      for (const tx of transactions) await this.processEvm('robinhood', tx);
      await this.store.saveWalletCursor('evm:robinhood', 'all', latestHex);
      await this.store.health('watch:robinhood', previous + 500 < latest ? 'degraded' : 'healthy', previous + 500 < latest ? 'Restart gap exceeded the public RPC lookback; live polling resumed' : `${watchedWallets.length} verified wallets polled for confirmed swaps`, Date.now());
    } catch {
      await this.store.health('watch:robinhood', 'degraded', 'Public Robinhood RPC unavailable; retrying').catch(() => undefined);
    } finally { this.robinhoodRunning = false; }
  }
}

export function decodeAbiString(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    const hex = value.slice(2);
    let bytes: Buffer;
    if (hex.length >= 128 && Number(BigInt(`0x${hex.slice(0, 64)}`)) === 32) {
      const length = Number(BigInt(`0x${hex.slice(64, 128)}`));
      bytes = Buffer.from(hex.slice(128, 128 + length * 2), 'hex');
    } else bytes = Buffer.from(hex.slice(0, 64), 'hex');
    const result = bytes.toString('utf8').replace(/\0+$/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return result ? result.slice(0, 30) : null;
  } catch { return null; }
}

export const walletExplorer = (chain: Chain, tx: string) => chain === 'solana' ? `https://solscan.io/tx/${tx}` : `${RPC[chain].explorer}${tx}`;
