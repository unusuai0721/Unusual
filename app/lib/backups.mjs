import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppPaths} from './paths.mjs';
import {Store} from './store.mjs';
import {validateConfig} from './config.mjs';
const ID=/^snapshot-\d{13}-[a-f0-9]{8}$/;
const TARGETS=['config.json','history.sqlite','emoji','audio'];
const hash=file=>{const digest=createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(65536);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,n));return digest.digest('hex');}finally{fs.closeSync(fd);}};
export class DataBackups{
 constructor(store){this.store=store;this.paths=store.paths;this.paths.ensureDir('backups/data');}
 location(id){if(!ID.test(String(id)))throw Error('备份编号无效');return 'backups/data/'+id;}
 list(){return fs.readdirSync(this.paths.resolve('backups/data')).filter(id=>ID.test(id)).flatMap(id=>{try{const m=JSON.parse(fs.readFileSync(this.paths.resolve(this.location(id)+'/manifest.json'),'utf8'));return [{id,createdAt:m.createdAt,version:m.version,bytes:m.bytes,files:m.files.length,reason:m.reason}];}catch{return [];}}).sort((a,b)=>b.id.localeCompare(a.id));}
 create(reason='manual'){
  const id='snapshot-'+Date.now()+'-'+randomUUID().slice(0,8),rel=this.location(id);this.paths.ensureDir(rel);
  const files=[];let bytes=0;
  const add=name=>{const file=this.paths.resolve(rel+'/'+name);const size=fs.statSync(file).size;bytes+=size;if(bytes>2*1024**3)throw Error('备份超过 2 GB，请先整理生成音频');files.push({name,bytes:size,sha256:hash(file)});};
  try{
   this.paths.writeJson(rel+'/config.json',this.store.config);add('config.json');
   this.store.prepare('VACUUM INTO ?').run(this.paths.resolve(rel+'/history.sqlite'));add('history.sqlite');
   for(const kind of ['emoji','audio']){
    this.paths.ensureDir(rel+'/'+kind);
    for(const name of fs.readdirSync(this.paths.resolve('data/'+kind))){
     const source=this.paths.mediaPath(kind,name);if(!fs.statSync(source).isFile())throw Error('媒体目录包含非文件项，备份已停止');
     fs.copyFileSync(source,this.paths.resolve(rel+'/'+kind+'/'+name));add(kind+'/'+name);
    }
   }
   let version='unknown';try{version=JSON.parse(fs.readFileSync(this.paths.resolve('package.json'),'utf8')).version;}catch{}
   const manifest={format:1,id,version,createdAt:new Date().toISOString(),reason,bytes,files};this.paths.writeJson(rel+'/manifest.json',manifest);return {id,createdAt:manifest.createdAt,bytes,files:files.length};
  }catch(e){fs.rmSync(this.paths.resolve(rel),{recursive:true,force:true});throw e;}
 }
 verify(id){
  const rel=this.location(id),manifestPath=this.paths.resolve(rel+'/manifest.json');const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(m.format!==1||m.id!==id||!Array.isArray(m.files)||m.files.length>30000)throw Error('备份格式不兼容');
  const seen=new Set();let bytes=0;
  for(const f of m.files){
   if(typeof f.name!=='string'||seen.has(f.name))throw Error('备份包含重复或无效文件');seen.add(f.name);
   if(!['config.json','history.sqlite'].includes(f.name)){const parts=f.name.split('/');if(parts.length!==2)throw Error('备份路径无效');this.paths.mediaPath(parts[0],parts[1]);}
   const file=this.paths.resolve(rel+'/'+f.name);const stat=fs.statSync(file);bytes+=stat.size;
   if(!stat.isFile()||stat.size!==f.bytes||bytes>2*1024**3||hash(file)!==f.sha256)throw Error('备份文件损坏或被修改：'+f.name);
  }
  if(!seen.has('config.json')||!seen.has('history.sqlite'))throw Error('备份缺少配置或数据库');
  const config=validateConfig(JSON.parse(fs.readFileSync(this.paths.resolve(rel+'/config.json'),'utf8')));
  const db=new DatabaseSync(this.paths.resolve(rel+'/history.sqlite'),{readOnly:true});
  try{if(Object.values(db.prepare('PRAGMA quick_check').get())[0]!=='ok')throw Error('数据库完整性检查失败');for(const table of ['messages','meta','usage','logs'])db.prepare('SELECT COUNT(*) FROM '+table).get();}finally{db.close();}
  return {manifest:m,config,digest:hash(manifestPath)};
 }
 schedule(id){const checked=this.verify(id);this.paths.writeJson('data/restore-pending.json',{id,digest:checked.digest,at:new Date().toISOString()});return {ok:true,restartRequired:true,id,version:checked.manifest.version};}
 cancel(){fs.rmSync(this.paths.resolve('data/restore-pending.json'),{force:true});return {ok:true};}
 status(){const read=name=>{try{return JSON.parse(fs.readFileSync(this.paths.resolve('data/'+name),'utf8'));}catch{return null;}};return {pending:read('restore-pending.json'),last:read('restore-result.json')};}
}
// Only called before opening the application's database. A journal makes an
// interrupted replacement revert to the pre-restore files on the next startup.
export function applyPendingRestore(root){
 const paths=new AppPaths(root),journalFile=paths.resolve('data/restore-journal.json');
 const rollback=journal=>{
  if(!ID.test(journal.id)||!Array.isArray(journal.steps)||journal.steps.some(s=>!TARGETS.includes(s.name)))throw Error('恢复日志无效，未修改数据');
  for(const step of [...journal.steps].reverse()){
   const original=paths.resolve('data/'+step.name),saved=paths.resolve('backups/restore-work/'+journal.id+'/old/'+step.name);
   if(fs.existsSync(saved)){fs.rmSync(original,{recursive:true,force:true});fs.renameSync(saved,original);}
   else if(!step.existed)fs.rmSync(original,{recursive:true,force:true});
  }
  fs.rmSync(journalFile,{force:true});fs.rmSync(paths.resolve('data/restore-pending.json'),{force:true});
  paths.writeJson('data/restore-result.json',{ok:false,at:new Date().toISOString(),detail:'上次恢复未完成，已退回恢复前的数据'});
 };
 const pendingFile=paths.resolve('data/restore-pending.json');if(!fs.existsSync(pendingFile)&&!fs.existsSync(journalFile))return;
 // A second process must not replace an active database.
 let runtime;try{runtime=JSON.parse(fs.readFileSync(paths.resolve('data/runtime.json'),'utf8'));}catch{}
 if(runtime?.pid&&runtime.pid!==process.pid){let live=false;try{process.kill(runtime.pid,0);live=true;}catch{}if(live)throw Error('另一个软件进程仍在运行，不能恢复数据');}
 if(fs.existsSync(journalFile)){rollback(JSON.parse(fs.readFileSync(journalFile,'utf8')));return;}
 const pending=JSON.parse(fs.readFileSync(pendingFile,'utf8'));
 const store=new Store(root);let checked,safety;
 try{const manager=new DataBackups(store);checked=manager.verify(pending.id);if(checked.digest!==pending.digest)throw Error('备份清单在确认后发生变化，已取消恢复');safety=manager.create('before-restore');}catch{fs.rmSync(pendingFile,{force:true});paths.writeJson('data/restore-result.json',{ok:false,at:new Date().toISOString(),detail:'恢复校验或恢复前备份失败，已保留现有数据；请检查备份与磁盘空间后重试'});return;}finally{store.close();}
 const workId='snapshot-'+Date.now()+'-'+randomUUID().slice(0,8);const work='backups/restore-work/'+workId;paths.ensureDir(work+'/new');paths.ensureDir(work+'/old');
 if(fs.readdirSync(paths.resolve(work+'/old')).length)throw Error('恢复工作目录已有旧数据，请先核对');
 const journal={id:workId,safetyBackup:safety.id,steps:[]};
 try{
  for(const kind of ['emoji','audio'])paths.ensureDir(work+'/new/'+kind);
  for(const file of checked.manifest.files)fs.copyFileSync(paths.resolve('backups/data/'+pending.id+'/'+file.name),paths.resolve(work+'/new/'+file.name));
  const config={...checked.config,bot:{...checked.config.bot,enabled:false},official:{...checked.config.official,enabled:false}};
  paths.writeJson(work+'/new/config.json',config);
  // Closed connection has checkpointed WAL; preserve any sidecar just in case.
  for(const suffix of ['-wal','-shm','-journal']){const file=paths.resolve('data/history.sqlite'+suffix);if(fs.existsSync(file))fs.renameSync(file,paths.resolve(work+'/old/history.sqlite'+suffix));}
  for(const name of TARGETS){const target=paths.resolve('data/'+name);journal.steps.push({name,existed:fs.existsSync(target)});paths.writeJson('data/restore-journal.json',journal);if(fs.existsSync(target))fs.renameSync(target,paths.resolve(work+'/old/'+name));fs.renameSync(paths.resolve(work+'/new/'+name),target);}
  fs.rmSync(pendingFile,{force:true});fs.rmSync(journalFile,{force:true});
  paths.writeJson('data/restore-result.json',{ok:true,id:pending.id,safetyBackup:safety.id,at:new Date().toISOString(),detail:'已恢复配置、聊天记录、人设记忆和媒体；自动聊天已暂停，请检查后开启'});
 }catch(e){if(fs.existsSync(journalFile))rollback(journal);else{fs.rmSync(pendingFile,{force:true});paths.writeJson('data/restore-result.json',{ok:false,at:new Date().toISOString(),detail:'恢复准备失败，现有数据未替换；请检查磁盘空间'});}}
}
