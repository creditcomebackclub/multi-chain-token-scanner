import assert from 'node:assert/strict';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { uncompressedSha256, verifyArtifact } from '../scripts/fetch-research-data.mjs';

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
