import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../app/server.mjs';
import { Store } from '../app/lib/store.mjs';
import { AppPaths } from '../app/lib/paths.mjs';
import { validateConfig, defaultConfig } from '../app/lib/config.mjs';

const tempBase = path.resolve('tests/.tmp');
fs.mkdirSync(tempBase, { recursive: true });
const testRoots=[];
function temporary(t) { const root = fs.mkdtempSync(path.join(tempBase, 'case-')); testRoots.push(root); return root; }
after(() => { for(const root of testRoots) { assert.ok(root.startsWith(tempBase + path.sep)); fs.rmSync(root,{recursive:true,force:true}); } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(10); } assert.fail('Timed out waiting for local event'); }
async function fixture(t, options = {}) {
  const root = temporary(t), app = await createApp({ root, port: 0, ...options });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: app.adminToken }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function call(route, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const r = await fetch(base + route, { method, headers: { ...(auth ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json(); return { status: r.status, data, headers: r.headers };
  }
  return { root, app, base, cookie, call };
}

test('configuration rejects invalid groups, URLs and duplicate IDs without replacing saved config', t => {
  const root = temporary(t), store = new Store(root); t.after(() => store.close());
  const before = store.config;
  const bad = structuredClone(before); bad.providers[0].baseUrl = 'file:///C:/Windows';
  assert.throws(() => store.saveConfig(bad)); assert.deepEqual(store.config, before);
  bad.providers[0].baseUrl = 'http://example.com'; assert.throws(() => validateConfig(bad));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'))), before);
});

test('history queries escape LIKE wildcards, paginate, delete and keep usage separate', t => {
  const store = new Store(temporary(t)); t.after(() => store.close());
  for (const content of ['hello', '100% real', 'under_score']) store.addMessage({ groupId: '123', role: 'user', content });
  assert.equal(store.messages({ q: '%' }).total, 1); assert.equal(store.messages({ q: '_' }).total, 1);
  const page = store.messages({ limit: 2 }); assert.deepEqual(page.items.map(x => x.id), [2, 3]);
  assert.equal(store.messages({ before: 2 }).items[0].content, 'hello');
  store.recordUsage({ providerId: 'deepseek', inputTokens: 40, outputTokens: 5 });
  assert.equal(store.deleteMessages({ groupId: '123' }).deleted, 3);
  assert.equal(store.todayUsage().totalTokens, 45);
});

test('filesystem guard rejects path traversal and existing hardlinks', t => {
  const root = temporary(t), paths = new AppPaths(root);
  assert.throws(() => paths.resolve('../outside.txt'));
  for (const name of ['../secret.png', 'C:\\Windows\\x.png', 'CON.png', '.hidden.png', 'bad.svg']) assert.throws(() => paths.mediaPath('emoji', name));
  fs.writeFileSync(path.join(root, 'original'), 'text');
  fs.linkSync(path.join(root, 'original'), path.join(root, 'data/config.json.tmp'));
  assert.throws(() => paths.writeJson('data/config.json', {}), /硬链接/);
});

test('admin sessions, API token isolation and origin checks protect configuration', async t => {
  const { app, call } = await fixture(t);
  assert.equal((await call('/api/config', { auth: false })).status, 401);
  assert.equal((await call('/api/config', { auth: false, headers: { authorization: `Bearer ${app.store.config.api.token}` } })).status, 401);
  assert.equal((await call('/api/config', { headers: { origin: 'https://example.com' } })).status, 403);
  assert.equal((await call('/api/session', { method: 'POST', auth: false, body: { token: '密'.repeat(48) } })).status, 401);
  const config = await call('/api/config'); assert.equal(config.status, 200);
  assert.equal((await call('/onebot/events', { method: 'POST', auth: false, body: {} })).status, 401);
  const rotated = await call('/api/token/rotate', { method: 'POST', body: { kind: 'api' } });
  assert.notEqual(rotated.data.token, config.data.api.token);
  assert.equal((await call('/v1/chat', { method: 'POST', auth: false, headers: { authorization: `Bearer ${config.data.api.token}` }, body: { message: 'hello' } })).status, 401);
});

test('real HTTP end-to-end: non-mention QQ reply, image, search, API, history export and voice', async t => {
  const sent = [], modelRequests = [], searches = [];
  const remote = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    res.setHeader('Content-Type', 'application/json');
    let result;
    if (req.url === '/chat/completions') { modelRequests.push(data); result = { choices: [{ message: { content: '你好，很高兴加入聊天！[表情:smile.png]' } }], usage: { prompt_tokens: 42, completion_tokens: 12 } }; }
    else if (req.url === '/get_login_info') result = { status: 'ok', retcode: 0, data: { user_id: 999, nickname: 'TestBot' } };
    else if (req.url === '/get_group_list') result = { status: 'ok', retcode: 0, data: [{ group_id: 123456, group_name: 'TestGroup' }] };
    else if (req.url === '/send_group_msg') { sent.push(data); result = { status: 'ok', retcode: 0, data: { message_id: 1000 + sent.length } }; }
    else if (req.url === '/search') { searches.push(data); result = { results: [{ title: 'Search result', url: 'https://example.com/news', content: 'A useful current reference.' }] }; }
    else if (req.url === '/audio/speech') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(Buffer.from('ID3test-audio')); return; }
    else { res.statusCode = 404; result = {}; }
    res.end(JSON.stringify(result));
  });
  await new Promise(r => remote.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => remote.close(r)));
  const { app, root, call } = await fixture(t);
  const upstream = `http://127.0.0.1:${remote.address().port}`;
  const config = app.store.config;
  config.bot.enabled = true; config.bot.selfId = '999';
  config.providers[0].baseUrl = upstream; config.providers[0].apiKey = 'test-key';
  config.onebot.baseUrl = upstream; config.onebot.secret = 'test-secret';
  config.search = { ...config.search, enabled: true, baseUrl: upstream, apiKey: 'search-key' };
  config.voice = { ...config.voice, enabled: true, baseUrl: upstream, apiKey: 'voice-key' };
  config.groups = [{ id: '123456', name: 'Test group', enabled: true, personaId:'', providerId: 'deepseek', replyMode: 'all', cooldownSec: 0, debounceSec: 0, quietStart: '', quietEnd: '', maxRepliesPerHour: 20, autoEmoji: true, emojiProbability:100 }];
  assert.equal((await call('/api/config', { method: 'PUT', body: config })).status, 200);
  assert.equal((await call('/api/bridge/test', { method: 'POST', body: {} })).data.ok, true);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAS8AAAAASUVORK5CYII=';
  assert.equal((await call('/api/emoji', { method: 'POST', body: { name: 'smile.png', data: png, tags: ['开心'] } })).status, 201);
  assert.equal((await call('/api/emoji', { method: 'POST', body: { name: '../escape.png', data: png } })).status, 400);
  const event = { post_type: 'message', message_type: 'group', group_id: 123456, user_id: 111, self_id: 999, message_id: 1, message: [{ type: 'text', data: { text: '大家今天过得怎么样？' } }], sender: { nickname: '成员' } };
  const eventHeaders = { authorization: `Bearer ${config.onebot.webhookToken}` };
  const received = await call('/onebot/events', { method: 'POST', auth: false, body: event, headers: eventHeaders });
  assert.equal(received.data.accepted, true); await waitUntil(() => sent.length === 1);
  assert.equal(sent[0].message[0].type, 'text'); assert.equal(sent[0].message[1].type, 'image');
  assert.ok(sent[0].message[1].data.file.startsWith('base64://'));
  assert.ok(modelRequests[0].messages.some(m => m.content.includes('大家今天')));
  assert.ok(!modelRequests[0].tools);
  assert.equal((await call('/onebot/events', { method: 'POST', auth: false, body: event, headers: eventHeaders })).data.reason, 'duplicate');
  const signedEvent = { ...event, message_id: 2, user_id: 999 };
  const signature = 'sha1=' + createHmac('sha1', config.onebot.secret).update(JSON.stringify(signedEvent)).digest('hex');
  assert.equal((await call('/onebot/events', { method: 'POST', auth: false, body: signedEvent, headers: { 'x-signature': signature } })).data.reason, 'self_or_bot');
  const api = await call('/v1/chat', { method: 'POST', auth: false, headers: { authorization: `Bearer ${config.api.token}` }, body: { message: '搜索最新信息', search: true, sessionId: 'external' } });
  assert.equal(api.status, 200); assert.equal(api.data.usage.totalTokens, 54); assert.equal(api.data.sources.length, 1);
  assert.equal(searches.length, 1); assert.equal(sent.length, 1, 'API must not send QQ');
  const preview = await call('/api/preview', { method: 'POST', body: { message: '你好', sessionId: 'preview' } });
  assert.equal(preview.status, 200); assert.equal(sent.length, 1);
  const voice = await call('/api/voice/test', { method: 'POST', body: { text: '试音' } });
  assert.equal(voice.status, 200); assert.equal(voice.data.segment, undefined);
  assert.ok(fs.existsSync(path.join(root, 'data/audio', voice.data.name)));
  const exported = await call('/api/export', { method: 'POST', body: { groupId: '123456' } });
  assert.equal(exported.data.count, 2); assert.ok(fs.existsSync(path.join(root, 'data/exports', exported.data.name)));
  const messages = (await call('/api/messages?groupId=123456')).data;
  assert.deepEqual(messages.items.map(m => m.status), ['received', 'sent']);
  assert.equal((await call('/api/messages', { method: 'DELETE', body: { groupId: '123456' } })).data.deleted, 2);
  assert.equal(app.store.todayUsage().totalTokens, 162);
});

test('shutdown drains disconnected asynchronous handlers and returns one shared promise', async t => {
  let release; let started; const begun = new Promise(r => { started = r; });
  const gate = new Promise(r => { release = r; });
  const { app, base, cookie } = await fixture(t, { adapterOverrides: { onebotCall: async (_cfg, action) => { if (action === 'get_login_info') { started(); await gate; return { user_id: 999 }; } return []; } } });
  const abort = new AbortController();
  const request = fetch(base + '/api/bridge/test', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}', signal: abort.signal }).catch(() => {});
  await begun; abort.abort(); await request;
  let closed = false; const closing = app.close(); assert.equal(app.close(), closing);
  closing.then(() => { closed = true; }); await sleep(10); assert.equal(closed, false);
  release(); await closing; assert.equal(closed, true);
});


test('immutable config snapshots cannot leak editor mutations and usage cache invalidates on writes', t => {
  const store=new Store(temporary(t));t.after(()=>store.close());
  const before=store.configView;assert.equal(before,store.configView);
  assert.throws(()=>{before.personas.push({id:'test'});},TypeError);
  const edit=store.config;edit.personas.push({id:'test',name:'测试',prompt:'changed'});assert.equal(store.configView.personas.length,0);
  store.saveConfig(edit);assert.notEqual(store.configView,before);assert.equal(before.personas.length,0);
  assert.equal(store.todayUsage().totalTokens,0);store.recordUsage({inputTokens:12,outputTokens:3});assert.equal(store.todayUsage().totalTokens,15);
  const u=store.todayUsage();u.totalTokens=999;assert.equal(store.todayUsage().totalTokens,15);
  for(let i=0;i<100;i++)store.prepare('SELECT '+i);assert.ok(store.statements.size<=64);
});

test('integrated QQ endpoints require admin authentication and never accept arbitrary operations',async t=>{
  const {app,call}=await fixture(t);
  assert.equal((await call('/api/qq/status',{auth:false})).status,401);
  assert.equal((await call('/api/qq/prepare',{method:'POST',body:{},auth:false})).status,401);
  assert.equal((await call('/api/qq/PasswordLogin',{method:'POST',body:{}})).status,404);
  assert.equal((await call('/api/qq/status')).data.available,false);
  assert.equal((await call('/api/qq/qrcode')).status,404);
});


test('NapCat token HMAC is accepted, tampered and unrelated credentials are rejected, diagnostics distinguish incoming failures', async t => {
  const { app, call, base } = await fixture(t, { startEngine:false });
  const c=app.store.config;
  const event={post_type:'meta_event',meta_event_type:'heartbeat',time:123};
  const raw=JSON.stringify(event);
  const signature=key=>'sha1='+createHmac('sha1',key).update(raw).digest('hex');
  const submit=key=>call('/onebot/events',{method:'POST',auth:false,body:event,headers:{'x-signature':signature(key)}});
  assert.equal((await submit(c.onebot.webhookToken)).status,200);
  assert.equal((await submit(c.api.token)).status,401);
  assert.equal((await submit(app.adminToken)).status,401);
  const changed=await fetch(base+'/onebot/events',{method:'POST',headers:{'content-type':'application/json','x-signature':signature(c.onebot.webhookToken)},body:JSON.stringify({...event,time:124})});
  assert.equal(changed.status,401);
  const status=(await call('/api/status')).data;
  assert.equal(status.bridge.incoming.acceptedEvents,1);assert.equal(status.bridge.incoming.authFailures,3);assert.match(status.bridge.incoming.lastError,/签名/);
  const explicit=app.store.config;explicit.onebot.secret='separate-legacy-secret';app.store.saveConfig(explicit);
  assert.equal((await submit(explicit.onebot.secret)).status,200);
  assert.equal((await submit(c.onebot.webhookToken)).status,200);
  const cleared=(await call('/api/status')).data;
  assert.equal(cleared.bridge.incoming.lastError,'');assert.equal(cleared.bridge.incoming.acceptedEvents,3);
});

test('clean first startup exposes guarded backup and diagnostics endpoints with auto chat off',async t=>{
 const f=await fixture(t);assert.equal(f.app.store.config.bot.enabled,false);assert.equal(f.app.store.config.groups.length,0);assert.ok(f.app.store.config.providers.every(p=>!p.apiKey));
 assert.equal((await f.call('/api/backups',{auth:false})).status,401);
 const created=await f.call('/api/backups',{method:'POST',body:{}});assert.equal(created.status,200);
 assert.equal((await f.call('/api/backups/verify',{method:'POST',body:{id:created.data.id}})).data.ok,true);
 assert.equal((await f.call('/api/backups/restore',{method:'POST',body:{id:created.data.id}})).status,400);
 assert.equal((await f.call('/api/backups/restore',{method:'POST',body:{id:created.data.id,confirm:'RESTORE'}})).data.restartRequired,true);
 await f.call('/api/backups/restore',{method:'DELETE',body:{}});assert.equal((await f.call('/api/backups')).data.pending,null);
 const message=f.app.store.addMessage({groupId:'123',messageId:'first',content:'模拟消息'});f.app.store.recordTrace('123','first','skipped','paused');
 assert.equal((await f.call('/api/messages/trace?id='+message.id)).data.items[0].detail,'paused');assert.equal((await f.call('/api/messages/trace?id='+message.id,{auth:false})).status,401);
});

test('activity and precise history filters require admin and reject invalid ranges',async t=>{const {call,app}=await fixture(t,{startEngine:false});assert.equal((await call('/api/activity',{auth:false})).status,401);assert.equal((await call('/api/activity?days=2')).status,400);const data=(await call('/api/activity?days=30')).data;assert.equal(data.daily.length,30);assert.equal(data.total.calls,0);assert.equal((await call('/api/messages?from=2026-99-99')).status,400);app.store.addMessage({groupId:'123',senderId:'42',content:'filter fixture'});assert.equal((await call('/api/messages?senderId=42&source=qq')).data.total,1);assert.equal((await call('/api/messages?senderId=142')).data.total,0);});

test('MemeWiki management is admin-only, query-only API clients cannot edit, and CRUD preserves all fields',async t=>{const f=await fixture(t,{startEngine:false});assert.equal((await f.call('/api/memewiki/state',{auth:false})).status,401);assert.equal((await f.call('/api/memewiki/config',{method:'POST',body:{enabled:false},auth:false})).status,401);const v=await f.call('/api/memewiki/save',{method:'POST',body:{title:'测试离线梗',isNew:true,usage:'接一句',other:'保持',aliases:'abc,def',slug:'test-slug'}});assert.equal(v.status,200);assert.equal((await f.call('/api/memewiki/list?q=abc')).data.total,1);await f.call('/api/memewiki/save',{method:'POST',body:{title:'测试离线梗',summary:'新摘要'}});assert.equal((await f.call('/api/memewiki/get?title='+encodeURIComponent('测试离线梗'))).data.item.other,'保持');assert.equal((await f.call('/api/memewiki/lookup?q=def')).data.item.title,'测试离线梗');assert.equal((await f.call('/api/memewiki/config',{method:'POST',body:{roastLevel:101}})).status,400);await f.call('/api/memewiki/delete',{method:'POST',body:{title:'测试离线梗'}});assert.equal((await f.call('/api/memewiki/state')).data.total,0);});

test('manual group mentions are picked from the current group and all sent as real at segments',async t=>{
  const sent=[];
  const {app,call}=await fixture(t,{startEngine:false,adapterOverrides:{onebotCall:async(_,action,params)=>{
    if(action==='get_login_info')return {user_id:999};
    if(action==='get_group_list')return [{group_id:123456}];
    if(action==='get_group_member_list'){
      assert.equal(params.group_id,'123456');
      return [{user_id:999,nickname:'自己'},{user_id:111,card:'甲的名片',nickname:'甲'},{user_id:222,nickname:'乙'}];
    }
    assert.equal(action,'send_group_msg');
    sent.push(params);
    return {message_id:1};
  }}});
  const config=app.store.config;
  config.bot.enabled=true;
  config.groups=[{id:'123456',name:'测试群',enabled:true,personaId:'',providerId:'deepseek',cooldownSec:0,quietStart:'00:00',quietEnd:'00:00',allowMention:false}];
  assert.equal((await call('/api/config',{method:'PUT',body:config})).status,200);
  assert.equal((await call('/api/bridge/test',{method:'POST',body:{}})).status,200);
  app.engine.start();
  const roster=await call('/api/qq/group-members?groupId=123456');
  assert.deepEqual(roster.data.members.map(m=>[m.user_id,m.name]),[['111','甲的名片'],['222','乙']]);
  assert.equal((await call('/api/qq/group-members?groupId=654321')).status,404);
  const send=body=>call('/api/send',{method:'POST',body:{groupId:'123456',...body}});
  assert.equal((await send({mentions:['111','555']})).status,400);
  assert.equal((await send({mentions:['all']})).status,400);
  assert.equal((await send({mentions:['111'],voice:true,text:'你好'})).status,400);
  assert.equal(sent.length,0);
  const result=await send({mentions:['111','222','111'],text:'你们好'});
  assert.equal(result.status,200);
  assert.deepEqual(sent[0].message,[
    {type:'at',data:{qq:'111'}},{type:'at',data:{qq:'222'}},{type:'text',data:{text:' 你们好'}}
  ]);
  assert.match(result.data.message.content,/\[艾特:111\]\n\[艾特:222\]\n你们好/);
});
