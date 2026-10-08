import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvLine, replayObservation, BAR } from '../scripts/replay-strategy-discovery.mjs';

const at=Date.UTC(2026,0,1);
const row={id:'x',chain:'solana',token:'t',detected_at:at,atr14:1};
const candle=(offset:number,open=100,high=101,low=99,close=100)=>({at:at+offset*BAR,open,high,low,close,volume:100});

test('delayed replay uses the exact delayed open and never the pre-delay target',()=>{
  const results=replayObservation(row,[candle(0,100,120,99,115),candle(1,115,120,113,117)]);
  const fast=results.find(r=>r.exit==='scalp'&&r.delay_bars===0)!;
  const delayed=results.find(r=>r.exit==='scalp'&&r.delay_bars===1)!;
  assert.equal(fast.resolved,true);assert.equal(fast.gross_return_pct,10);
  assert.equal(delayed.entry_price,115);assert.equal(delayed.resolved,false);
});
test('missing entry is not replaced by a later bar',()=>{
  const results=replayObservation(row,[candle(2,100,120,99,115)]);
  assert.ok(results.every(r=>!r.resolved&&r.exit_reason==='missing_entry'));
});
test('a gap censors an unclosed path instead of granting a later target',()=>{
  const result=replayObservation(row,[candle(0),candle(2,100,120,99,110)]).find(r=>r.exit==='scalp'&&r.delay_bars===0)!;
  assert.equal(result.contiguous_bars,1);assert.equal(result.resolved,false);assert.equal(result.net_return_pct,null);
});
test('same-bar target and stop conflict loses and gap-down stop fills at worse open',()=>{
  const conflict=replayObservation(row,[candle(0,100,120,90,100)]).find(r=>r.exit==='scalp'&&r.delay_bars===0)!;
  assert.equal(conflict.exit_reason,'stop');assert.ok(Math.abs(conflict.net_return_pct+5)<1e-9);
  const gap=replayObservation(row,[candle(0),candle(1,90,91,89,90)]).find(r=>r.exit==='scalp'&&r.delay_bars===0)!;
  assert.ok(Math.abs(gap.net_return_pct+12)<1e-9);
});
test('CSV parser preserves quoted identity fields',()=>assert.deepEqual(parseCsvLine('a,"b,c","d""e"'),['a','b,c','d"e']));
