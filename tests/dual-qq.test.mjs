import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {Store} from '../app/lib/store.mjs';
import {OfficialQQ} from '../app/lib/official.mjs';
import {NapCat} from '../app/lib/napcat.mjs';
import {createApp} from '../app/server.mjs';
const base=path.resolve('tests/.tmp');fs.mkdirSync(base,{recursive:true});
const ok=x=>new Response(JSON.stringify(x));
function fixture(t){const root=fs.mkdtempSync(path.join(base,'dual-'));const store=new Store(root);t.after(()=>{store.close();assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});return {root,store};}
function config(store){const c=store.config;c.official={enabled:true,appId:'12345',appSecret:'official-private-secret'};store.saveConfig(c);}
class Socket extends EventTarget {static instances=[];constructor(url){super();this.url=url;this.readyState=1;this.sent=[];Socket.instances.push(this);}send(s){this.sent.push(JSON.parse(s));}emit(data){const e=new Event('message');e.data=JSON.stringify(data);this.dispatchEvent(e);}close(){this.readyState=3;const e=new Event('close');e.code=1000;this.dispatchEvent(e);}}
function group(id='123456'){return {id,name:'test',enabled:true,providerId:'deepseek',personaId:'',replyMode:'all',debounceSec:0,cooldownSec:0,quietStart:'',quietEnd:'',autoEmoji:false};}

test('unbind removes only owned login caches, pauses NapCat groups and preserves personas/history/official settings',async t=>{
 const {store,root}=fixture(t);config(store);const c=store.config;c.bot.selfId='99999';c.groups=[group(),{...group('official:12345:GROUP_A'),channel:'official'}];store.saveConfig(c);
 const n=new NapCat(store);n.prepare();store.addMessage({groupId:'123456',content:'retained'});const before=store.config.personas;
 for(const d of ['qq','bridge-profile','napcat/cache']){fs.mkdirSync(path.join(root,'data',d),{recursive:true});fs.writeFileSync(path.join(root,'data',d,'login-ticket'),'test');}
 await assert.rejects(n.unbind({isRunning:async()=>true}),/先断开/);assert.ok(fs.existsSync(path.join(root,'data/qq/login-ticket')));
 await n.unbind({isRunning:async()=>false});assert.equal(store.config.bot.selfId,'');assert.equal(store.config.groups[0].enabled,false);assert.equal(store.config.groups[1].enabled,true);assert.equal(store.config.official.appSecret,'official-private-secret');assert.deepEqual(store.config.personas,before);assert.equal(store.messages().total,1);assert.equal(n.managed().enabled,false);
 for(const d of ['qq','bridge-profile','napcat'])assert.equal(fs.existsSync(path.join(root,'data',d)),false);
 n.prepare();const web=JSON.parse(fs.readFileSync(path.join(root,'data/napcat/config/webui.json')));assert.equal(web.autoLoginAccount,'');
});

test('unbind preflights linked files before deleting any login caches',async t=>{const {store,root}=fixture(t);const n=new NapCat(store);n.prepare();fs.writeFileSync(path.join(root,'keep'),'retained');fs.linkSync(path.join(root,'keep'),path.join(root,'data/qq/ticket'));await assert.rejects(n.unbind({isRunning:async()=>false}),/硬链接/);assert.equal(fs.readFileSync(path.join(root,'keep'),'utf8'),'retained');assert.ok(fs.existsSync(path.join(root,'data/napcat')));});

test('official token calls are cached, pinned to official origin and errors never reflect secrets',async t=>{
 const {store}=fixture(t);config(store);let calls=0;const bot=new OfficialQQ(store,{fetchImpl:async(url,options)=>{calls++;assert.equal(new URL(url).origin,'https://api.bot.qq.com');assert.equal(options.redirect,'error');return ok({access_token:'cache-token',expires_in:'7200'});}});
 const tokens=await Promise.all([bot.token(),bot.token()]);assert.deepEqual(tokens,['cache-token','cache-token']);assert.equal(calls,1);await bot.token();assert.equal(calls,1);
 bot.expires=0;bot.fetch=async()=>ok({code:100016,message:'official-private-secret reflected'});await assert.rejects(bot.token(),e=>/100016/.test(e.message)&&!e.message.includes('private-secret'));
});

test('official websocket identifies, receives unmentioned group messages, ignores bots, and supports resume',async t=>{
 const {store}=fixture(t);config(store);const seen=[];const bot=new OfficialQQ(store,{WebSocketImpl:Socket,fetchImpl:async url=>ok(url.endsWith('getAppAccessToken')?{access_token:'token',expires_in:7200}:{url:'wss://api.bot.qq.com/websocket'}),onEvent:async(e,p)=>seen.push(p)});t.after(()=>bot.stop());bot.start();await bot.drain();let ws=bot.socket;
 ws.emit({op:10,d:{heartbeat_interval:45000}});assert.equal(ws.sent[0].op,2);assert.equal(ws.sent[0].d.token,'QQBot token');assert.equal(ws.sent[0].d.intents,1<<25);
 ws.emit({op:0,s:1,t:'READY',d:{session_id:'session',user:{id:'BOT',username:'official'}}});await bot.drain();assert.equal(bot.connected,true);
 const d={id:'message-1',group_openid:'GROUP_A',timestamp:new Date().toISOString(),author:{member_openid:'USER_A',username:'Friend'},content:'普通消息'};
 ws.emit({op:0,s:2,t:'GROUP_MESSAGE_CREATE',d});await bot.drain();assert.equal(seen.length,1);assert.equal(seen[0].mentioned,false);assert.equal(seen[0].groupId,'official:12345:GROUP_A');assert.equal(bot.groups().length,1);
 ws.emit({op:0,s:3,t:'GROUP_MESSAGE_CREATE',d:{...d,author:{...d.author,bot:true}}});await bot.drain();assert.equal(seen.length,1);
 bot.reconnect();clearTimeout(bot.retryTimer);bot.retryTimer=null;await bot.connect();ws=bot.socket;ws.emit({op:10,d:{heartbeat_interval:45000}});assert.equal(ws.sent[0].op,6);assert.equal(ws.sent[0].d.session_id,'session');assert.equal(ws.sent[0].d.seq,3);
 bot.stop();assert.equal(bot.connected,false);assert.equal(bot.socket,null);
});

test('official gateway rejects non QQ hosts before any credential can reach a socket',async t=>{const {store}=fixture(t);config(store);const bot=new OfficialQQ(store,{WebSocketImpl:Socket,fetchImpl:async url=>ok(url.endsWith('getAppAccessToken')?{access_token:'token',expires_in:7200}:{url:'wss://example.org/steal'})});bot.active=true;await assert.rejects(bot.connect(),/不受信任/);bot.stop();});

test('official media upload and reply use group OpenID, capped local base64 and separate message sequence',async t=>{
 const {store}=fixture(t);config(store);const calls=[];const bot=new OfficialQQ(store,{fetchImpl:async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});return ok(url.endsWith('getAppAccessToken')?{access_token:'token',expires_in:7200}:url.endsWith('/files')?{file_info:'uploaded'}:{id:'sent-id'});}});bot.connected=true;const g={...group('official:12345:GROUP_A'),channel:'official'};bot.replies.set(g.id,{id:'received-id',at:Date.now(),seq:0});
 const result=await bot.sendGroup(g,[{type:'text',data:{text:'hi'}},{type:'image',data:{file:'base64://'+Buffer.from('test').toString('base64')}}]);assert.equal(result.message_id,'sent-id');const upload=calls.find(x=>x.url.endsWith('/files'));assert.equal(upload.body.srv_send_msg,false);assert.equal(upload.body.file_data,'dGVzdA==');assert.equal(calls.at(-1).body.msg_id,'received-id');assert.equal(calls.at(-1).body.msg_seq,1);assert.equal(calls.at(-1).body.media.file_info,'uploaded');
 await bot.sendGroup(g,[{type:'text',data:{text:'again'}}]);assert.equal(calls.at(-1).body.msg_seq,2);
 await assert.rejects(bot.sendGroup({...g,id:'official:54321:GROUP_A'},[{type:'text',data:{text:'no'}}]),/另一个/);
 await assert.rejects(bot.sendGroup(g,[{type:'image',data:{file:'file:///outside'}}]),/本地/);
});

test('group context reset and persona changes preserve history, isolate groups and appear in model prompts',async t=>{
 const root=fs.mkdtempSync(path.join(base,'app-dual-'));const generated=[],sent=[];
 const app=await createApp({root,port:0,startEngine:false,adapterOverrides:{generate:async(p,args)=>{generated.push(args);return {text:'reply',inputTokens:10,outputTokens:2};},onebotCall:async(c,action,p)=>{if(action==='get_login_info')return {user_id:99999};if(action==='get_group_list')return [];sent.push(p);return {message_id:1};}}});
 t.after(async()=>{await app.close();assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const c=app.store.config;c.providers[0].apiKey='fake-model-key';c.bot.enabled=true;c.groups=[group(),group('654321')];c.personas.push({id:'other',name:'Other',description:'',prompt:'NEW_PERSONA',temperature:.7});app.store.saveConfig(c);app.engine.start();
 app.store.addMessage({groupId:'123456',content:'OLD_CONTEXT'});app.store.addMessage({groupId:'654321',content:'KEEP_OTHER_GROUP'});app.engine.resetContext('123456');assert.equal(app.store.context('123456',20).length,0);assert.equal(app.store.context('654321',20).length,1);assert.equal(app.store.messages().total,2);
 await app.engine.preview({message:'hello',personaId:'',sessionId:'shared'});await app.engine.preview({message:'new',personaId:'other',sessionId:'shared'});assert.match(generated.at(-1).system,/NEW_PERSONA/);assert.ok(!generated.at(-1).messages.some(m=>m.content==='hello'));
 const origin='http://127.0.0.1:'+app.port;const auth=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:app.adminToken})});const cookie=auth.headers.get('set-cookie').split(';')[0];
 app.store.addMessage({groupId:'123456',content:'BEFORE_PERSONA_SWITCH'});const next=app.store.config;next.groups[0].personaId='other';const saved=await fetch(origin+'/api/config',{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(next)});assert.equal(saved.status,200);assert.equal(app.store.context('123456',20).length,0);assert.ok(app.store.messages({groupId:'123456'}).total>=2);
 const denied=await fetch(origin+'/api/context/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({groupId:'123456'})});assert.equal(denied.status,401);
});

test('NapCat and official routes run together; disconnecting NapCat does not stop official sends',async t=>{
 const root=fs.mkdtempSync(path.join(base,'routing-'));const sent=[];
 const app=await createApp({root,port:0,startEngine:false,adapterOverrides:{onebotCall:async(c,action,p)=>{if(action==='get_login_info')return {user_id:99999};if(action==='get_group_list')return [];sent.push({channel:'napcat',p});return {message_id:1};}},officialOptions:{fetchImpl:async(url,o)=>{if(url.endsWith('getAppAccessToken'))return ok({access_token:'token',expires_in:7200});sent.push({channel:'official',body:JSON.parse(o.body)});return ok({id:'official-msg'});}}});
 t.after(async()=>{await app.close();assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});const c=app.store.config;c.bot.enabled=true;c.official={enabled:true,appId:'12345',appSecret:'fake'};c.groups=[group(),{...group('official:12345:GROUP_A'),channel:'official'}];app.store.saveConfig(c);app.engine.start();app.official.connected=true;
 const origin='http://127.0.0.1:'+app.port;const login=await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:app.adminToken})});const cookie=login.headers.get('set-cookie').split(';')[0];const post=route=>fetch(origin+route,{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'});
 assert.equal((await post('/api/bridge/test')).status,200);await app.engine.manualSend({groupId:'123456',text:'napcat'});await app.engine.manualSend({groupId:'official:12345:GROUP_A',text:'official'});assert.deepEqual(sent.map(x=>x.channel),['napcat','official']);
 await post('/api/qq/stopped');await assert.rejects(app.engine.manualSend({groupId:'123456',text:'paused'}),/尚未连接/);await app.engine.manualSend({groupId:'official:12345:GROUP_A',text:'still connected'});assert.equal(sent.at(-1).channel,'official');
});

test('reapplying a persona cancels both in-flight and queued old group replies without deleting history',async t=>{
 const {store}=fixture(t);const {Engine}=await import('../app/lib/engine.mjs');let release,generated=0,sent=0;
 const c=store.config;c.bot.enabled=true;c.providers[0].apiKey='fake';c.groups=[group()];store.saveConfig(c);store.addMessage({groupId:'123456',content:'old incoming'});
 const engine=new Engine(store,{adapters:{generate:async()=>{generated++;await new Promise(r=>release=r);return {text:'stale',inputTokens:10,outputTokens:1};},onebotCall:async()=>{sent++;return {message_id:1};}},canSend:()=>true});engine.start();t.after(()=>engine.stop());
 const first=engine._reply('123456','first');const second=engine._reply('123456','queued');const done=Promise.allSettled([first,second]);for(let i=0;i<50&&!release;i++)await new Promise(r=>setTimeout(r,1));assert.ok(release);engine.resetContext('123456');release();const results=await done;assert.ok(results.every(x=>x.status==='rejected'));assert.equal(generated,1);assert.equal(sent,0);assert.equal(store.todayUsage().calls,1);assert.ok(store.messages().total>=1);assert.equal(store.context('123456',20).length,0);
 engine.adapters.generate=async()=>({text:'fresh',inputTokens:10,outputTokens:1});store.addMessage({groupId:'123456',content:'new incoming'});await engine._reply('123456','new incoming');assert.equal(sent,1,'new replies must work after reset');
});


test('official bare mentions reach engine and content rejection has a precise safe explanation',async t=>{
 const {store}=fixture(t);config(store);const seen=[];const bot=new OfficialQQ(store,{onEvent:async(e,p)=>seen.push(p)});
 await bot.dispatch({t:'GROUP_AT_MESSAGE_CREATE',d:{id:'bare',group_openid:'GROUP_A',timestamp:new Date().toISOString(),author:{member_openid:'USER_A'},content:''}});
 assert.equal(seen.length,1);assert.equal(seen[0].mentioned,true);assert.ok(seen[0].content);
 bot.fetch=async()=>new Response(JSON.stringify({code:40034006,message:'official-private-secret'}),{status:400});
 await assert.rejects(bot.json('/mock'),e=>e.code==='official_40034006'&&/内容被 QQ 判定违规/.test(e.message)&&!e.message.includes('private-secret'));
});

test('private and group numeric identities have independent durable history and reset points',t=>{
 const {store}=fixture(t);store.addMessage({groupId:'777',content:'GROUP'});store.addMessage({groupId:'private:777',content:'FRIEND'});
 assert.equal(store.context('777',20)[0].content,'GROUP');assert.equal(store.context('private:777',20)[0].content,'FRIEND');
 store.resetContext('private:777');assert.equal(store.context('private:777',20).length,0);assert.equal(store.context('777',20).length,1);
 assert.equal(store.messages({groupId:'private:777'}).total,1);assert.equal(store.messages().total,2);
});
