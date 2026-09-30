import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSecurity } from '../src/security.js';
import { fixture, SOL } from './helpers.js';
test('Solana accepts current creators schema with the same risk requirements as legacy creator',()=>{
 const p=fixture('goplus-solana'),d=p.result[SOL];
 assert.ok(d); d.creators=d.creator;delete d.creator;
 assert.equal(checkSecurity('solana',SOL,p,Date.now()).status,'PASS');
 d.creators[0].malicious_address='1';
 assert.equal(checkSecurity('solana',SOL,p,Date.now()).status,'REJECT');
});
test('empty, malformed or incomplete Solana creator evidence remains unknown',()=>{
 for(const creators of [[],null,{},[{}]]) {
  const p=fixture('goplus-solana'),d=p.result[SOL];delete d.creator;d.creators=creators;
  assert.equal(checkSecurity('solana',SOL,p,Date.now()).status,'UNKNOWN');
 }
});
test('legacy creator risks are not hidden by the current field',()=>{
 const p=fixture('goplus-solana'),d=p.result[SOL];
 d.creators=structuredClone(d.creator);d.creator[0].malicious_address='1';
 assert.equal(checkSecurity('solana',SOL,p,Date.now()).status,'REJECT');
});
