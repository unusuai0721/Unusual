import {mentionRoster} from './lib/mention-targets.mjs';
import {CommentSchedule} from './lib/comment-schedule.mjs';
import {pollMomentComments} from './lib/moment-comments.mjs';
import {MemeWiki} from './lib/memewiki.mjs';
import {activityReport} from './lib/activity.mjs';
import {DataBackups,applyPendingRestore} from './lib/backups.mjs';
import {VoiceLibrary} from './lib/voice-library.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { Store } from './lib/store.mjs';
import { Media } from './lib/media.mjs';
import { token } from './lib/config.mjs';
import * as adapters from './lib/adapters.mjs';
import { OfficialQQ } from './lib/official.mjs';
import { NapCat } from './lib/napcat.mjs';
import { Engine } from './lib/engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function error(status, message) { return Object.assign(new Error(message), { status }); }
async function body(req, max = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw error(413, '请求内容过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const jsonBody = raw => { try { const value = JSON.parse(raw.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw error(400, '请求必须为 JSON 对象'); } };

import {bundleEnabled,importBundle} from './lib/bundled-emoji.mjs';
import {Moments} from './lib/moments.mjs';
export async function createApp({ root = ROOT, port = 3210, adapterOverrides, officialOptions, startEngine = true } = {}) {
  applyPendingRestore(root);
  const store = new Store(root), media = new Media(store);
  const providers = { ...adapters, ...adapterOverrides };
  const backups=new DataBackups(store);
  const memeWiki=new MemeWiki(store);
  const voiceLibrary=new VoiceLibrary(store,providers);
  const engine = new Engine(store, { memeWiki, adapters: providers, media, canSend: group => group?.channel==='official'?official.canSend(group):bridge.connected });
  const napcat = new NapCat(store,{basePort:port===4210?4210:3210});
  const official = new OfficialQQ(store,{...officialOptions,onEvent:(event,parsed)=>engine.receive(event,parsed)});
  providers.sendOfficial=(group,segments,guard)=>official.sendGroup(group,segments,guard);
  const adminToken = token(), sessionToken = token(), started = Date.now();
  let bridge = { connected: false, lastCheckedAt: null, error: '' }, closed = false, busyApi = 0;
  let server, actualPort = port, closePromise, activeHandlers = 0;
  const drainWaiters = [];
  const incoming = { acceptedEvents:0, authFailures:0, lastReceivedAt:null, lastError:'' };
  let lastAuthWarningAt = 0;
  const authAttempts = new Map();
  const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
  const respond = (res, code, data, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };
  function admin(req) {
    const cookies = (req.headers.cookie || '').split(';').map(v => v.trim());
    return cookies.some(v => same(v, `xingyu_session=${sessionToken}`));
  }
  function checkOrigin(req) {
    if (req.headers.origin && ![`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(req.headers.origin)) throw error(403, '不允许跨站请求');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw error(403, '不允许跨站请求');
  }
  const rateLimit = (key, maximum, windowMs) => {
    const now = Date.now(), values = (authAttempts.get(key) || []).filter(v => now - v < windowMs);
    if (values.length >= maximum) throw error(429, '请求过于频繁，请稍后再试');
    values.push(now); authAttempts.set(key, values);
  };
  async function checkBridge() {
    try {
      const cfg = store.config.onebot;
      const info = await providers.onebotCall(cfg, 'get_login_info', {});
      const groups = await providers.onebotCall(cfg, 'get_group_list', {});
      bridge = { connected: true, lastCheckedAt: new Date().toISOString(), error: '', info };
      if (info?.user_id && !store.config.bot.selfId) { const c = store.config; c.bot.selfId = String(info.user_id); store.saveConfig(c); }
      store.log('info', 'bridge.connected', 'OneBot 连接正常');
      return { ok: true, info, groups };
    } catch (e) { bridge = { connected: false, lastCheckedAt: new Date().toISOString(), error: e.message }; store.log('error', 'bridge.failed', e.message); throw e; }
  }
  server = http.createServer(async (req, res) => {
    activeHandlers++;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closed) throw error(503, '服务正在关闭');
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) throw error(403, '只接受本机地址');
      checkOrigin(req);
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`), route = url.pathname, method = req.method;
      if (route === '/health' && method === 'GET') return respond(res, 200, { app: 'qiliao', version: VERSION, pid: process.pid });
      if (method === 'GET' && staticFiles[route]) {
        const [file, type] = staticFiles[route];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(path.join(ROOT, 'app', 'public', file)));
      }
      if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (route === '/api/session' && method === 'POST') {
        rateLimit('session', 20, 60000);
        const data = jsonBody(await body(req, 4096));
        if (!same(data.token, adminToken)) throw error(401, '启动会话已失效，请重新双击启动软件');
        return respond(res, 200, { ok: true }, { 'Set-Cookie': `xingyu_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (route === '/onebot/events' && method === 'POST') {
        rateLimit('webhook', 1200, 60000);
        const cfg = store.config.onebot;
        const raw = await body(req, 1024 * 1024);
        const bearer = same(req.headers.authorization, `Bearer ${cfg.webhookToken}`);
        // NapCat signs the body using its configured HTTP-client token, without Bearer auth.
        const signed = [cfg.secret, cfg.webhookToken].filter(Boolean).some(secret => same(req.headers['x-signature'], 'sha1=' + createHmac('sha1', secret).update(raw).digest('hex')));
        if (!bearer && !signed) {
          incoming.authFailures++; incoming.lastError='收到消息上报，但签名校验失败，请检查连接配置';
          if (Date.now()-lastAuthWarningAt>60000) { store.log('error','bridge.incoming_auth',incoming.lastError); lastAuthWarningAt=Date.now(); }
          throw error(401, 'OneBot 上报鉴权失败');
        }
        const data = jsonBody(raw);
        incoming.acceptedEvents++; incoming.lastReceivedAt=new Date().toISOString(); incoming.lastError='';
        if(data.post_type==='message'&&['group','private'].includes(data.message_type)) bridge = {...bridge,connected:true,lastCheckedAt:new Date().toISOString(),error:''};
        // receipt does not imply a model reply; engine debounces asynchronously.
        return respond(res, 200, await engine.receive(data));
      }
      if (route === '/v1/chat' && method === 'POST') {
        rateLimit('api', 60, 60000);
        if (!store.config.api.enabled) throw error(403, '本机 API 已关闭');
        if (!same(req.headers.authorization, `Bearer ${store.config.api.token}`)) throw error(401, 'API 令牌不正确');
        const data = jsonBody(await body(req, 100000));
        if (busyApi >= 3) throw error(429, '正在处理其他请求，请稍后重试');
        busyApi++;
        try { return respond(res, 200, await engine.apiChat(data)); } finally { busyApi--; }
      }
      if (!admin(req)) throw error(401, '请从启动入口打开管理界面');
      if (method !== 'GET' && method !== 'HEAD' && !(req.headers['content-type'] || '').startsWith('application/json')) throw error(415, '请使用 application/json');
      if (method === 'GET' && route === '/api/status') {
        const c = store.config, summary = store.summary(), engineStatus = engine.status();
        const eventAt = engineStatus.lastEventAt;
        return respond(res, 200, { app: 'Unusual', version: VERSION, runtime: { memoryMB:Math.round(process.memoryUsage().rss/1048576) }, port: actualPort, uptime: Math.floor((Date.now() - started) / 1000), root: store.paths.root, summary, engine: engineStatus, official: official.status(), bridge: { ...bridge, incoming: { ...incoming }, stale: !bridge.lastCheckedAt || Date.now() - Date.parse(bridge.lastCheckedAt) > 120000, lastEventAt: eventAt }, media: { emojiCount: media.listEmoji().length }, setup: { providerReady: c.providers.some(p => p.enabled && p.apiKey), groupsReady: c.groups.some(g => g.enabled), bridgeReady: bridge.connected || official.connected }, apiUrl: `http://127.0.0.1:${actualPort}/v1/chat` });
      }
      if(route==='/api/memewiki/state'&&method==='GET')return respond(res,200,memeWiki.state());
      if(route==='/api/memewiki/list'&&method==='GET')return respond(res,200,memeWiki.list(Object.fromEntries(url.searchParams)));
      if(route==='/api/memewiki/get'&&method==='GET'){const item=memeWiki.get(url.searchParams.get('title'));if(!item)throw error(404,'词条不存在');return respond(res,200,{item});}
      if(route==='/api/memewiki/lookup'&&method==='GET'){const query=url.searchParams.get('q')||'';const item=memeWiki.lookup(query);return respond(res,200,{item,automaticCandidate:memeWiki.prefetch(query)?.row?.title||null});}
      if(route==='/api/memewiki/config'&&method==='POST')return respond(res,200,memeWiki.configure(jsonBody(await body(req,4096))));
      if(route==='/api/memewiki/save'&&method==='POST')return respond(res,200,{item:memeWiki.save(jsonBody(await body(req,200000)))});
      if(route==='/api/memewiki/delete'&&method==='POST')return respond(res,200,memeWiki.remove(jsonBody(await body(req,4096)).title));
      if(route==='/api/memewiki/check-update'&&method==='POST')return respond(res,200,await memeWiki.checkUpdate());
      if(route==='/api/activity'&&method==='GET')return respond(res,200,activityReport(store,url.searchParams.get('days')||7));
      if (route === '/api/config' && method === 'GET') return respond(res, 200, store.config);
      if (route === '/api/config' && method === 'PUT') {
        const oldConfig=store.config; const previous = oldConfig.onebot;
        const c = store.saveConfig(jsonBody(await body(req, 2000000)));
        if (previous.baseUrl !== c.onebot.baseUrl || previous.accessToken !== c.onebot.accessToken) bridge = { connected: false, lastCheckedAt: null, error: '' };
        for(const group of c.groups){const old=oldConfig.groups.find(g=>g.id===group.id);if(old&&old.personaId!==group.personaId)engine.resetContext(group.id);}
        if(JSON.stringify(oldConfig.official)!==JSON.stringify(c.official)){official.stop();await official.drain();official.start();}
        return respond(res, 200, c);
      }
      if (route === '/api/qq/stopped' && method === 'POST') { const data=jsonBody(await body(req,4096));bridge = {...bridge,connected:false};if(data.persist)napcat.setAutoStart(false);napcat.invalidate();return respond(res,200,{ok:true}); }
      if(route==='/api/qq/unbind'&&method==='POST'){if(jsonBody(await body(req,4096)).confirm!=='UNBIND')throw error(400,'请确认解绑');const result=await napcat.unbind();bridge={...bridge,connected:false};return respond(res,200,result);}
      if(route==='/api/official/status'&&method==='GET')return respond(res,200,official.status());
      if(route==='/api/official/connect'&&method==='POST'){const c=store.config;c.official.enabled=true;store.saveConfig(c);official.stop();await official.drain();official.start();return respond(res,200,{ok:true});}
      if(route==='/api/official/disconnect'&&method==='POST'){const c=store.config;c.official.enabled=false;store.saveConfig(c);official.stop();await official.drain();return respond(res,200,{ok:true});}
      if(route==='/api/persona-personality'&&method==='GET'){const id=url.searchParams.get('id');if(!store.config.personas.some(p=>p.id===id))throw error(404,'人设不存在');return respond(res,200,engine.personality.get(id));}
      if(route==='/api/persona-personality'&&method==='PUT'){const d=jsonBody(await body(req,100000));return respond(res,200,engine.personality.edit(d.id,d));}
      if(route==='/api/persona-learning'&&method==='GET'){const id=url.searchParams.get('id');if(!store.config.personas.some(p=>p.id===id))throw error(404,'请先保存这个人设');return respond(res,200,engine.learning.get(id));}
      if(route==='/api/persona-learning'&&method==='PUT'){const d=jsonBody(await body(req,20000));return respond(res,200,engine.learning.edit(d.id,d));}
      if(route==='/api/moments/publish' && method==='POST'){await checkBridge();if(momentsJob)throw error(409,'动态正在处理');momentsJob=moments.tick(true);try{return respond(res,200,await momentsJob);}finally{momentsJob=null;}}
      if(route==='/api/moments' && method==='GET')return respond(res,200,{...moments.state(),replyStatus:store.getMeta('moments:replyStatus',null),pollStatus:store.getMeta('moments:pollStatus',null)});
      if(route==='/api/moments' && method==='PUT')return respond(res,200,moments.save(jsonBody(await body(req,48000))));
      if(route==='/api/qq/group-members'&&method==='GET'){
        const members=await engine.groupMentionMembers(url.searchParams.get('groupId')||'');
        return respond(res,200,{members:[...members.values()]});
      }
      if(route==='/api/qq/friends'&&method==='GET'){
        const config=store.configView;
        const rows=await providers.onebotCall(config.onebot,'get_friend_list');
        return respond(res,200,{friends:[...mentionRoster(rows,'friend',config.bot.selfId).values()]});
      }
      if(route==='/api/context'&&method==='GET'){const id=url.searchParams.get('id');if(!store.config.groups.some(g=>g.id===id))throw error(404,'会话不存在');return respond(res,200,{items:store.context(id,200),memories:engine.memories.list(id),activeMemories:engine.memories.active(id),revision:store.getMeta('context:revision:'+id,0)});}
      if(route==='/api/memories'&&method==='POST')return respond(res,200,engine.memories.save(jsonBody(await body(req,8192))));
      if(route==='/api/memories'&&method==='DELETE')return respond(res,200,engine.memories.remove(jsonBody(await body(req,4096)).id));
      if(route==='/api/context/reset'&&method==='POST'){const d=jsonBody(await body(req,4096));return respond(res,200,engine.resetContext(String(d.groupId||'')));}
      if (route === '/api/qq/prepare' && method === 'POST') return respond(res, 200, napcat.prepare());
      if (route === '/api/qq/status' && method === 'GET') return respond(res, 200, await napcat.status());
      if (route === '/api/qq/refresh' && method === 'POST') return respond(res, 200, await napcat.refreshQr());
      if (route === '/api/qq/qrcode' && method === 'GET') { const image=napcat.qrImage();res.writeHead(200, {'Content-Type':'image/png','Cache-Control':'no-store'});return res.end(image); }
      if (route === '/api/bridge/test' && method === 'POST') return respond(res, 200, await checkBridge());
      if(route==='/api/backups'&&method==='GET')return respond(res,200,{items:backups.list(),...backups.status()});
      if(route==='/api/backups'&&method==='POST')return respond(res,200,backups.create());
      if(route==='/api/backups/verify'&&method==='POST'){const d=jsonBody(await body(req,4096));const result=backups.verify(d.id);return respond(res,200,{ok:true,id:d.id,files:result.manifest.files.length,bytes:result.manifest.bytes});}
      if(route==='/api/backups/restore'&&method==='POST'){const d=jsonBody(await body(req,4096));if(d.confirm!=='RESTORE')throw error(400,'请先确认恢复');return respond(res,200,backups.schedule(d.id));}
      if(route==='/api/backups/restore'&&method==='DELETE')return respond(res,200,backups.cancel());
      if(route==='/api/messages/trace'&&method==='GET'){const row=store.prepare('SELECT groupId,messageId FROM messages WHERE id=?').get(Number(url.searchParams.get('id')));if(!row)throw error(404,'消息不存在');return respond(res,200,store.traceReport(row.groupId,row.messageId));}
      if (route === '/api/messages' && method === 'GET') return respond(res, 200, store.messages(Object.fromEntries(url.searchParams)));
      if (route === '/api/messages' && method === 'DELETE') return respond(res, 200, store.deleteMessages(jsonBody(await body(req, 50000))));
      if ((route === '/api/messages/export' && method === 'GET') || (route === '/api/export' && method === 'POST')) {
        const query = method === 'GET' ? Object.fromEntries(url.searchParams) : jsonBody(await body(req, 4096));
        const out = [], batchSize = 10000; let before;
        do { const batch = store.messages({ groupId: query.groupId, limit: batchSize, before }).items; if (!batch.length) break; out.unshift(...batch); before = batch[0].id; if (batch.length < batchSize) break; } while (out.length < 200000);
        if (out.length >= 200000) throw error(400, '记录过多，请按群分别导出');
        const name = 'history-' + Date.now() + '.json';
        const exported = { app: 'Unusual', version: 1, exportedAt: new Date().toISOString(), messages: out };
        // Export always lands under the application's data folder, not Downloads.
        store.paths.writeJson('data/exports/' + name, exported);
        if (method === 'POST') return respond(res, 200, { name, count: out.length, path: `data/exports/${name}` });
        return respond(res, 200, exported, { 'Content-Disposition': `attachment; filename="${name}"` });
      }
      if (route === '/api/preview' && method === 'POST') {
        rateLimit('preview', 30, 60000);
        return respond(res, 200, await engine.preview(jsonBody(await body(req, 100000))));
      }
      if (route === '/api/send' && method === 'POST') return respond(res, 200, await engine.manualSend(jsonBody(await body(req, 50000))));
      if (route === '/api/proactive' && method === 'POST') return respond(res, 200, await engine.proactive(jsonBody(await body(req, 4096)).groupId));
      if (route === '/api/logs' && method === 'GET') return respond(res, 200, { items: store.logs() });
      if(route==='/api/emoji/bundle' && method==='POST') return respond(res,200,importBundle(store,media));
      if (route === '/api/emoji' && method === 'GET') return respond(res, 200, { items: media.listEmoji(),bundleEnabled:bundleEnabled(store) });
      if (route === '/api/emoji' && method === 'POST') return respond(res, 201, media.upload(jsonBody(await body(req))));
      if (route === '/api/emoji' && method === 'PUT') return respond(res, 200, media.setTags(jsonBody(await body(req, 8192))));
      if (route === '/api/emoji' && method === 'DELETE') return respond(res, 200, media.remove(jsonBody(await body(req, 4096)).name));
      if (route.startsWith('/media/') && method === 'GET') {
        const parts = route.split('/'); if (parts.length !== 4) throw error(404, '文件不存在');
        const result = media.read(parts[2], decodeURIComponent(parts[3]));
        res.writeHead(200, { 'Content-Type': result.mime, 'Cache-Control': 'private, max-age=60' }); return res.end(result.buffer);
      }
      if(route==='/api/voice/billing'&&method==='GET')return respond(res,200,await providers.breezeBilling(store.config.voice));
      if(route==='/api/input-estimate'&&method==='GET')return respond(res,200,engine.inputEstimate(url.searchParams.get('groupId')||'',url.searchParams.get('personaId')||''));
      if(route==='/api/provider-models'&&method==='GET'){const p=store.config.providers.find(p=>p.id===url.searchParams.get('id'));if(!p)throw error(404,'接口不存在');const cached=store.getMeta('models:'+p.id,null);return respond(res,200,cached?.baseUrl===p.baseUrl&&cached.type===p.type?cached:{models:[]});}
      if(route==='/api/provider-models/sync'&&method==='POST'){const d=jsonBody(await body(req,4096));const p=store.config.providers.find(p=>p.id===d.id);if(!p)throw error(404,'接口不存在');const models=await providers.listModels(p);if(JSON.stringify(p)!==JSON.stringify(store.config.providers.find(v=>v.id===p.id)))throw error(409,'接口配置已改变，请重试');const value={models,at:new Date().toISOString(),baseUrl:p.baseUrl,type:p.type};store.setMeta('models:'+p.id,value);return respond(res,200,value);}
      if(route==='/api/voice/decisions'&&method==='GET')return respond(res,200,{items:store.config.groups.map(g=>({groupId:g.id,name:g.name,...store.getMeta('voice:last:'+g.id,{status:'暂无真实语音生成记录'})}))});
      if(route==='/api/voice/models'&&method==='GET')return respond(res,200,{models:store.getMeta(voiceLibrary.key()+':models',[])});
      if(route==='/api/voice/models/sync'&&method==='POST'){const key=voiceLibrary.key();const models=await providers.listBreezeModels(store.config.voice);if(key!==voiceLibrary.key())throw error(409,'密钥已改变，请重试');store.setMeta(key+':models',models);return respond(res,200,{models});}
      if(route==='/api/voice/library'&&method==='GET')return respond(res,200,voiceLibrary.read());
      if(route==='/api/voice/library/sync'&&method==='POST')return respond(res,200,await voiceLibrary.sync());
      if(route==='/api/voice/library/favorite'&&method==='POST'){const d=jsonBody(await body(req,4096));if(typeof d.id!=='string'||typeof d.favorite!=='boolean')throw error(400,'收藏参数无效');return respond(res,200,voiceLibrary.favorite(d.id,d.favorite));}
      if(route==='/api/voice/voices'&&method==='GET') {
        const query=new URL(req.url,'http://localhost').searchParams;
        return respond(res,200,await providers.listBreezeVoices(store.config.voice,{page:query.get('page'),search:query.get('search'),favorites:query.get('favorites')==='true',language:query.get('language')||'all'}));
      }
      if (route === '/api/voice/test' && method === 'POST') {
        const data = jsonBody(await body(req, 4096));
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 500) throw error(400, '试音文本需为 1～500 字');
        if (!store.config.voice.enabled) throw error(400, '请先启用并保存语音接口');
        const result = await providers.synthesize(store.config.voice, data.text);
        const saved = media.saveAudio(result.buffer, result.extension);
        return respond(res, 200, { name: saved.name, url: saved.url, billing:result.billing||null });
      }
      if (route === '/api/token/rotate' && method === 'POST') {
        const { kind } = jsonBody(await body(req, 4096)), c = store.config, next = token();
        if (kind === 'api') c.api.token = next; else if (kind === 'webhook') c.onebot.webhookToken = next; else throw error(400, '未知令牌类型');
        store.saveConfig(c); return respond(res, 200, { token: next });
      }
      if (route === '/api/shutdown' && method === 'POST') {
        respond(res, 200, { ok: true }); setTimeout(() => close(), 200); return;
      }
      throw error(404, '接口不存在');
    } catch (e) {
      if (res.headersSent) return res.destroy();
      const status = e.status || (e.code === 'ENOENT' ? 404 : 400);
      if (status !== 401 && status !== 404) store.log('error', 'http.error', e.message);
      respond(res, status, { error: e.message || '请求失败' });
    } finally {
      activeHandlers--;
      if (!activeHandlers) for (const resolve of drainWaiters.splice(0)) resolve();
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.on('clientError', (_e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  actualPort = server.address().port;
  store.paths.writeJson('data/runtime.json', { pid: process.pid, port: actualPort, adminToken, startedAt: new Date().toISOString(), url: `http://127.0.0.1:${actualPort}/#key=${adminToken}` });
  store.log('info', 'app.started', '本机服务已启动，仅监听 127.0.0.1');
  if (startEngine) {engine.start();official.start();}
  const moments=new Moments(store,providers,media,()=>!closed && bridge.connected && store.configView.bot.enabled);
  let momentsJob=null;
  const momentsTimer=setInterval(()=>{if(startEngine && !momentsJob)momentsJob=moments.tick().catch(err=>store.log('error','moments',err.message)).finally(()=>{momentsJob=null;});},30000);
  momentsTimer.unref();
  let replyJob=null;
  const commentSchedule=new CommentSchedule();
  const replyTimer=setInterval(()=>{
    if(!startEngine||replyJob||closed||!moments.state().repliesEnabled||!bridge.connected||!store.configView.bot.enabled)return;
    if(!commentSchedule.due(Date.now(),moments.state().revision))return;
    replyJob=pollMomentComments(moments).then(result=>{
      store.setMeta('moments:pollStatus',commentSchedule.complete(Date.now(),result));
    }).catch(err=>{
      store.setMeta('moments:pollStatus',commentSchedule.complete(Date.now(),null,true));
      store.setMeta('moments:replyStatus',{at:Date.now(),status:'检查或回复失败',error:err.message});
    }).finally(()=>{replyJob=null;});
  },30000);
  replyTimer.unref();
  const maintenance = setInterval(() => { try { store.prune(); media.prune(); } catch (e) { store.log('error', 'maintenance.failed', e.message); } }, 3600000);
  maintenance.unref();
  let monitorJob = null;
  const qqMonitor = setInterval(() => {
    if (closed || !startEngine || monitorJob) return;
    if (!napcat.managed()?.enabled) {
      const config=store.configView;
      if(!config.groups.some(group=>group.enabled&&group.channel!=='official') && !moments.state().enabled) return;
      if(Date.now()-Date.parse(bridge.lastCheckedAt||'1970-01-01T00:00:00Z')<60000) return;
      monitorJob=checkBridge().catch(()=>{}).finally(()=>{monitorJob=null;});
      return;
    }
    if (store.configView.onebot.baseUrl !== napcat.apiUrl) return;
    monitorJob = (async () => {
      const q = await napcat.status();
      if (!q.isLogin) bridge = { ...bridge, connected:false };
      else if (!bridge.connected || Date.now()-Date.parse(bridge.lastCheckedAt || 0)>60000) {
        try { await checkBridge(); } catch {}
      }
    })().catch(() => {}).finally(() => { monitorJob = null; });
  }, 15000);
  qqMonitor.unref();
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      moments.closed=true;clearInterval(replyTimer);if(replyJob)await replyJob;clearInterval(momentsTimer);if(momentsJob)await momentsJob;clearInterval(maintenance); clearInterval(qqMonitor);official.stop();await official.drain();
      if (monitorJob) await monitorJob;
      const socketsClosed = new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      await engine.stop();
      await socketsClosed;
      if (activeHandlers) await new Promise(resolve => drainWaiters.push(resolve));
      store.log('info', 'app.stopped', '本机服务已停止');
      try { fs.unlinkSync(store.paths.resolve('data/runtime.json')); } catch {}
      store.close();
      if (Number(process.env.QILIAO_PARENT_PID) === process.ppid) process.stdin.destroy();
    })();
    return closePromise;
  }
  return { server, store, engine, media, official, port: actualPort, adminToken, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = await createApp({port:process.env.QILIAO_DESKTOP_TEST==='1'&&process.env.QILIAO_UI_ONLY==='1'?4210:3210});
    if (Number(process.env.QILIAO_PARENT_PID) === process.ppid) { process.stdin.once('end', () => app.close().then(() => process.exit(0))); process.stdin.resume(); }
    console.log(`Unusual已启动：http://127.0.0.1:${app.port}/ （请通过启动入口进入）`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
  } catch (e) { console.error('启动失败：' + e.message); process.exitCode = 1; }
}
