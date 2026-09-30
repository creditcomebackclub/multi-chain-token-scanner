import { rules, address, type Chain } from './config.js';
import type { Security } from './types.js';
export const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export function number(v: unknown): number | null {
  if ((typeof v !== 'number' && typeof v !== 'string') || v === '' || (typeof v === 'string' && !v.trim())) return null;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null;
}
const flag = (v: unknown) => v === '0' || v === 0 || v === false ? false : v === '1' || v === 1 || v === true ? true : null;
export const unknownSecurity = (now: number, reason: string): Security => ({ status: 'UNKNOWN', reasons: [reason], checkedAt: now, buyTax: null, sellTax: null, raw: null });

// Launchpad lockers and standard upgradeable infrastructure often surface as
// concentration/proxy findings. Treat these as explicit chart-alert warnings;
// all execution controls, malicious-creator findings, taxes, and material
// evidence gaps remain blockers.
const chartWarnings = new Set([
  'Dangerous holder concentration',
  'is_proxy',
  'Unknown: creator',
  'Unknown: Top-ten holder concentration',
  'Unknown: Holder percentage',
]);
export interface ChartSecurityGate { allowed: boolean; warnings: string[]; blockers: string[] }
export function chartSecurityGate(security: Pick<Security, 'status'|'reasons'>): ChartSecurityGate {
  if (security.status === 'PASS') return { allowed: true, warnings: [], blockers: [] };
  const warnings: string[] = [], blockers: string[] = [];
  for (const reason of security.reasons) (chartWarnings.has(reason) ? warnings : blockers).push(reason);
  if (!security.reasons.length) blockers.push('Incomplete security evidence');
  return { allowed: blockers.length === 0 && warnings.length > 0, warnings, blockers };
}
export function checkSecurity(chain: Chain, token: string, payload: unknown, now: number, exactPool?: string): Security {
  const body = object(payload), entries = object(body.result);
  const entry = Object.entries(entries).find(([a]) => { try { return address(chain, a) === address(chain, token); } catch { return false; } });
  if (number(body.code) !== 1 || !entry) return unknownSecurity(now, 'Security response unavailable or token missing');
  const data = object(entry[1]), risky: string[] = [], missing: string[] = [];
  const requireFalse = (name: string, value: unknown) => {
    const f = flag(value);
    if (f === true) risky.push(name);
    else if (f === null) missing.push(name);
  };
  const tax = (name: string, value: unknown, divisor = 1) => {
    const n = number(value);
    if (n === null) missing.push(name);
    else if (n / divisor > rules.maxTax) risky.push(name);
    return n === null ? null : n / divisor;
  };
  // Inspect nested authority/creator entries, including metadata authorities.
  const malicious = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(malicious); return; }
    for (const [k, value] of Object.entries(object(v))) {
      if (k === 'malicious_address' && flag(value) === true) risky.push('Malicious authority or creator');
      if (value && typeof value === 'object') malicious(value);
    }
  };
  malicious(data);
  let buyTax: number | null = null, sellTax: number | null = null;
  if (chain === 'solana') {
    for (const k of ['mintable', 'freezable', 'closable', 'transfer_fee_upgradable', 'default_account_state_upgradable', 'balance_mutable_authority', 'transfer_hook_upgradable']) requireFalse(k, object(data[k]).status);
    requireFalse('non_transferable', data.non_transferable);
    const state = number(data.default_account_state);
    if (state === null) missing.push('default_account_state');
    else if (state !== 1) risky.push('Accounts not transferable');
    // Current responses use `creators`; retain support for the legacy singular field.
    // Inspect both when present so one field cannot conceal a risk in the other.
    const creatorFields = [data.creators, data.creator].filter(value => value !== undefined);
    const creators = creatorFields.flatMap(value => Array.isArray(value) ? value : []);
    if (!creators.length || creatorFields.some(value => !Array.isArray(value))) missing.push('creator');
    for (const c of creators) requireFalse('creator.malicious_address', object(c).malicious_address);
    if (!data.transfer_hook || typeof data.transfer_hook !== 'object') missing.push('transfer_hook');
    else if (Array.isArray(data.transfer_hook) ? data.transfer_hook.length > 0 : Object.keys(object(data.transfer_hook)).length > 0) risky.push('Transfer hook can block selling');
    if (!data.transfer_fee || typeof data.transfer_fee !== 'object' || Array.isArray(data.transfer_fee)) missing.push('transfer_fee');
    else {
      const fee = object(data.transfer_fee);
      if (!Object.keys(fee).length) buyTax = sellTax = 0;
      else {
        buyTax = sellTax = tax('transfer_fee.current', object(fee.current_fee_rate).fee_rate, 10_000);
        if (fee.scheduled_fee_rate) tax('transfer_fee.scheduled', object(fee.scheduled_fee_rate).fee_rate, 10_000);
      }
    }
  } else {
    if (flag(data.is_open_source) !== true) missing.push('Verified contract source');
    const creatorShare = number(data.creator_percent);
    if (creatorShare !== null && creatorShare > rules.maxHolderShare) risky.push('Dangerous creator concentration');
    for (const k of ['is_honeypot', 'cannot_buy', 'cannot_sell_all', 'is_proxy', 'is_mintable', 'can_take_back_ownership', 'owner_change_balance', 'hidden_owner', 'selfdestruct', 'external_call', 'is_blacklisted', 'is_whitelisted', 'slippage_modifiable', 'personal_slippage_modifiable', 'transfer_pausable']) requireFalse(k, data[k]);
    for (const k of ['honeypot_with_same_creator', 'fake_token', 'malicious_address']) {
      const nested = object(data[k]);
      if (flag(Object.keys(nested).length ? nested.value ?? nested.status : data[k]) === true) risky.push(k);
    }
    // GoPlus added authenticated B20 risk details in August 2026. They are
    // optional on ordinary/public responses, but must be enforced when present.
    const b20 = object(data.b20_token), b20Flag = flag(b20.is_b20);
    if (Object.keys(b20).length && b20Flag === null) missing.push('B20 classification');
    if (b20Flag === true) {
      const info = object(b20.b20_info);
      for (const k of ['mintable','transfer_pausable','owner_change_balance','metadata_modifiable','blacklist','whitelist','cannot_sell','cannot_buy']) {
        requireFalse(`B20 ${k}`, object(info[k]).status);
      }
    }
    // GoPlus token response does not guarantee malicious-deployer coverage.
    // The adapter supplies a separate address-security response for the creator.
    const creator = object(body.creatorSecurity);
    if (number(creator.code) !== 1 || !Object.keys(object(creator.result)).length) missing.push('Creator address security');
    else {
      const result = object(creator.result);
      for (const k of ['honeypot_related_address', 'phishing_activities', 'blackmail_activities', 'stealing_attack', 'fake_kyc', 'malicious_mining_activities', 'darkweb_transactions', 'cybercrime', 'money_laundering', 'financial_crime', 'blacklist_doubt', 'gas_abuse', 'reinit', 'fake_standard_interface', 'fake_token']) requireFalse(`Creator ${k}`, result[k]);
      if ((number(result.number_of_malicious_contracts_created) ?? 0) > 0) risky.push('Creator deployed malicious contracts');
    }
    buyTax = tax('buy_tax', data.buy_tax); sellTax = tax('sell_tax', data.sell_tax);
    // Pool fees vary by pair. Only use the fee for the exact pool confirmed by
    // DEX Screener; applying another pool's fee would create a false rejection.
    const pool = exactPool?.toLowerCase();
    const dex = Array.isArray(data.dex) ? data.dex.map(object).find(row => typeof row.pair === 'string' && row.pair.toLowerCase() === pool) : undefined;
    const poolFee = number(dex?.pool_fee);
    if (poolFee !== null) {
      if (buyTax !== null) buyTax += poolFee;
      if (sellTax !== null) sellTax += poolFee;
      if ((buyTax ?? 0) > rules.maxTax) risky.push('buy_tax + pool_fee');
      if ((sellTax ?? 0) > rules.maxTax) risky.push('sell_tax + pool_fee');
    }
  }
  if (!Array.isArray(data.holders) || data.holders.length < 10) missing.push('Top-ten holder concentration');
  else {
    const shares: number[] = [];
    for (const h of data.holders) {
      const holder = object(h), holderAddress = typeof holder.address === 'string' ? holder.address.toLowerCase() : '';
      // The exact EVM pair and provable burn addresses cannot dump their token
      // balance as an ordinary holder. Do not count them as insider whales.
      const exempt = chain !== 'solana' && (holderAddress === exactPool?.toLowerCase()
        || /^0x0{40}$/.test(holderAddress) || /^0x0{36}dead$/.test(holderAddress));
      if (exempt) continue;
      const n = number(holder.percent);
      if (n === null || n > 1) missing.push('Holder percentage');
      else shares.push(n);
    }
    // Conservative: pool/locker tags are not sufficient proof to exempt a holder.
    shares.sort((a, b) => b - a);
    if ((shares[0] || 0) > rules.maxHolderShare || shares.slice(0, 10).reduce((a, b) => a + b, 0) > rules.maxTopTenHolderShare) risky.push('Dangerous holder concentration');
  }
  return { status: risky.length ? 'REJECT' : missing.length ? 'UNKNOWN' : 'PASS',
    reasons: [...new Set([...risky, ...missing.map(s => `Unknown: ${s}`)])], checkedAt: now, buyTax, sellTax, raw: payload };
}
