// Owner-local backup only. Never publish these files as research release assets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory=path.resolve('outputs/private-backups');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const filename=path.join(directory,`postgres-${stamp}.dump`);
const script=`set -e
backup_file=$(mktemp /tmp/scanner-recovery-backup.XXXXXX)
trap 'rm -f "$backup_file"' EXIT
export PGHOST=/var/run/postgresql
export PGPASSWORD="$POSTGRES_PASSWORD"
pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --file="$backup_file"
# Fully read/decompress the archive without restoring into production.
pg_restore --file=/dev/null "$backup_file"
printf '\\nSCANNER_BACKUP_START\\n'
base64 "$backup_file"
printf '\\nSCANNER_BACKUP_END\\n'
`;
try{
  await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  const stdout=execFileSync('npx',['--yes','@railway/cli','ssh','--project','39f52a77-9538-44fd-bac9-11829d6511c0',
    '--environment','production','--service','Postgres','--','bash'],
    {input:script,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:180_000,maxBuffer:256*1024*1024});
  const match=stdout.match(/SCANNER_BACKUP_START\r?\n([\s\S]*?)\r?\nSCANNER_BACKUP_END/);
  if(!match)throw new Error('Backup transport did not finish');
  const encoded=match[1].replace(/\s/g,'');
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error('Invalid backup transport');
  const data=Buffer.from(encoded,'base64');
  if(data.subarray(0,5).toString()!=='PGDMP')throw new Error('Invalid backup header');
  await writeFile(filename,data,{mode:0o600,flag:'wx'});
  const meta={created_at:stamp,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),
    verification:'PostgreSQL pg_restore fully read the custom archive to /dev/null before transfer; no restore or production mutation performed.'};
  await writeFile(`${filename}.meta.json`,JSON.stringify(meta,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({file:filename,...meta}));
}catch{console.error('Private database backup failed; credentials and database output suppressed.');process.exitCode=1;}
