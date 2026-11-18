import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {Store} from '../app/lib/store.mjs';import {DataBackups,applyPendingRestore} from '../app/lib/backups.mjs';
const base=path.resolve('tests/.tmp');fs.mkdirSync(base,{recursive:true});
function fixture(t){const root=fs.mkdtempSync(path.join(base,'backup-'));let store=new Store(root);fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'0.6.0'}));t.after(()=>{try{store.close();}catch{}assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});return {root,get store(){return store},reopen(){store=new Store(root);return store}};}
test('backup preserves messages, learning, config and media then restores offline with safety snapshot',t=>{
 const f=fixture(t),b=new DataBackups(f.store);f.store.addMessage({groupId:'123',content:'原始聊天'});f.store.setMeta('persona:learning:default',{text:'可爱'});fs.writeFileSync(path.join(f.root,'data/emoji/test.png'),Buffer.from('fixture image'));
 const snap=b.create();assert.equal(b.verify(snap.id).manifest.format,1);
 f.store.addMessage({groupId:'123',content:'后来聊天'});fs.writeFileSync(path.join(f.root,'data/emoji/new.png'),'later');b.schedule(snap.id);f.store.close();applyPendingRestore(f.root);f.reopen();
 assert.equal(f.store.messages().total,1);assert.equal(f.store.config.bot.enabled,false);assert.equal(f.store.getMeta('persona:learning:default').text,'可爱');assert.ok(!fs.existsSync(path.join(f.root,'data/emoji/new.png')));
 const result=new DataBackups(f.store).status();assert.equal(result.last.ok,true);assert.ok(new DataBackups(f.store).list().some(x=>x.reason==='before-restore'));
});
test('modified backup is rejected and does not replace current data',t=>{
 const f=fixture(t),b=new DataBackups(f.store);const snap=b.create();fs.appendFileSync(path.join(f.root,'backups/data',snap.id,'config.json'),' ');assert.throws(()=>b.schedule(snap.id),/损坏|修改/);assert.equal(b.status().pending,null);
});
test('backup rejects traversal IDs and can cancel a scheduled restore',t=>{
 const f=fixture(t),b=new DataBackups(f.store);assert.throws(()=>b.verify('../outside'),/编号/);const snap=b.create();b.schedule(snap.id);assert.equal(b.status().pending.id,snap.id);b.cancel();assert.equal(b.status().pending,null);
});
test('interrupted file replacement rolls back at next startup',t=>{
 const f=fixture(t),b=new DataBackups(f.store);const snap=b.create();f.store.close();const work=path.join(f.root,'backups/restore-work',snap.id,'old');fs.mkdirSync(work,{recursive:true});fs.renameSync(path.join(f.root,'data/config.json'),path.join(work,'config.json'));fs.writeFileSync(path.join(f.root,'data/config.json'),'broken');fs.writeFileSync(path.join(f.root,'data/restore-journal.json'),JSON.stringify({id:snap.id,steps:[{name:'config.json',existed:true}]}));
 applyPendingRestore(f.root);f.reopen();assert.deepEqual(f.store.config.personas,[]);assert.equal(new DataBackups(f.store).status().last.ok,false);
});
test('diagnostic stages are message-scoped, ordered and redact configured secrets',t=>{
 const f=fixture(t);let c=f.store.config;c.providers[0].apiKey='secret-value-should-not-leak';f.store.saveConfig(c);f.store.recordTrace('123','1','received','ok');f.store.recordTrace('123','1','failed',c.providers[0].apiKey);f.store.recordTrace('456','1','sent','other');
 const trace=f.store.messageTrace('123','1');assert.equal(trace.length,2);assert.equal(trace[1].detail,'[已隐藏]');assert.deepEqual(trace.map(x=>x.stage),['received','failed']);
});

test('a backup changed after confirmation cancels restore without preventing startup',t=>{
 const f=fixture(t),b=new DataBackups(f.store);f.store.addMessage({groupId:'123',content:'must survive'});const snap=b.create();b.schedule(snap.id);f.store.close();fs.appendFileSync(path.join(f.root,'backups/data',snap.id,'config.json'),' ');
 applyPendingRestore(f.root);f.reopen();assert.equal(f.store.messages().total,1);assert.equal(new DataBackups(f.store).status().pending,null);assert.equal(new DataBackups(f.store).status().last.ok,false);
});
test('the same verified backup can be restored more than once',t=>{
 const f=fixture(t);const snap=new DataBackups(f.store).create();for(let i=0;i<2;i++){const b=new DataBackups(f.store);f.store.addMessage({groupId:'123',content:'later'});b.schedule(snap.id);f.store.close();applyPendingRestore(f.root);f.reopen();assert.equal(f.store.messages().total,0);assert.equal(new DataBackups(f.store).status().last.ok,true);}
});

test('deleting selected messages removes only their matching diagnostics',t=>{
 const f=fixture(t);const a=f.store.addMessage({groupId:'123',messageId:'same',content:'delete'});f.store.addMessage({groupId:'456',messageId:'same',content:'keep'});
 f.store.recordTrace('123','same','received','ok');f.store.recordTrace('456','same','received','ok');
 assert.equal(f.store.deleteMessages({ids:[a.id]}).deleted,1);assert.equal(f.store.messageTrace('123','same').length,0);assert.equal(f.store.messageTrace('456','same').length,1);
 f.store.deleteMessages({groupId:'456'});assert.equal(f.store.messageTrace('456','same').length,0);
});
test('merged diagnostics follow same-session targets and stop cycles',t=>{
 const f=fixture(t);f.store.recordTrace('123','a','received','ok');f.store.recordTrace('123','a','merged','合并处理，主请求消息 ID：b');f.store.recordTrace('123','b','sent','done');f.store.recordTrace('456','b','failed','not this group');
 const report=f.store.traceReport('123','a');assert.equal(report.related.length,1);assert.equal(report.related[0].items[0].stage,'sent');
 f.store.recordTrace('123','b','merged','合并处理，主请求消息 ID：a');assert.equal(f.store.traceReport('123','a').related.length,1);
});
