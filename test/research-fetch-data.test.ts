import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGzip, gzipSync } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { uncompressedSha256, verifyArtifact, fetchResearchData } from '../scripts/fetch-research-data.mjs';

test('research artifact verification hashes decompressed CSV content',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'research-data-')),file=path.join(dir,'paths.csv.gz');
  const content='id,bar_index\na,0\n';
  await pipeline(Readable.from([content]),createGzip(),createWriteStream(file));
  const hash=await uncompressedSha256(file);
  assert.match(hash,/^[a-f0-9]{64}$/);
  assert.equal(await verifyArtifact(file,hash),true);
  assert.equal(await verifyArtifact(file,'0'.repeat(64)),false);
  await writeFile(file,'not gzip');
  assert.equal(await verifyArtifact(file,hash),false);
});

test('confirmation download verifies raw and gzip hashes and reuses verified data after restart',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'confirmation-data-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const content='id,at\na,2026-10-03\n',hash=createHash('sha256').update(content).digest('hex');
  const metaPath=path.join(dir,'manifest.json');
  await writeFile(metaPath,JSON.stringify({artifacts:[
    {file:'snapshot.csv',release:'frozen-test',sha256:hash,gzip:false},
    {file:'paths.csv.gz',release:'frozen-test',sha256:hash,gzip:true},
  ]}));
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url:string)=>{
    calls++;
    assert.match(String(url),/releases\/download\/frozen-test\//);
    return new Response(String(url).endsWith('.gz')?gzipSync(content):content);
  });
  await fetchResearchData({metaPath,dataDir:dir});
  assert.equal(await readFile(path.join(dir,'snapshot.csv'),'utf8'),content);
  assert.equal(await verifyArtifact(path.join(dir,'paths.csv.gz'),hash),true);
  await fetchResearchData({metaPath,dataDir:dir});
  assert.equal(calls,2);
});

test('confirmation download rejects mismatched data without replacing a cached file',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'confirmation-data-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const metaPath=path.join(dir,'manifest.json'),file=path.join(dir,'snapshot.csv');
  await writeFile(file,'old invalid cache');
  await writeFile(metaPath,JSON.stringify({artifacts:[{file:'snapshot.csv',release:'frozen-test',sha256:'0'.repeat(64),gzip:false}]}));
  t.mock.method(globalThis,'fetch',async()=>new Response('wrong contents'));
  await assert.rejects(fetchResearchData({metaPath,dataDir:dir}),/SHA-256 mismatch/);
  assert.equal(await readFile(file,'utf8'),'old invalid cache');
  await assert.rejects(access(`${file}.part`));
});
