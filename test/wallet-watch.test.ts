import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { renderWalletTrade } from '../src/telegram.js';
import type { WalletTrade } from '../src/types.js';
import { EVM_QUOTES, evmSwap, solanaSwap } from '../src/wallet-watch.js';
import { testStore } from './helpers.js';

const WALLET = '0x696d1265c8fc4f14797abebfae3c43ebfa9d8e28';
const TOKEN = '0x1111111111111111111111111111111111111111';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const addressTopic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const amount = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
const log = (token: string, from: string, to: string, value: bigint) => ({ address: token, topics: [transfer, addressTopic(from), addressTopic(to)], data: amount(value) });

test('EVM wallet classification requires paired quote and token movements', () => {
  const airdrop = { status: '0x1', logs: [log(TOKEN, '0x2222222222222222222222222222222222222222', WALLET, 1000n)] };
  assert.equal(evmSwap(airdrop, WALLET, EVM_QUOTES.ethereum), null);
  const buy = { status: '0x1', logs: [
    log(USDC, WALLET, '0x3333333333333333333333333333333333333333', 25_000_000n),
    log(TOKEN, '0x3333333333333333333333333333333333333333', WALLET, 500_000_000_000_000_000_000n),
  ] };
  assert.deepEqual(evmSwap(buy, WALLET, EVM_QUOTES.ethereum), { side: 'buy', token: TOKEN, tokenRaw: 500_000_000_000_000_000_000n, quote: USDC, quoteRaw: 25_000_000n });
});

test('Solana wallet classification requires a paired balance exchange', () => {
  const owner = '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ';
  const mint = 'ANM35KbUcfKdEVBXzSjZBoT6ceSwYRs3fuc79fp7kRqP';
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const balance = (token: string, raw: string, decimals: number) => ({ owner, mint: token, uiTokenAmount: { amount: raw, decimals } });
  const transaction = { meta: {
    err: null, fee: 5000, preBalances: [1_000_000_000], postBalances: [999_995_000],
    preTokenBalances: [balance(usdc, '100000000', 6)],
    postTokenBalances: [balance(usdc, '90000000', 6), balance(mint, '1000000000', 6)],
  }, transaction: { message: { accountKeys: [{ pubkey: owner }] } } };
  assert.deepEqual(solanaSwap(transaction, owner), { side: 'buy', token: mint, tokenAmount: '1000', quote: usdc, quoteAmount: '10' });
  transaction.meta.preTokenBalances = [];
  assert.equal(solanaSwap(transaction, owner), null);
});

const trade = (): WalletTrade => ({
  id: 'wallet-event', trader: 'Rowdy', wallet: WALLET, chain: 'ethereum', tx: `0x${'a'.repeat(64)}`,
  at: Date.now(), side: 'buy', token: TOKEN, tokenAmount: '500', tokenSymbol: 'MEME',
  quoteSymbol: 'USDC', quoteAmount: '25', quoteUsd: 25, chart: 'https://dexscreener.com/ethereum/pair',
});

test('wallet alert reservations validate the chat, honor pause, and deduplicate', async () => {
  const store = await testStore();
  try {
    assert.equal(await store.reserveWalletTrade(trade(), { enabled: true, chatKey: 'chat' }), null);
    await store.validateChat('chat');
    assert.equal(await store.reserveWalletTrade(trade(), { enabled: false, chatKey: 'chat' }), null);
    const id = await store.reserveWalletTrade(trade(), { enabled: true, chatKey: 'chat' });
    assert.equal(id, 'wallet-event'); assert.equal(await store.beginWalletSend(id!), true);
    await store.finishWalletAlert(id!, 'sent', 7);
    assert.equal(await store.reserveWalletTrade(trade(), { enabled: true, chatKey: 'chat' }), null);
    await store.pause(true);
    assert.equal(await store.reserveWalletTrade({ ...trade(), id: 'other', tx: `0x${'b'.repeat(64)}` }, { enabled: true, chatKey: 'chat' }), null);
  } finally { await store.db.close(); }
});

test('wallet alert renders a direct proof link and explains transfer filtering', () => {
  const message = renderWalletTrade({ ...trade(), trader: 'Rowdy & Co' }, config({ WALLET_WATCH_ENABLED: 'true' }));
  assert.match(message, /ROWDY &amp; CO BOUGHT/);
  assert.match(message, /etherscan\.io\/tx/);
  assert.match(message, /Airdrops and one-way transfers are ignored/);
  assert.match(message, new RegExp(`<code>${TOKEN}</code>`));
});
