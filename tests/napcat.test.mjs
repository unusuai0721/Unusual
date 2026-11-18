import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../app/lib/store.mjs';
import { NapCat } from '../app/lib/napcat.mjs';
const base=path.resolve('tests/.tmp');fs.mkdirSync(base,{recursive:true});
function fixture(t,fetchImpl){const root=fs.mkdtempSync(path.join(base,'napcat-'));const store=new Store(root);t.after(()=>{store.close();assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});return {root,store,napcat:new NapCat(store,{fetchImpl})};}
const ok=data=>new Response(JSON.stringify({code:0,data}));
test('preparation isolates QQ profile and generates separate local-only credentials without replacing personas',t=>{
 const {root,store,napcat}=fixture(t);const prompt=store.config.personas;napcat.prepare();const first=napcat.managed();const c=store.config;
 assert.equal(c.onebot.baseUrl,'http://127.0.0.1:3212');assert.deepEqual(c.personas,prompt);assert.notEqual(c.onebot.accessToken,c.onebot.webhookToken);assert.notEqual(first.webToken,c.onebot.accessToken);
 const w=JSON.parse(fs.readFileSync(path.join(root,'data/napcat/config/webui.json')));assert.equal(w.host,'127.0.0.1');assert.equal(w.accessControlMode,'whitelist');
 const config=napcat.desiredConfig();assert.equal(config.network.httpServers.length,1);assert.equal(config.network.httpClients.length,1);assert.equal(config.network.httpClients[0].url,'http://127.0.0.1:3210/onebot/events');assert.deepEqual(config.network.plugins,[]);
 napcat.prepare();assert.equal(napcat.managed().webToken,first.webToken);assert.equal(store.config.onebot.accessToken,c.onebot.accessToken);
});
test('status authenticates with the documented hash, coalesces polling, returns no credential',async t=>{
 let n,calls=[];const f=fixture(t,async(url,options)=>{calls.push(url);assert.equal(new URL(url).hostname,'127.0.0.1');if(url.endsWith('/auth/login')){assert.equal(JSON.parse(options.body).hash,createHash('sha256').update(n.managed().webToken+'.napcat').digest('hex'));return ok({Credential:'private-credential'});}assert.equal(options.headers.Authorization,'Bearer private-credential');return ok({isLogin:false,loginPhase:'waiting_qrcode'});});n=f.napcat;n.prepare();
 const png=Buffer.from('89504e470d0a1a0a','hex');fs.writeFileSync(path.join(f.root,'data/napcat/cache/qrcode.png'),png);
 const [a,b]=await Promise.all([n.status(),n.status()]);assert.equal(calls.length,2);assert.equal(a.hasQr,true);assert.deepEqual(a,b);assert.doesNotMatch(JSON.stringify(a),/credential|webToken/i);await n.status();assert.equal(calls.length,2);
 assert.deepEqual(n.qrImage(),png);await assert.rejects(n.call('QQLogin/PasswordLogin'));
});
test('after login managed connections configure once and persist only the QQ number for quick login',async t=>{
 const calls=[];const f=fixture(t,async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});if(url.endsWith('/auth/login'))return ok({Credential:'x'});if(url.endsWith('/CheckLoginStatus'))return ok({isLogin:true,loginPhase:'online'});if(url.endsWith('/GetQQLoginInfo'))return ok({uin:'123456789',nick:'test'});return ok(null);});f.napcat.prepare();
 const s=await f.napcat.status();assert.equal(s.isLogin,true);assert.equal(f.store.config.bot.selfId,'123456789');assert.equal(calls.filter(c=>c.url.endsWith('/SetConfig')).length,1);
 f.napcat.cache=null;await f.napcat.status();assert.equal(calls.filter(c=>c.url.endsWith('/SetConfig')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/SetQuickLoginQQ')).length,1);
 const c=f.store.config;c.onebot.webhookToken='a'.repeat(48);f.store.saveConfig(c);f.napcat.cache=null;await f.napcat.status();assert.equal(calls.filter(c=>c.url.endsWith('/SetConfig')).length,2);
});
test('connection failures and malformed upstream content do not disclose tokens or raw errors',async t=>{
 const f=fixture(t,async()=>{throw new Error('secret-key internal details');});f.napcat.prepare();const s=await f.napcat.status();assert.equal(s.available,false);assert.doesNotMatch(s.error,/secret-key|internal details/);
 f.napcat.fetch=async()=>new Response('not-json');await assert.rejects(f.napcat.raw('auth/login',{}),/格式异常/);
});
test('QR reads and prepare writes reject redirected local data files',t=>{
 const f=fixture(t);f.napcat.prepare();fs.writeFileSync(path.join(f.root,'original.png'),Buffer.from('89504e470d0a1a0a','hex'));fs.linkSync(path.join(f.root,'original.png'),path.join(f.root,'data/napcat/cache/qrcode.png'));assert.throws(()=>f.napcat.qrImage(),/硬链接/);
 fs.writeFileSync(path.join(f.root,'original.json'),'{}');fs.linkSync(path.join(f.root,'original.json'),path.join(f.root,'data/napcat/config/webui.json.tmp'));assert.throws(()=>f.napcat.prepare(),/硬链接/);
});
