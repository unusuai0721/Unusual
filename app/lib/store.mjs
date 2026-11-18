import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AppPaths } from './paths.mjs';
import { defaultConfig, validateConfig } from './config.mjs';

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' });
const dayKey = date => dayFormatter.format(date);
const freeze = value => { if(value && typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value; };
export class Store {
  constructor(root) {
    this.paths = new AppPaths(root);
    const file = this.paths.resolve('data/config.json');
    if (fs.existsSync(file)) {
      try { this._config = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch (e) { throw new Error(`配置读取失败，原文件已保留：${e.message}`); }
    } else { this._config = defaultConfig(); this.paths.writeJson('data/config.json', this._config); }
    // Refuse redirected SQLite sidecars before SQLite opens them.
    for (const name of ['history.sqlite', 'history.sqlite-wal', 'history.sqlite-shm', 'history.sqlite-journal']) this.paths.resolve(`data/${name}`);
    this.db = new DatabaseSync(this.paths.resolve('data/history.sqlite'), { allowExtension: false });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, groupId TEXT NOT NULL, senderId TEXT NOT NULL DEFAULT '', senderName TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, messageId TEXT, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_group ON messages(groupId,id DESC);
      CREATE INDEX IF NOT EXISTS messages_time ON messages(createdAt);
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, providerId TEXT, groupId TEXT, inputTokens INTEGER, outputTokens INTEGER, estimated INTEGER, kind TEXT, day TEXT, createdAt TEXT);
      CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, level TEXT, event TEXT, detail TEXT, createdAt TEXT);
      CREATE TABLE IF NOT EXISTS message_trace (id INTEGER PRIMARY KEY, groupId TEXT NOT NULL, messageId TEXT NOT NULL, stage TEXT NOT NULL, detail TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trace_message ON message_trace(groupId,messageId,id);
      CREATE INDEX IF NOT EXISTS trace_time ON message_trace(createdAt);
      CREATE INDEX IF NOT EXISTS messages_identity ON messages(groupId,messageId);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this._config = freeze(this._config);
    this.statements = new Map();
    this.prune();
  }
  // Internal readers share an immutable snapshot; editor/API callers still receive copies.
  get configView() { return this._config; }
  prepare(sql) { let stmt=this.statements.get(sql);if(!stmt){stmt=this.db.prepare(sql);if(this.statements.size>=64)this.statements.delete(this.statements.keys().next().value);this.statements.set(sql,stmt);}return stmt; }
  get config() { return structuredClone(this._config); }
  saveConfig(config) {
    const next = validateConfig(config);
    this.paths.writeJson('data/config.previous.json', this._config);
    this.paths.writeJson('data/config.json', next);
    this._config = freeze(next);
    this.log('info', 'config.saved', '配置已更新');
    return this.config;
  }
  addMessage(m) {
    const createdAt = new Date().toISOString();
    const row = { groupId: String(m.groupId), senderId: String(m.senderId || ''), senderName: String(m.senderName || '').slice(0, 200), role: m.role || 'user', content: String(m.content || '').slice(0, 40000), source: m.source || 'qq', status: m.status || 'received', messageId: m.messageId == null ? null : String(m.messageId), createdAt };
    const r = this.prepare('INSERT INTO messages(groupId,senderId,senderName,role,content,source,status,messageId,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
    return { id: Number(r.lastInsertRowid), ...row };
  }
  messages({ groupId, q, limit = 100, before, senderId, source, status, from, to } = {}) {
    const where = [], params = [];
    if (groupId) { where.push('groupId=?'); params.push(String(groupId)); }
    for(const [key,value,allowed] of [['source',source,['qq','preview','api','manual']],['status',status,['received','sent','failed','generated']]]){if(value){if(!allowed.includes(value))throw Object.assign(new Error('记录筛选值无效'),{status:400});where.push(key+'=?');params.push(value);}}
    if(senderId){where.push('senderId=?');params.push(String(senderId));}
    const date=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw Object.assign(new Error('日期格式无效'),{status:400});return Date.parse(value+'T00:00:00+08:00');};
    if(from){where.push('createdAt>=?');params.push(new Date(date(from)).toISOString());}
    if(to){where.push('createdAt<?');params.push(new Date(date(to)+86400000).toISOString());}
    if(from&&to&&from>to)throw Object.assign(new Error('开始日期不能晚于结束日期'),{status:400});
    if (q) { where.push("(content LIKE ? ESCAPE '\\' OR senderName LIKE ? ESCAPE '\\')"); const v = `%${String(q).slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`; params.push(v, v); }
    if (before) { where.push('id<?'); params.push(Number(before) || 0); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = this.prepare('SELECT COUNT(*) AS n FROM messages' + clause).get(...params).n;
    const n = Math.min(10000, Math.max(1, Number(limit) || 100));
    const items = this.prepare('SELECT * FROM messages' + clause + ' ORDER BY id DESC LIMIT ?').all(...params, Math.trunc(n)).reverse();
    return { items, total };
  }
  messageById(groupId, messageId) {
    return this.prepare("SELECT * FROM messages WHERE groupId=? AND messageId=? AND status IN ('received','sent') ORDER BY id DESC LIMIT 1").get(String(groupId),String(messageId))||null;
  }
  context(groupId, limit) {
    const after = this.getMeta('context:after:' + groupId, 0);
    return this.prepare("SELECT * FROM messages WHERE groupId=? AND id>? AND status!='failed' ORDER BY id DESC LIMIT ?").all(String(groupId), after, Math.min(200, Math.max(0, limit))).reverse();
  }
  resetContext(groupId) {
    const last=this.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id;
    this.setMeta('context:after:'+groupId, last);
    this.setMeta('context:reinforce:'+groupId,true);
    this.setMeta('context:revision:'+groupId, this.getMeta('context:revision:'+groupId,0)+1);
    this.log('info','context.reset','已重新应用人设，历史记录保留：'+groupId);
    return {ok:true,historyPreserved:true};
  }
  deleteMessages({ groupId, ids } = {}) {
    if(ids&&(!Array.isArray(ids)||ids.length>1000||!ids.every(v=>Number.isSafeInteger(v)&&v>0)))throw new Error('记录 ID 不合法');
    if(ids&&!ids.length)return {deleted:0};
    this.db.exec('BEGIN IMMEDIATE');
    try{
      let deleted;
      if(ids){const slots=ids.map(()=>'?').join(',');this.prepare('DELETE FROM message_trace WHERE EXISTS (SELECT 1 FROM messages m WHERE m.id IN ('+slots+') AND m.groupId=message_trace.groupId AND m.messageId=message_trace.messageId)').run(...ids);deleted=Number(this.prepare('DELETE FROM messages WHERE id IN ('+slots+')').run(...ids).changes);}
      else{this.prepare(groupId?'DELETE FROM message_trace WHERE groupId=?':'DELETE FROM message_trace').run(...(groupId?[String(groupId)]:[]));deleted=Number(this.prepare(groupId?'DELETE FROM messages WHERE groupId=?':'DELETE FROM messages').run(...(groupId?[String(groupId)]:[])).changes);}
      this.db.exec('COMMIT');return {deleted};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  traceReport(groupId,messageId){
    const items=this.messageTrace(groupId,messageId),related=[],visited=new Set([String(messageId)]);let current=items;
    for(let i=0;i<8;i++){const merged=current.findLast(x=>x.stage==='merged');const target=merged?.detail?.split('ID：').at(-1);if(!target||visited.has(target))break;visited.add(target);current=this.messageTrace(groupId,target);related.push({messageId:target,items:current});}
    const all=[...items,...related.flatMap(x=>x.items)].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    return {items,related,elapsedMs:all.length>1?Math.max(0,Date.parse(all.at(-1).createdAt)-Date.parse(all[0].createdAt)):null};
  }
  recordTrace(groupId,messageId,stage,detail='') {
    if(!messageId)return;
    let text=String(detail);const c=this._config;
    for(const secret of [...c.providers.map(p=>p.apiKey),c.api.token,c.official?.appSecret,c.onebot.accessToken,c.onebot.webhookToken,c.onebot.secret,c.search.apiKey,c.voice.apiKey].filter(Boolean))text=text.split(secret).join('[已隐藏]');
    const row=this.prepare('INSERT INTO message_trace(groupId,messageId,stage,detail,createdAt) VALUES(?,?,?,?,?)').run(String(groupId),String(messageId),String(stage),text.slice(0,600),new Date().toISOString());
    if(Number(row.lastInsertRowid)%100===0)this.prepare('DELETE FROM message_trace WHERE id < ?').run(Number(row.lastInsertRowid)-10000);
  }
  messageTrace(groupId,messageId){return this.prepare('SELECT stage,detail,createdAt FROM message_trace WHERE groupId=? AND messageId=? ORDER BY id LIMIT 100').all(String(groupId),String(messageId));}
  recordUsage(u) {
    this.usageCache = null;
    const n = v => Math.max(0, Math.ceil(Number(v) || 0));
    this.prepare('INSERT INTO usage(providerId,groupId,inputTokens,outputTokens,estimated,kind,day,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(u.providerId || '', u.groupId || '', n(u.inputTokens), n(u.outputTokens), u.estimated ? 1 : 0, u.kind || 'chat', dayKey(new Date()), new Date().toISOString());
  }
  todayUsage() {
    const day=dayKey(new Date());if(this.usageCache?.day===day)return {...this.usageCache.value};
    const r = this.prepare('SELECT COALESCE(SUM(inputTokens),0) AS inputTokens,COALESCE(SUM(outputTokens),0) AS outputTokens,COUNT(*) AS calls,COALESCE(SUM(estimated),0) AS estimatedCalls FROM usage WHERE day=?').get(day);
    const value={...r,totalTokens:r.inputTokens+r.outputTokens};this.usageCache={day,value};return {...value};
  }
  log(level, event, detail = '') {
    let value = typeof detail === 'string' ? detail : JSON.stringify(detail);
    const c = this._config;
    const secrets = [...c.providers.map(p => p.apiKey), c.api.token, c.official?.appSecret, c.onebot.accessToken, c.onebot.webhookToken, c.onebot.secret, c.search.apiKey, c.voice.apiKey].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of secrets) value = value.split(secret).join('[已隐藏]');
    this.prepare('INSERT INTO logs(level,event,detail,createdAt) VALUES(?,?,?,?)').run(String(level), String(event), value.slice(0, 2000), new Date().toISOString());
  }
  logs(limit = 100) { return this.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))); }
  summary() { return { messageCount: this.prepare('SELECT COUNT(*) AS n FROM messages').get().n, groupCount: this._config.groups.length, todayUsage: this.todayUsage() }; }
  getMeta(key, fallback = null) { const r = this.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  setMeta(key, value) { this.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  prune() {
    this.usageCache = null;
    const cutoff = new Date(Date.now() - this._config.budget.retentionDays * 86400000).toISOString();
    this.prepare('DELETE FROM messages WHERE createdAt<?').run(cutoff);
    this.prepare('DELETE FROM message_trace WHERE createdAt<?').run(cutoff);
    this.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 3000)').run();
    this.prepare('DELETE FROM usage WHERE createdAt<?').run(new Date(Date.now() - 365 * 86400000).toISOString());
  }
  close() { this.statements.clear(); this.db.close(); }
}
