import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const OWNER='creditcomebackclub';
const REPO='multi-chain-token-scanner';
const DATA_DIR=path.resolve('research/ml/data');
const META_PATH=path.join(DATA_DIR,'snapshot.meta.json');

export async function artifactSha256(file,compressed=true){
  const hash=createHash('sha256');
  const sink=new Writable({write(chunk,_encoding,done){hash.update(chunk);done();}});
  if(compressed)await pipeline(createReadStream(file),createGunzip(),sink);
  else await pipeline(createReadStream(file),sink);
  return hash.digest('hex');
}

export async function uncompressedSha256(file){return artifactSha256(file,true);}

export async function verifyArtifact(file,expected,compressed=true){
  try{return (await artifactSha256(file,compressed))===expected;}catch{return false;}
}

async function download(url,file){
  const response=await fetch(url,{signal:AbortSignal.timeout(10*60*1000)});
  if(!response.ok||!response.body)throw new Error(`Download failed: HTTP ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body),createWriteStream(file));
}

export async function fetchResearchData({metaPath=META_PATH,dataDir=DATA_DIR}={}){
  const meta=JSON.parse(await readFile(metaPath,'utf8'));
  const artifacts=meta.artifacts??[meta.paths,meta.exit_grid,meta.edge_exit_grid].filter(Boolean);
  await mkdir(dataDir,{recursive:true});
  for(const artifact of artifacts){
    if(artifact.file!==path.basename(artifact.file))throw new Error('Artifact filename must not contain a directory');
    const file=path.join(dataDir,artifact.file),expected=artifact.sha256??artifact.uncompressed_csv_sha256;
    const compressed=artifact.gzip??true;
    if(!/^[a-f0-9]{64}$/.test(expected??''))throw new Error(`Missing SHA-256 for ${artifact.file}`);
    if(await verifyArtifact(file,expected,compressed)){console.log(`${artifact.file}: verified`);continue;}
    const tag=artifact.release;
    if(!tag)throw new Error(`Missing release tag for ${artifact.file} in ${metaPath}`);
    const partial=`${file}.part`;
    await rm(partial,{force:true});
    const url=`https://github.com/${OWNER}/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(artifact.file)}`;
    console.log(`${artifact.file}: downloading ${tag}`);
    try{
      await download(url,partial);
      if(!await verifyArtifact(partial,expected,compressed))throw new Error(`${artifact.file}: SHA-256 mismatch after download`);
      await rename(partial,file);
      console.log(`${artifact.file}: verified`);
    }catch(error){await rm(partial,{force:true});throw error;}
  }
}

if(import.meta.url===new URL(process.argv[1],`file://${process.cwd()}/`).href){
  const options=process.argv.includes('--confirmation')?{
    metaPath:path.resolve('research/ml/reports/strategy-discovery-v1/confirmation-artifact.json'),
    dataDir:path.join(DATA_DIR,'strategy-discovery-v1'),
  }:{};
  fetchResearchData(options).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
}
