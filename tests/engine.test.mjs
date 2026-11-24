import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../app/lib/engine.mjs';
import { defaultConfig } from '../app/lib/config.mjs';
import { parseOneBotEvent } from '../app/lib/adapters.mjs';

class FakeStore {
  constructor(config) { this.value = structuredClone(config); this.rows = []; this.usage = []; this.events = []; this.traces=[]; this.meta = new Map(); }
  get config() { return structuredClone(this.value); }
  saveConfig(config) { this.value = structuredClone(config); }
  change(fn) { const config = this.config; fn(config); this.saveConfig(config); }
  addMessage(message) {
    const row = { id: this.rows.length + 1, senderId: '', senderName: '', createdAt: new Date().toISOString(), ...message };
    this.rows.push(row); return row;
  }
  context(groupId, limit) { return limit === 0 ? [] : this.rows.filter(row => row.groupId === groupId && row.status !== 'failed').slice(-limit); }
  messageById(groupId,messageId) { return this.rows.findLast(row=>row.groupId===groupId&&row.messageId===messageId&&['received','sent'].includes(row.status)); }
  recordTrace(groupId,messageId,stage,detail){this.traces.push({groupId,messageId,stage,detail});}
  recordUsage(usage) { this.usage.push(usage); }
  todayUsage() {
    const inputTokens = this.usage.reduce((n, item) => n + item.inputTokens, 0);
    const outputTokens = this.usage.reduce((n, item) => n + item.outputTokens, 0);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, calls: this.usage.length };
  }
  getMeta(key, fallback = null) { return this.meta.has(key) ? structuredClone(this.meta.get(key)) : fallback; }
  setMeta(key, value) { this.meta.set(key, structuredClone(value)); }
  log(level, event, detail = '') { this.events.push({ level, event, detail }); }
}

function makeConfig() {
  const config = defaultConfig();
  config.bot.enabled = true;
  config.bot.selfId = '900';
  config.providers[0].apiKey = 'fake-provider-secret';
  config.personas.push({id:'default',name:'测试人设',prompt:'你是小星，简短自然地交流。',temperature:0.8});
  config.defaultPersonaId='default';
  config.groups = [{ id: '123', name: '测试群', enabled: true, personaId: 'default', providerId: 'deepseek',
    replyMode: 'smart', keywords: ['小星'], replyProbability: 0, cooldownSec: 0, debounceSec: 0,
    mentionReply: true, ignoreUserIds: [], maxRepliesPerHour: 100, quietStart: '', quietEnd: '',
    proactive: { enabled: false, intervalMin: 1, prompt: '发起一个新话题。' }, autoEmoji: true, autoVoice: false }];
  return config;
}

function event(text = '小星，你好', messageId = '1', overrides = {}) {
  return { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: '123',
    user_id: '777', self_id: '900', message_id: messageId,
    sender: { nickname: '群友' }, message: [{ type: 'text', data: { text } }], ...overrides };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(t, configure = () => {}) {
  const config = makeConfig(); configure(config);
  const store = new FakeStore(config);
  const calls = { generate: [], send: [], search: [], synthesize: [], emoji: [], audio: [] };
  let now = Date.parse('2026-10-23T04:00:00Z'); // 12:00 Beijing, independent of host timezone.
  const adapters = {
    parseOneBotEvent,
    async generate(provider, input) { calls.generate.push({ provider, ...input }); return { text: '你好呀！', inputTokens: 100, outputTokens: 20, estimated: false }; },
    async onebotCall(config, action, params) { calls.send.push({ config, action, params }); return { message_id: String(calls.send.length) }; },
    async searchWeb(config, query) { calls.search.push({ config, query }); return [{ title: '资料', url: 'https://example.com/item', content: '可核验的示例内容。' }]; },
    async synthesize(config, text) { calls.synthesize.push({ config, text }); return { buffer: Buffer.from('fake audio'), extension: 'mp3', mime: 'audio/mpeg' }; },
  };
  const media = {
    async listEmoji() { return [{ name: 'happy.png', tags: ['开心'], url: '/media/emoji/happy.png' }]; },
    async emojiSegment(name) { calls.emoji.push(name); return { type: 'image', data: { file: 'base64://aGVsbG8=' } }; },
    async saveAudio(buffer, extension) { calls.audio.push({ buffer, extension }); return { name: 'test.mp3', segment: { type: 'record', data: { file: 'base64://aGVsbG8=' } } }; },
  };
  const options = { adapters, media, now: () => now, random: () => 0.5 };
  const engine = new Engine(store, options);
  engine.start();
  t.after(() => engine.stop());
  return { engine, store, calls, adapters, media, options, setNow: value => { now = value; }, advance: value => { now += value; }, now: () => now };
}

async function settle(engine) {
  await delay(15);
  await Promise.allSettled([...engine.locks.values()]);
}

test('receive enforces allowlist, self/bot/ignored filtering, and persisted event deduplication', async t => {
  const f = fixture(t, c => { c.groups[0].ignoreUserIds = ['888']; c.bot.enabled = false; });
  assert.equal((await f.engine.receive(event('hello', '1', { group_id: '999' }))).reason, 'group_disabled');
  assert.equal((await f.engine.receive(event('hello', '2', { user_id: '900' }))).reason, 'self_or_bot');
  assert.equal((await f.engine.receive(event('hello', '3', { sender: { is_bot: true } }))).reason, 'self_or_bot');
  assert.equal((await f.engine.receive(event('hello', '4', { user_id: '888' }))).reason, 'ignored_user');
  assert.equal(f.store.rows.length, 0);
  assert.deepEqual(await f.engine.receive(event('记录但不回应', '5')), { accepted: true, reason: 'paused' });
  assert.equal((await f.engine.receive(event('重复', '5'))).reason, 'duplicate');
  assert.equal(f.store.rows.length, 1);
  await f.engine.stop();
  const restarted = new Engine(f.store, f.options); restarted.start(); t.after(() => restarted.stop());
  assert.equal((await restarted.receive(event('重启后的重复', '5'))).reason, 'duplicate');
  assert.equal(f.calls.generate.length, 0);
});

test('smart mode replies without @ using local keyword/probability, without model calls for unrelated messages', async t => {
  const f = fixture(t);
  assert.equal((await f.engine.receive(event('大家午饭吃什么', '1'))).reason, 'not_triggered');
  await settle(f.engine);
  assert.equal(f.calls.generate.length, 0);
  await f.engine.receive(event('小星，午饭推荐什么', '2'));
  await settle(f.engine);
  assert.equal(f.calls.generate.length, 1);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.store.rows.at(-1).status, 'sent');
  f.store.change(c => { c.groups[0].replyProbability = 0.8; });
  await f.engine.receive(event('今天的天气真好', '3'));
  await settle(f.engine);
  assert.equal(f.calls.generate.length, 2);
});

test('all, mention and keywords modes honor their local trigger policy', async t => {
  const f = fixture(t, c => { c.groups[0].debounceSec = 60; });
  f.store.change(c => { c.groups[0].replyMode = 'mention'; });
  assert.equal((await f.engine.receive(event('小星，你好', '1'))).reason, 'not_triggered');
  const mention = event('', '2', { message: [{ type: 'at', data: { qq: '900' } }, { type: 'text', data: { text: '你好' } }] });
  assert.equal((await f.engine.receive(mention)).reason, 'scheduled');
  await f.engine.stop(); f.engine.start();
  f.store.change(c => { c.groups[0].mentionReply = false; });
  assert.equal((await f.engine.receive({ ...mention, message_id: '3' })).reason, 'not_triggered');
  f.store.change(c => { c.groups[0].replyMode = 'keywords'; c.groups[0].replyProbability = 1; });
  assert.equal((await f.engine.receive(event('没有关键词', '4'))).reason, 'not_triggered');
  assert.equal((await f.engine.receive(event('小星你好', '5'))).reason, 'scheduled');
  await f.engine.stop(); f.engine.start();
  f.store.change(c => { c.groups[0].replyMode = 'all'; });
  assert.equal((await f.engine.receive(event('普通群聊', '6'))).reason, 'scheduled');
  assert.equal(f.calls.generate.length, 0);
});

test('debounce merges a burst into one reply and includes all received messages in context', async t => {
  const f = fixture(t);
  await f.engine.receive(event('小星，先听我说', '1'));
  await f.engine.receive(event('我还没有说完', '2'));
  await f.engine.receive(event('现在说完了', '3'));
  assert.deepEqual(f.engine.status().pendingGroups, ['123']);
  await settle(f.engine);
  assert.equal(f.calls.generate.length, 1);
  assert.equal(f.calls.send.length, 1);
  const input = f.calls.generate[0].messages.map(item => item.content).join('\n');
  assert.match(input, /先听我说/);
  assert.match(input, /现在说完了/);
  assert.deepEqual(f.engine.status().pendingGroups, []);
});

test('quiet hours use Beijing time including overnight windows and block mention/manual/proactive', async t => {
  const f = fixture(t, c => { c.groups[0].quietStart = '23:00'; c.groups[0].quietEnd = '08:00'; });
  f.setNow(Date.parse('2026-10-23T16:30:00Z'));
  assert.equal((await f.engine.receive(event())).reason, 'quiet_hours');
  await assert.rejects(f.engine.manualSend({ groupId: '123', text: '你好' }), { code: 'quiet_hours' });
  await assert.rejects(f.engine.proactive('123'), { code: 'quiet_hours' });
  f.setNow(Date.parse('2026-10-24T00:00:00Z'));
  await f.engine.manualSend({ groupId: '123', text: '早上好' });
  assert.equal(f.calls.send.length, 1);
});

test('cooldown and persisted hourly cap include manual and proactive sends', async t => {
  const f = fixture(t, c => { c.groups[0].cooldownSec = 60; c.groups[0].maxRepliesPerHour = 2; });
  await f.engine.manualSend({ groupId: '123', text: '第一条' });
  await assert.rejects(f.engine.proactive('123'), { code: 'cooldown' });
  f.advance(60000);
  await f.engine.proactive('123');
  f.advance(60000);
  await assert.rejects(f.engine.manualSend({ groupId: '123', text: '第三条' }), { code: 'hourly_limit' });
  await f.engine.stop();
  const restarted = new Engine(f.store, f.options); restarted.start(); t.after(() => restarted.stop());
  await assert.rejects(restarted.proactive('123'), { code: 'hourly_limit' });
  f.advance(60 * 60 * 1000);
  await restarted.manualSend({ groupId: '123', text: '下一个小时' });
  assert.equal(f.calls.send.length, 3);
});

test('proactive schedule persists across restart and never sends an overdue message at boot', async t => {
  const f = fixture(t, c => { c.groups[0].proactive.enabled = true; });
  const firstDue = f.store.getMeta('engine:group:123').nextProactiveAt;
  assert.equal(firstDue, f.now() + 60000);
  assert.equal(f.calls.send.length, 0);
  f.advance(30000);
  await f.engine.stop(); f.engine.start();
  assert.equal(f.store.getMeta('engine:group:123').nextProactiveAt, firstDue);
  f.advance(30000);
  f.engine._tick(); await settle(f.engine);
  assert.equal(f.calls.send.length, 1);
  await f.engine.stop();
  f.advance(5 * 60000);
  f.engine.start(); f.engine._tick(); await settle(f.engine);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.store.getMeta('engine:group:123').nextProactiveAt, f.now() + 60000);
});

test('pause while model is in flight records usage and failed history but never sends QQ', async t => {
  const f = fixture(t);
  const gate = deferred(); const entered = deferred();
  f.adapters.generate = async () => { entered.resolve(); return gate.promise; };
  const request = f.engine.proactive('123');
  await entered.promise;
  f.store.change(c => { c.bot.enabled = false; });
  gate.resolve({ text: '迟到的消息', inputTokens: 42, outputTokens: 12, estimated: false });
  await assert.rejects(request, { code: 'paused' });
  assert.equal(f.store.todayUsage().totalTokens, 54);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.store.rows.at(-1).status, 'failed');
  assert.equal(f.engine.status().lastReplyAt, null);
});

test('changing persona/group policy during generation cancels the completed draft', async t => {
  const f = fixture(t);
  const gate = deferred(); const entered = deferred();
  f.adapters.generate = async () => { entered.resolve(); return gate.promise; };
  const request = f.engine.proactive('123');
  await entered.promise;
  f.store.change(c => { c.personas[0].prompt = '这是更新后的人设'; });
  gate.resolve({ text: '旧人设内容', inputTokens: 10, outputTokens: 5, estimated: false });
  await assert.rejects(request, { code: 'settings_changed' });
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.store.todayUsage().calls, 1);
});

test('stop awaits in-flight work, invalidates QQ drafts, and rejects newly queued work', async t => {
  const f = fixture(t);
  const gate = deferred(); const entered = deferred();
  f.adapters.generate = async () => { entered.resolve(); return gate.promise; };
  const request = f.engine.proactive('123');
  const rejection = assert.rejects(request, { code: 'paused' });
  await entered.promise;
  let stopped = false;
  const stop = f.engine.stop().then(() => { stopped = true; });
  await delay(5);
  assert.equal(stopped, false);
  await assert.rejects(f.engine.preview({ message: '不能新增' }), { code: 'stopping' });
  gate.resolve({ text: '已取消', inputTokens: 10, outputTokens: 2, estimated: false });
  await Promise.all([stop, rejection]);
  assert.equal(stopped, true);
  assert.equal(f.calls.send.length, 0);
});

test('preview/API use isolated history sessions and never send QQ', async t => {
  const f = fixture(t);
  await f.engine.preview({ message: '预览私有内容', sessionId: 'same' });
  await f.engine.apiChat({ message: 'API 私有内容', sessionId: 'same' });
  await f.engine.preview({ message: '预览第二句', sessionId: 'same' });
  const apiContext = f.calls.generate[1].messages.map(item => item.content).join('\n');
  assert.doesNotMatch(apiContext, /预览私有内容/);
  const previewContext = f.calls.generate[2].messages.map(item => item.content).join('\n');
  assert.match(previewContext, /预览私有内容/);
  assert.doesNotMatch(previewContext, /API 私有内容/);
  assert.equal(f.calls.send.length, 0);
  assert.ok(f.store.rows.every(row => row.groupId.startsWith('__')));
  assert.ok(f.store.rows.filter(row => row.role === 'assistant').every(row => row.status === 'generated'));
  await assert.rejects(f.engine.preview({ message: 'x', sessionId: '../123' }), /会话 ID/);
  f.store.change(c => { c.api.enabled = false; });
  await assert.rejects(f.engine.apiChat({ message: 'x' }), { code: 'api_disabled' });
});

test('per-session locking preserves history order while independent sessions can run concurrently', async t => {
  const f = fixture(t);
  const gate = deferred(); const entered = deferred();
  const normal = f.adapters.generate;
  let count = 0;
  f.adapters.generate = async (provider, input) => {
    count++;
    if (count === 1) { f.calls.generate.push({ provider, ...input }); entered.resolve(); return gate.promise; }
    return normal(provider, input);
  };
  const first = f.engine.preview({ message: '第一句', sessionId: 'serial' });
  await entered.promise;
  const second = f.engine.preview({ message: '第二句', sessionId: 'serial' });
  await delay(5);
  assert.equal(count, 1);
  const other = await f.engine.preview({ message: '独立会话', sessionId: 'other' });
  assert.equal(other.sessionId, 'other');
  gate.resolve({ text: '第一句的答复', inputTokens: 10, outputTokens: 2 });
  await Promise.all([first, second]);
  assert.deepEqual(f.calls.generate.at(-1).messages.map(item => item.content), ['第一句', '第一句的答复', '第二句']);
});

test('concurrent sessions reserve a shared daily budget and release it after completion', async t => {
  const f = fixture(t, c => { c.budget.dailyTokenLimit = 1600; });
  const gate = deferred(); const entered = deferred();
  f.adapters.generate = async () => { entered.resolve(); return gate.promise; };
  const first = f.engine.preview({ message: '你好', sessionId: 'one' });
  await entered.promise;
  assert.ok(f.engine.reservedTokens > 800);
  await assert.rejects(f.engine.apiChat({ message: '你好', sessionId: 'two' }), { code: 'daily_budget' });
  gate.resolve({ text: '你好', inputTokens: 10, outputTokens: 5, estimated: false });
  await first;
  assert.equal(f.engine.reservedTokens, 0);
  assert.equal(f.store.todayUsage().calls, 1);
});

test('failed provider requests keep conservative estimated usage and cannot bypass the daily cap', async t => {
  const f = fixture(t, c => { c.budget.dailyTokenLimit = 1600; });
  f.adapters.generate = async () => { throw new Error('上游超时 fake-provider-secret'); };
  await assert.rejects(f.engine.preview({ message: '你好' }), /上游超时/);
  assert.equal(f.engine.reservedTokens, 0);
  assert.equal(f.store.usage[0].estimated, true);
  assert.match(f.store.usage[0].kind, /failed/);
  assert.ok(f.store.todayUsage().totalTokens > 800);
  await assert.rejects(f.engine.preview({ message: '再来一次' }), { code: 'daily_budget' });
  assert.ok(f.store.events.every(row => !row.detail.includes('fake-provider-secret')));
});

test('input/output/context limits are enforced without truncating essential persona instructions', async t => {
  const f = fixture(t, c => { c.budget.maxInputTokens = 1600; c.budget.maxOutputTokens = 73; c.budget.contextMessages = 2; });
  await f.engine.preview({ message: '旧话题', sessionId: 'budget' });
  await f.engine.preview({ message: '很长的消息'.repeat(2000), sessionId: 'budget' });
  const request = f.calls.generate.at(-1);
  const estimatedInput = 64 + Buffer.byteLength(request.system)
    + request.messages.reduce((sum, row) => sum + 16 + Buffer.byteLength(row.content), 0);
  assert.ok(estimatedInput <= 1600);
  assert.equal(request.maxOutputTokens, 73);
  assert.match(request.messages.at(-1).content, /已截断/);
  assert.match(request.system, /你是小星，简短自然地交流/);
  f.store.change(c => { c.personas[0].prompt = '必须保留的完整人设'.repeat(1000); });
  const before = f.calls.generate.length;
  await assert.rejects(f.engine.preview({ message: '你好' }), { code: 'persona_too_large' });
  assert.equal(f.calls.generate.length, before);
});

test('zero context means only the current message; full configured output cap is respected', async t => {
  const f = fixture(t, c => { c.budget.contextMessages = 0; c.budget.maxOutputTokens = 16000; c.budget.dailyTokenLimit = 100000; });
  await f.engine.preview({ message: '第一句', sessionId: 'none' });
  await f.engine.preview({ message: '第二句', sessionId: 'none' });
  assert.deepEqual(f.calls.generate.at(-1).messages, [{ role: 'user', content: '第二句' }]);
  assert.equal(f.calls.generate.at(-1).maxOutputTokens, 16000);
});

test('search only runs for explicit requests/configured triggers, with failure made visible in model context', async t => {
  const f = fixture(t, c => { c.search.enabled = true; c.search.apiKey = 'search-secret'; });
  await f.engine.preview({ message: '你好' });
  assert.equal(f.calls.search.length, 0);
  const result = await f.engine.preview({ message: '查一下新消息' });
  assert.equal(f.calls.search.length, 1);
  assert.equal(result.sources.length, 1);
  assert.match(f.calls.generate.at(-1).system, /不可信参考/);
  await f.engine.preview({ message: '查一下这个', search: false });
  assert.equal(f.calls.search.length, 1);
  await f.engine.preview({ message: '今天的天气', search: true });
  assert.equal(f.calls.search.length, 2);
  f.adapters.searchWeb = async () => { throw new Error('网络故障 search-secret'); };
  const failed = await f.engine.preview({ message: '查一下实时新闻' });
  assert.deepEqual(failed.sources, []);
  assert.match(f.calls.generate.at(-1).system, /联网检索失败/);
  assert.ok(f.store.events.some(row => row.event === 'search_failed'));
  assert.ok(f.store.events.every(row => !row.detail.includes('search-secret')));
});

test('settings changed during search stop a stale QQ model request before spending tokens', async t => {
  const f = fixture(t, c => { c.search.enabled = true; c.groups[0].proactive.prompt = '查一下最新消息'; });
  const gate = deferred(); const entered = deferred();
  f.adapters.searchWeb = async () => { entered.resolve(); return gate.promise; };
  const request = f.engine.proactive('123');
  await entered.promise;
  f.store.change(c => { c.bot.enabled = false; });
  gate.resolve([]);
  await assert.rejects(request, { code: 'paused' });
  assert.equal(f.calls.generate.length, 0);
  assert.equal(f.store.todayUsage().calls, 0);
});

test('model can select only an allowlisted local emoji and CQ/file directives never become actions', async t => {
  const f = fixture(t);
  f.adapters.generate = async () => ({ text: '开心[表情:../../secret.png][表情:happy.png][表情:happy.png][CQ:image,file=C:/secret.png]',
    inputTokens: 10, outputTokens: 10, estimated: false });
  await f.engine.proactive('123');
  assert.deepEqual(f.calls.emoji, ['happy.png']);
  assert.deepEqual(f.calls.send[0].params.message.map(item => item.type), ['text', 'image']);
  assert.equal(f.calls.send[0].params.message[0].data.text, '开心');
  await assert.rejects(f.engine.manualSend({ groupId: '123', emoji: '../secret.png' }), { code: 'unknown_emoji' });
  assert.equal(f.calls.send.length, 1);
});

test('deleted emoji and failed QQ sends are never marked sent, while model usage remains counted', async t => {
  const f = fixture(t);
  f.adapters.generate = async () => ({ text: '你好[表情:happy.png]', inputTokens: 7, outputTokens: 8, estimated: false });
  let listings = 0;
  f.media.listEmoji = async () => ++listings === 1 ? [{ name: 'happy.png', tags: [] }] : [];
  await assert.rejects(f.engine.proactive('123'), { code: 'unknown_emoji' });
  assert.equal(f.store.rows.at(-1).status, 'failed');
  assert.equal(f.store.todayUsage().totalTokens, 15);
  assert.equal(f.calls.send.length, 0);
  f.adapters.generate = async () => ({ text: '你好', inputTokens: 4, outputTokens: 5, estimated: false });
  f.adapters.onebotCall = async () => { throw new Error('QQ 未连接'); };
  await assert.rejects(f.engine.proactive('123'), /QQ 未连接/);
  await assert.rejects(f.engine.manualSend({ groupId: '123', text: '手动消息' }), /QQ 未连接/);
  assert.equal(f.store.todayUsage().totalTokens, 24);
  assert.ok(f.store.rows.every(row => row.status !== 'sent'));
  assert.equal(f.engine.status().groups[0].lastSentAt, null);
});

test('empty model output still records provider usage and fails instead of inventing a successful reply', async t => {
  const f = fixture(t);
  f.adapters.generate = async () => ({ text: '', inputTokens: 16, outputTokens: 21, estimated: false });
  await assert.rejects(f.engine.preview({ message: '你好' }), { code: 'empty_response' });
  assert.equal(f.store.todayUsage().totalTokens, 37);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.store.rows.filter(row => row.role === 'assistant').length, 0);
});

test('voice uses configured TTS and local saved audio with a record-only OneBot message', async t => {
  const f = fixture(t, c => { c.voice.enabled = true; c.voice.baseUrl = 'https://voice.example.com'; c.groups[0].autoVoice = true; });
  await f.engine.proactive('123');
  assert.equal(f.calls.synthesize.length, 1);
  assert.equal(f.calls.synthesize[0].text, '你好呀！');
  assert.equal(f.calls.audio.length, 1);
  assert.deepEqual(f.calls.send[0].params.message.map(item => item.type), ['record']);
  assert.match(f.store.rows.at(-1).content, /你好呀！\n\[语音\]/);
});

test('pausing during TTS prevents sending and records the cancelled draft', async t => {
  const f = fixture(t, c => { c.voice.enabled = true; });
  const gate = deferred(); const entered = deferred();
  f.adapters.synthesize = async () => { entered.resolve(); return gate.promise; };
  const request = f.engine.manualSend({ groupId: '123', text: '语音消息', voice: true });
  await entered.promise;
  f.store.change(c => { c.bot.enabled = false; });
  gate.resolve({ buffer: Buffer.from('voice'), extension: 'mp3' });
  await assert.rejects(request, { code: 'paused' });
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.calls.audio.length, 0);
  assert.equal(f.store.rows.at(-1).status, 'failed');
});


test('identical concurrent searches share one request, expire after five minutes and isolate config changes', async t => {
  const f=fixture(t,c=>{c.search.enabled=true;});
  const gate=deferred();let calls=0;
  f.adapters.searchWeb=async()=>{calls++;await gate.promise;return [{title:'answer',url:'https://example.com',content:'cached'}];};
  const cfg=f.store.config.search;
  const a=f.engine._search(cfg,'同一个问题'),b=f.engine._search(cfg,'同一个问题');gate.resolve();
  const [x,y]=await Promise.all([a,b]);assert.equal(calls,1);x[0].content='mutated';assert.equal(y[0].content,'cached');
  assert.equal((await f.engine._search(cfg,'同一个问题'))[0].content,'cached');assert.equal(calls,1);
  f.advance(300001);await f.engine._search(cfg,'同一个问题');assert.equal(calls,2);
  await f.engine._search({...cfg,apiKey:'new-key'},'同一个问题');assert.equal(calls,3);
});

test('failed searches are retryable and cache size remains bounded', async t => {
  const f=fixture(t);let calls=0;
  f.adapters.searchWeb=async()=>{if(++calls===1)throw new Error('offline');return [];};
  await assert.rejects(f.engine._search({},'retry'));
  await f.engine._search({},'retry');assert.equal(calls,2);
  for(let i=0;i<80;i++)await f.engine._search({},String(i));
  assert.ok(f.engine.searchCache.size<=64);
});

test('model sees at most twelve relevant emoji while manual selection can use the whole library', async t => {
  const f=fixture(t);
  f.media.listEmoji=async()=>Array.from({length:100},(_,i)=>({name:'emoji'+i+'.png',tags:i===99?['高兴']:['普通']}));
  const list=await f.engine._emojiList('我今天很高兴');assert.equal(list.length,12);assert.equal(list[0].name,'emoji99.png');
  await f.engine.manualSend({groupId:'123',emoji:'emoji80.png'});assert.deepEqual(f.calls.emoji,['emoji80.png']);
  await f.engine.receive(event('小星，我今天很高兴','bounded-emoji'));await settle(f.engine);
  const prompt=f.calls.generate.at(-1).system;assert.ok((prompt.match(/\[表情:emoji/g)||[]).length<=12);assert.match(prompt,/emoji99/);
});


test('offline QQ does not spend model tokens and disconnect cancels in-flight drafts',async t=>{
 const f=fixture(t);f.engine.canSend=()=>false;
 assert.equal((await f.engine.receive(event())).reason,'qq_offline');await assert.rejects(f.engine.proactive('123'),{code:'qq_offline'});assert.equal(f.calls.generate.length,0);
 f.engine.canSend=()=>true;const gate=deferred();f.adapters.generate=async()=>{await gate.promise;return {text:'draft',inputTokens:5,outputTokens:2};};
 const send=f.engine.proactive('123');await delay(0);f.engine.canSend=()=>false;gate.resolve();await assert.rejects(send,{code:'qq_offline'});assert.equal(f.calls.send.length,0);
});


test('shutdown cancels already queued session requests before they spend tokens',async t=>{
 const f=fixture(t);const gate=deferred();let calls=0;
 f.adapters.generate=async()=>{calls++;await gate.promise;return {text:'done',inputTokens:5,outputTokens:2};};
 const first=f.engine.preview({message:'first',sessionId:'close-queue'});await delay(0);
 const second=f.engine.preview({message:'queued',sessionId:'close-queue'});const results=Promise.allSettled([first,second]);
 const stopping=f.engine.stop();gate.resolve();await stopping;const settled=await results;
 assert.equal(settled[0].status,'fulfilled');assert.equal(settled[1].reason.code,'stopping');assert.equal(calls,1);assert.equal(f.store.todayUsage().calls,1);
});


test('cooldown retains triggered mentions, merges bursts and sends after the cooldown',async t=>{
 const f=fixture(t,c=>{c.groups[0].cooldownSec=1;});
 await f.engine.manualSend({groupId:'123',text:'上一条'});
 const ping=id=>event('',id,{message:[{type:'at',data:{qq:'900'}}]});
 assert.equal((await f.engine.receive(ping('cool-1'))).reason,'waiting_cooldown');
 await settle(f.engine);assert.equal(f.calls.generate.length,0);
 f.advance(1000);await f.engine.receive(ping('cool-2'));await settle(f.engine);
 assert.equal(f.calls.generate.length,1);assert.equal(f.calls.send.length,2);
 assert.equal(f.engine.status().groups[0].lastDecision.reason,'sent');
});

test('messages during a slow generation coalesce into one follow-up without cooldown failures',async t=>{
 const f=fixture(t,c=>{c.groups[0].cooldownSec=1;c.groups[0].replyMode='all';});const hold=deferred();let count=0;
 f.adapters.generate=async()=>{count++;if(count===1)await hold.promise;return {text:'回复',inputTokens:5,outputTokens:5};};
 await f.engine.receive(event('第一条','slow1'));await delay(20);assert.equal(count,1);
 for(let i=2;i<6;i++)await f.engine.receive(event('补充'+i,'slow'+i));
 await delay(30);assert.equal(count,1);hold.resolve();await settle(f.engine);assert.equal(f.calls.send.length,1);
 f.advance(1000);const pending=f.engine.pending.get('123');f.engine._schedule(f.store.config.groups[0],pending.message,pending);await settle(f.engine);
 assert.equal(count,2);assert.equal(f.calls.send.length,2);assert.equal(f.store.events.some(e=>e.event==='reply_failed'),false);
});

test('queued reply rechecks pause without spending tokens',async t=>{
 const f=fixture(t,c=>{c.groups[0].cooldownSec=1;});await f.engine.manualSend({groupId:'123',text:'hi'});
 await f.engine.receive(event('小星','q1'));f.store.change(c=>{c.bot.enabled=false;});f.advance(1000);
 const p=f.engine.pending.get('123');f.engine._schedule(f.store.config.groups[0],p.message,p);await settle(f.engine);
 assert.equal(f.calls.generate.length,0);assert.equal(f.engine.status().groups[0].lastDecision.reason,'paused');assert.equal(f.engine.pending.size,0);
});

test('remaining daily budget trims old context while preserving full persona and the newest question',async t=>{
 const f=fixture(t,c=>{c.budget.dailyTokenLimit=3000;});
 f.store.recordUsage({inputTokens:1200,outputTokens:0});
 for(let i=0;i<8;i++)f.store.addMessage({groupId:'__preview:remaining',role:'user',status:'received',source:'preview',content:'旧内容'.repeat(100)});
 const out=await f.engine.preview({sessionId:'remaining',message:'现在的问题'});assert.ok(out.text);
 const call=f.calls.generate[0];assert.ok(call.system.startsWith(f.store.config.personas[0].prompt));assert.equal(call.messages.at(-1).content,'现在的问题');assert.ok(call.messages.length<9);
 const upper=64+Buffer.byteLength(call.system)+call.messages.reduce((n,m)=>n+16+Buffer.byteLength(m.content),0)+call.maxOutputTokens;
 assert.ok(upper<=1800);
});

test('scheduled generation failures persist a useful per-group reason',async t=>{
 const f=fixture(t,c=>{c.budget.dailyTokenLimit=100;});await f.engine.receive(event());await settle(f.engine);
 const status=f.engine.status().groups[0];assert.equal(status.lastDecision.reason,'daily_budget');assert.match(status.lastDecision.detail,/预算/);assert.equal(f.calls.generate.length,0);
});


test('cooldown queue expires and still obeys the hourly cap',async t=>{
 const f=fixture(t,c=>{c.groups[0].cooldownSec=3600;});await f.engine.manualSend({groupId:'123',text:'first'});
 await f.engine.receive(event('小星','expire1'));f.advance(300000);let p=f.engine.pending.get('123');f.engine._schedule(f.store.config.groups[0],p.message,p);await settle(f.engine);
 assert.equal(f.calls.generate.length,0);assert.equal(f.engine.status().groups[0].lastDecision.reason,'queue_expired');assert.equal(f.engine.pending.size,0);
 f.store.change(c=>{c.groups[0].cooldownSec=1;c.groups[0].maxRepliesPerHour=1;});
 assert.equal((await f.engine.receive(event('小星','hour1'))).reason,'hourly_limit');assert.equal(f.engine.pending.size,0);
});

test('group voice overrides reach TTS without changing the shared voice settings',async t=>{const f=fixture(t,c=>{c.voice.enabled=true;c.voice.voice='global';c.voice.instructions='全局';c.groups[0].voiceId='voc_group';c.groups[0].voiceInstructions='轻声说话';});await f.engine.manualSend({groupId:'123',text:'你好',voice:true});assert.equal(f.calls.synthesize[0].config.voice,'voc_group');assert.equal(f.calls.synthesize[0].config.instructions,'轻声说话');assert.equal(f.store.config.voice.voice,'global');});

test('automatic voice chooses speech and context tone in one model call, then honors cooldown with text',async t=>{const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';c.groups[0].dynamicVoiceTone=true;c.groups[0].voiceIntervalSec=120;c.groups[0].voiceMaxChars=200;});f.adapters.generate=async(p,input)=>{f.calls.generate.push(input);return {text:'[语音:开心自然，语速轻快]今天不错',inputTokens:100,outputTokens:20};};await f.engine.receive(event('小星，今天怎么样','auto1'));await settle(f.engine);assert.equal(f.calls.generate.length,1);assert.equal(f.calls.synthesize.length,1);assert.equal(f.calls.synthesize[0].text,'今天不错');assert.equal(f.calls.synthesize[0].config.instructions,'开心自然，语速轻快');assert.match(f.calls.generate[0].system,/无需|不必等待/);await f.engine.receive(event('小星，再聊一句','auto2'));await settle(f.engine);assert.equal(f.calls.synthesize.length,1);assert.equal(f.calls.send.length,2);assert.equal(f.calls.send[1].params.message[0].type,'text');assert.ok(!f.store.rows.at(-1).content.includes('[语音:'));});
test('auto voice supports proactive speaking and respects length and text-only choices',async t=>{const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';c.groups[0].voiceMaxChars=10;});f.adapters.generate=async()=>({text:'[语音:平静]早上好',inputTokens:10,outputTokens:10});await f.engine.proactive('123');assert.equal(f.calls.synthesize.length,1);f.advance(120000);f.adapters.generate=async()=>({text:'[语音:平静]这是一段超出自动语音字数限制的文字',inputTokens:10,outputTokens:10});await f.engine.proactive('123');assert.equal(f.calls.synthesize.length,1);f.adapters.generate=async()=>({text:'这次文字就好',inputTokens:10,outputTokens:10});await f.engine.proactive('123');assert.equal(f.calls.synthesize.length,1);});
test('disabled automatic tone retains configured delivery and voice mode migrates safely',async t=>{const f=fixture(t,c=>{c.voice.enabled=true;c.voice.instructions='固定语气';c.groups[0].voiceMode='always';c.groups[0].dynamicVoiceTone=false;});f.adapters.generate=async()=>({text:'[语音:其他语气]你好',inputTokens:10,outputTokens:10});await f.engine.proactive('123');assert.equal(f.calls.synthesize[0].config.instructions,'固定语气');f.store.change(c=>{c.groups[0].voiceMode='text';c.groups[0].autoVoice=true;});await f.engine.proactive('123');assert.equal(f.calls.synthesize.length,1);});

test('voice selection cannot turn an emoji-only reply into an empty speech request',t=>{const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';});assert.equal(f.engine._voicePlan(f.store.config.groups[0],{text:'',voiceIntent:true}).voice,false);});

test('QQ image reaches the model once, stays in its group, and consumes image budget', async t=>{
  const f=fixture(t,c=>{c.budget.maxInputTokens=8000;});
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);let fetched=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{fetched++;assert.match(url,/^https:\/\/gchat.qpic.cn\//);assert.equal(options.redirect,'manual');return new Response(png);});
  await f.engine.receive(event('','image-1',{message:[{type:'text',data:{text:'小星，这是什么表情'}},{type:'image',data:{url:'https://gchat.qpic.cn/test',file:'C:/secret.png'}}]}));await settle(f.engine);
  assert.equal(f.calls.generate.length,1);assert.equal(f.calls.generate[0].images.length,1);assert.match(f.calls.generate[0].images[0],/^data:image\/png;base64,/);assert.equal(fetched,1);
  await f.engine.receive(event('小星，继续','image-2'));await settle(f.engine);assert.equal(f.calls.generate[1].images.length,0);assert.equal(fetched,1);
});

test('disabled vision and expired pictures never fetch images',async t=>{
 const f=fixture(t,c=>{c.groups[0].visionEnabled=false;});t.mock.method(globalThis,'fetch',()=>{throw Error('unexpected fetch');});
 await f.engine.receive(event('','disabled-picture',{message:[{type:'at',data:{qq:'900'}},{type:'image',data:{url:'https://gchat.qpic.cn/test'}}]}));await settle(f.engine);assert.equal(f.calls.generate[0].images.length,0);
 f.store.change(c=>{c.groups[0].visionEnabled=true;});await f.engine.receive(event('','old-picture',{message:[{type:'image',data:{url:'https://gchat.qpic.cn/test'}}]}));f.advance(91000);await f.engine.receive(event('小星，看图','expired-trigger'));await settle(f.engine);assert.equal(f.calls.generate.at(-1).images.length,0);
});

test('image download failure explicitly informs model instead of pretending to see it',async t=>{
 const f=fixture(t,c=>{c.budget.maxInputTokens=8000;});t.mock.method(globalThis,'fetch',async()=>new Response('gone',{status:403}));
 await f.engine.receive(event('','bad-picture',{message:[{type:'at',data:{qq:'900'}},{type:'image',data:{url:'https://gchat.qpic.cn/test'}}]}));await settle(f.engine);assert.equal(f.calls.generate[0].images.length,0);assert.match(f.calls.generate[0].system,/下载失败/);assert.equal(f.calls.send.length,1);
});

test('large persona no longer removes every emoji at the old 65 percent threshold',async t=>{
 const f=fixture(t,c=>{c.budget.maxInputTokens=4000;c.personas[0].prompt='自然聊天'.repeat(180);});await f.engine.receive(event('小星，开心','emoji-budget'));await settle(f.engine);assert.match(f.calls.generate[0].system,/\[表情:happy.png\]/);
});

test('explicit voice request generates real record despite automatic voice cooldown and strips legacy marker',async t=>{
 const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';c.groups[0].voiceIntervalSec=120;});f.engine._state('123').lastVoiceAt=new Date(f.now()-1000).toISOString();
 f.adapters.generate=async()=>({text:'你好呀（语音）',inputTokens:10,outputTokens:5});
 await f.engine.receive(event('小星，发语音来','explicit-voice'));await settle(f.engine);
 assert.equal(f.calls.synthesize.length,1);assert.equal(f.calls.synthesize[0].text,'你好呀');assert.equal(f.calls.send[0].params.message[0].type,'record');
});

test('legacy voice marker is never sent literally when voice is disabled',async t=>{
 const f=fixture(t);f.adapters.generate=async()=>({text:'你好\n[语音]',inputTokens:10,outputTokens:5});await f.engine.receive(event());await settle(f.engine);assert.equal(f.calls.synthesize.length,0);assert.equal(f.calls.send[0].params.message[0].data.text,'你好');
});

test('automatic voice does not discard an emoji chosen for this reply',async t=>{
 const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';});f.adapters.generate=async()=>({text:'[语音:开心]好耶[表情:happy.png]',inputTokens:10,outputTokens:5});await f.engine.receive(event());await settle(f.engine);assert.equal(f.calls.synthesize.length,0);assert.ok(f.calls.send[0].params.message.some(s=>s.type==='image'));
});

test('hourly stop exposes the counter and earliest actual resume time',async t=>{
 const f=fixture(t,c=>{c.groups[0].maxRepliesPerHour=1;});await f.engine.receive(event());await settle(f.engine);const status=f.engine.status().groups[0];assert.equal(status.blockedReason,'hourly_limit');assert.equal(status.repliesThisHour,1);assert.equal(Date.parse(status.limitResumesAt),f.now()+3600000);
});

test('explicit quoted speech survives unrelated burst and bypasses model rewriting',async t=>{
 const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';c.groups[0].replyProbability=1;});
 await f.engine.receive(event('用温柔的语气发语音：“晚安，明天见。”','speech-first',{message:[{type:'at',data:{qq:'900'}},{type:'text',data:{text:'用温柔的语气发语音：“晚安，明天见。”'}}]}));
 await f.engine.receive(event('我叫小鲸鱼，别乱叫','other-last',{user_id:'888'}));await settle(f.engine);
 assert.equal(f.calls.generate.length,0);assert.equal(f.calls.synthesize.length,1);assert.equal(f.calls.synthesize[0].text,'晚安，明天见。');assert.equal(f.calls.synthesize[0].config.instructions,'温柔');assert.equal(f.calls.send[0].params.message[0].type,'record');
});

test('voice request without supplied script stays explicit across merged messages',async t=>{
 const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';c.groups[0].replyProbability=1;c.bot.name='小星';});f.adapters.generate=async()=>({text:'发什么语音，没那功能。',inputTokens:10,outputTokens:3});
 await f.engine.receive(event('小星，发个语音来','voice-first'));await f.engine.receive(event('吃饭了吗','other-msg',{user_id:'888'}));await settle(f.engine);
 assert.equal(f.calls.synthesize.length,1);assert.equal(f.calls.synthesize[0].text,'我在，你想听我说什么？');
});

test('emoji probability zero and full are enforced; explicit request overrides zero',async t=>{
 const f=fixture(t,c=>{c.groups[0].emojiProbability=0;});
 await f.engine.receive(event('小星你好','prob-zero'));await settle(f.engine);assert.equal(f.calls.emoji.length,0);
 f.store.change(c=>{c.groups[0].emojiProbability=100;});await f.engine.receive(event('小星你好','prob-full'));await settle(f.engine);assert.equal(f.calls.emoji.length,1);
 f.store.change(c=>{c.groups[0].emojiProbability=0;});await f.engine.receive(event('小星，发个表情包','prob-explicit'));await settle(f.engine);assert.equal(f.calls.emoji.length,2);
});

test('reply and mention become real structured segments and poke is a separate scoped action',async t=>{
 const f=fixture(t,c=>{c.groups[0].allowPoke=true;c.groups[0].emojiProbability=0;});
 f.adapters.generate=async()=>({text:'[引用:55][艾特:777][戳:777]你好',inputTokens:10,outputTokens:3});
 await f.engine.receive(event('小星你好','55'));await settle(f.engine);
 assert.equal(f.calls.send[0].params.message[0].type,'reply');assert.equal(f.calls.send[0].params.message[0].data.id,'55');assert.equal(f.calls.send[0].params.message[1].type,'at');assert.equal(f.calls.send[1].action,'group_poke');assert.equal(f.calls.send[1].params.user_id,'777');
 await f.engine.receive(event('小星继续','56'));await settle(f.engine);assert.equal(f.calls.send.filter(c=>c.action==='group_poke').length,1);
});

test('cross-group targets, all-member mentions and disabled actions are stripped',async t=>{
 const f=fixture(t,c=>{c.groups[0].allowPoke=true;c.groups[0].emojiProbability=0;});f.store.addMessage({groupId:'999',senderId:'888',messageId:'99',source:'qq',role:'user',status:'received',content:'other'});
 f.adapters.generate=async()=>({text:'[引用:99][艾特:all][戳:888]你好',inputTokens:10,outputTokens:3});await f.engine.receive(event('小星你好','57'));await settle(f.engine);assert.deepEqual(f.calls.send[0].params.message,[{type:'text',data:{text:'你好'}}]);
 f.store.change(c=>{c.groups[0].quoteReply=false;c.groups[0].allowMention=false;c.groups[0].allowPoke=false;});f.adapters.generate=async()=>({text:'[引用:57][艾特:777][戳:777]你好',inputTokens:10,outputTokens:3});await f.engine.receive(event('小星继续','58'));await settle(f.engine);assert.deepEqual(f.calls.send[1].params.message,[{type:'text',data:{text:'你好'}}]);
});

test('valid poke-only reply is sent, and poke failure never retries an already sent text',async t=>{
 const f=fixture(t,c=>{c.groups[0].allowPoke=true;c.groups[0].emojiProbability=0;});f.adapters.generate=async()=>({text:'[戳:777]',inputTokens:10,outputTokens:3});await f.engine.receive(event());await settle(f.engine);assert.equal(f.calls.send.length,1);assert.equal(f.calls.send[0].action,'group_poke');
 f.advance(301000);f.adapters.generate=async()=>({text:'你好[戳:777]',inputTokens:10,outputTokens:3});const original=f.adapters.onebotCall;f.adapters.onebotCall=async(...args)=>{if(args[1]==='group_poke')throw Error('poke unavailable');return original(...args);};await f.engine.receive(event('小星继续','poke-fail'));await settle(f.engine);assert.equal(f.calls.send.length,2);assert.equal(f.store.rows.at(-1).status,'sent');assert.ok(f.store.events.some(e=>e.event==='poke_failed'));
});

test('capability question does not repeat historical denial and third-party mention does not trigger',async t=>{
 const f=fixture(t,c=>{c.groups[0].replyProbability=0.8;});await f.engine.receive(event('你现在到底能不能看图','vision-cap'));await settle(f.engine);assert.equal(f.calls.generate.length,0);assert.match(f.calls.send[0].params.message[0].data.text,/识图已开启/);
 await f.engine.receive(event('','other-at',{message:[{type:'at',data:{qq:'888'}},{type:'text',data:{text:'发语音来'}}]}));await settle(f.engine);assert.equal(f.calls.send.length,1);
});

test('quoting the bot triggers reply even without at, and quoted speech reads the exact referenced text',async t=>{
 const f=fixture(t,c=>{c.groups[0].replyMode='mention';c.voice.enabled=true;c.groups[0].voiceMode='auto';});f.store.addMessage({groupId:'123',source:'qq',role:'assistant',status:'sent',senderId:'900',senderName:'小星',messageId:'70',content:'晚安，做个好梦。'});
 await f.engine.receive(event('','quote-voice',{message:[{type:'reply',data:{id:'70'}},{type:'text',data:{text:'把这句用语音读出来'}}]}));await settle(f.engine);assert.equal(f.calls.synthesize[0].text,'晚安，做个好梦。');assert.equal(f.calls.generate.length,0);
});

test('same sender can cancel a queued voice request',async t=>{
 const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';c.groups[0].replyProbability=1;});f.adapters.generate=async()=>({text:'[语音:自然]好的',inputTokens:10,outputTokens:3});await f.engine.receive(event('小星，发语音：“晚安”','cancel-1'));await f.engine.receive(event('不用发语音了','cancel-2'));await settle(f.engine);assert.equal(f.calls.synthesize.length,0);
});

test('custom hourly limits above 300 and 1000 are accepted and enforced without hidden clamp',async t=>{
 const {validateConfig}=await import('../app/lib/config.mjs');const f=fixture(t,c=>{c.groups[0].maxRepliesPerHour=1500;});assert.equal(validateConfig(f.store.config).groups[0].maxRepliesPerHour,1500);
 const state=f.engine._state('123');state.sentAt=Array(1200).fill(f.now());assert.equal(f.engine._ineligible(f.store.config.groups[0]),null);assert.equal(f.engine.status().groups[0].repliesThisHour,1200);
 state.sentAt=Array(1500).fill(f.now());assert.equal(f.engine._ineligible(f.store.config.groups[0]),'hourly_limit');f.advance(3600001);assert.equal(f.engine.status().groups[0].repliesThisHour,0);assert.equal(f.engine._ineligible(f.store.config.groups[0]),null);
});
test('hourly limit still rejects nonpositive, fractional and unsafe values',async t=>{
 const {validateConfig}=await import('../app/lib/config.mjs');const f=fixture(t);for(const value of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1]){const c=f.store.config;c.groups[0].maxRepliesPerHour=value;assert.throws(()=>validateConfig(c));}
});

test('bare voice request reuses the recent reply to this sender without another model call',async t=>{
 const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';c.groups[0].replyProbability=0.8;});f.store.addMessage({groupId:'123',source:'qq',role:'user',status:'received',senderId:'777',content:'发句晚安来',createdAt:new Date(f.now()).toISOString()});f.store.addMessage({groupId:'123',source:'qq',role:'assistant',status:'sent',content:'晚安，睡吧。\n[表情:happy.png]',createdAt:new Date(f.now()).toISOString()});await f.engine.receive(event('语音','bare-voice'));await settle(f.engine);assert.equal(f.calls.generate.length,0);assert.equal(f.calls.synthesize[0].text,'晚安，睡吧。');assert.equal(f.calls.send[0].params.message[0].type,'record');
});
test('empty model body or voice-marker-only body still produces a real explicit voice reply once',async t=>{
 for(const text of ['', '[语音:温柔]']){const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';});f.adapters.generate=async()=>({text,inputTokens:10,outputTokens:9});await f.engine.receive(event('小星，发句语音来','empty-voice'));await settle(f.engine);assert.equal(f.calls.synthesize.length,1);assert.equal(f.calls.synthesize[0].text,'我在，你想听我说什么？');assert.equal(f.calls.send[0].params.message[0].type,'record');assert.ok(f.store.events.some(e=>e.event==='model_body_empty'));assert.equal(f.store.usage.length,1);}
});
test('ordinary empty auto reply returns a text explanation without model retry',async t=>{
 const f=fixture(t,c=>{c.groups[0].emojiProbability=0;});f.adapters.generate=async()=>({text:'',inputTokens:10,outputTokens:0});await f.engine.receive(event());await settle(f.engine);assert.match(f.calls.send[0].params.message[0].data.text,/没有生成出完整回复/);assert.equal(f.store.usage.length,1);
});
test('automatic TTS failure sends readable text and does not mark it as voice',async t=>{
 const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';});f.adapters.synthesize=async()=>{throw Error('temporary voice service failure');};await f.engine.receive(event('小星，发句宝贝晚安的语音','tts-failed'));await settle(f.engine);assert.equal(f.calls.send[0].params.message[0].type,'text');assert.match(f.calls.send[0].params.message[0].data.text,/宝贝晚安/);assert.match(f.calls.send[0].params.message[0].data.text,/语音生成失败/);assert.equal(f.engine._state('123').lastVoiceAt,null);
});
test('manual sending does not erase the last automatic decision',async t=>{
 const f=fixture(t);f.engine._decision('123','empty_response','automatic failed');await f.engine.manualSend({groupId:'123',text:'手动测试'});assert.equal(f.engine.status().groups[0].lastAutomaticDecision.reason,'empty_response');assert.equal(f.engine.status().groups[0].lastDecision.reason,'sent');
});

function privateFixture(t){return fixture(t,c=>{c.groups.push({...c.groups[0],id:'private:777',name:'好友',replyMode:'all',relayTargets:['123'],sharedTargets:['123']});});}
function friendEvent(text,id='p1'){return event(text,id,{message_type:'private',sub_type:'friend',group_id:undefined});}
test('friend messages use private transport and isolated context; temporary strangers ignored',async t=>{
 const f=privateFixture(t);f.store.addMessage({groupId:'123',role:'user',content:'GROUP_ONLY_SECRET'});
 assert.equal(parseOneBotEvent(friendEvent('你好')).groupId,'private:777');
 assert.equal(parseOneBotEvent({...friendEvent('你好'),sub_type:'group'}),null);
 await f.engine.receive(friendEvent('你好'));await settle(f.engine);
 assert.equal(f.calls.send[0].action,'send_private_msg');assert.equal(f.calls.send[0].params.user_id,'777');
 assert.ok(!JSON.stringify(f.calls.generate).includes('GROUP_ONLY_SECRET'));
 assert.ok(f.store.rows.some(r=>r.groupId==='private:777'&&r.role==='assistant'));
 assert.equal((await f.engine.receive({...friendEvent('hi','p2'),user_id:'888'})).reason,'group_disabled');
});
test('explicit private speech sends a real record without rewriting',async t=>{
 const f=privateFixture(t);f.store.change(c=>{c.voice.enabled=true;c.groups[1].voiceMode='auto';});
 await f.engine.receive(friendEvent('用语音说：宝贝晚安'));await settle(f.engine);
 assert.equal(f.calls.synthesize.length,1);assert.equal(f.calls.synthesize[0].text,'宝贝晚安');
 assert.equal(f.calls.send[0].action,'send_private_msg');assert.equal(f.calls.send[0].params.message[0].type,'record');
});
test('private relay verifies member and sends structured at only to authorized group',async t=>{
 const f=privateFixture(t);const base=f.adapters.onebotCall;f.adapters.onebotCall=async(c,a,p)=>a==='get_group_member_list'?[{user_id:456,nickname:'小王'}]:base(c,a,p);
 await f.engine.receive(friendEvent('去群123 艾特小王说：你好'));await settle(f.engine);
 assert.equal(f.calls.send.length,2);assert.equal(f.calls.send[0].action,'send_group_msg');
 assert.equal(f.calls.send[0].params.group_id,'123');assert.ok(f.calls.send[0].params.message.some(m=>m.type==='at'&&m.data.qq==='456'));
 assert.ok(f.calls.send[0].params.message.some(m=>m.type==='text'&&m.data.text==='你好'));
 assert.equal(f.calls.send[1].action,'send_private_msg');assert.equal(f.calls.generate.length,0);
});
test('unapproved relay does not send to a group',async t=>{
 const f=privateFixture(t);f.store.change(c=>c.groups[1].relayTargets=[]);
 await f.engine.receive(friendEvent('去群123 @456 说：你好'));await settle(f.engine);
 assert.equal(f.calls.send.length,1);assert.equal(f.calls.send[0].action,'send_private_msg');assert.ok(JSON.stringify(f.calls.send).includes('未授权'));
});
test('ambiguous member refuses relay rather than guessing',async t=>{
 const f=privateFixture(t);const base=f.adapters.onebotCall;f.adapters.onebotCall=async(c,a,p)=>a==='get_group_member_list'?[{user_id:456,nickname:'小王'},{user_id:789,nickname:'小王'}]:base(c,a,p);
 await f.engine.receive(friendEvent('去群123 艾特小王说：你好'));await settle(f.engine);
 assert.equal(f.calls.send.length,1);assert.equal(f.calls.send[0].action,'send_private_msg');
});
test('saved memory is scoped, revocable and deletable without sharing raw private history',async t=>{
 const f=privateFixture(t);const own=f.engine.memories.save({scope:'private:777',text:'PRIVATE_SECRET'});
 const shared=f.engine.memories.save({scope:'123',origin:'private:777',text:'小王是个帅哥'});
 assert.deepEqual(f.engine.memories.active('123').map(m=>m.text),['小王是个帅哥']);
 assert.deepEqual(f.engine.memories.active('private:777').map(m=>m.text),['PRIVATE_SECRET']);
 f.store.change(c=>c.groups[1].sharedTargets=[]);assert.equal(f.engine.memories.active('123').length,0);
 assert.throws(()=>f.engine.memories.save({scope:'123',origin:'private:777',text:'禁止共享'}));
 f.engine.memories.remove(own.id);f.engine.memories.remove(shared.id);assert.equal(f.engine.memories.all().length,0);
});
test('private memory acknowledgement does not invoke model or broadcast raw conversation',async t=>{
 const f=privateFixture(t);await f.engine.receive(friendEvent('群里小王是个帅哥'));await settle(f.engine);
 assert.equal(f.engine.memories.active('123')[0].text,'群里小王是个帅哥');assert.equal(f.calls.generate.length,0);
 assert.equal(f.calls.send.length,1);assert.equal(f.calls.send[0].action,'send_private_msg');
});
test('generated relay greeting uses only target group context',async t=>{
 const f=privateFixture(t);f.store.addMessage({groupId:'private:777',role:'user',content:'PRIVATE_SECRET'});
 const base=f.adapters.onebotCall;f.adapters.onebotCall=async(c,a,p)=>a==='get_group_member_list'?[{user_id:456,nickname:'小王'}]:base(c,a,p);
 await f.engine.receive(friendEvent('去群里艾特小王和他说句话'));await settle(f.engine);
 assert.equal(f.calls.generate.length,1);assert.ok(!JSON.stringify(f.calls.generate).includes('PRIVATE_SECRET'));
 assert.equal(f.calls.send[0].action,'send_group_msg');
});

test('private images are model input and do not leak into group image state',async t=>{
 const f=privateFixture(t);f.store.change(c=>c.budget.maxInputTokens=8000);
 t.mock.method(globalThis,'fetch',async()=>new Response(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])));
 await f.engine.receive({...friendEvent('','picture'),message:[{type:'image',data:{url:'https://c2cpicdw.qpic.cn/test'}}]});await settle(f.engine);
 assert.equal(f.calls.generate[0].images.length,1);assert.equal(f.calls.send[0].action,'send_private_msg');
 await f.engine.receive(event());await settle(f.engine);assert.equal(f.calls.generate[1].images.length,0);
});
test('private quote emoji and poke use real segments and friend action',async t=>{
 const f=privateFixture(t);f.store.change(c=>{c.groups[1].allowPoke=true;c.groups[1].emojiProbability=100;});
 f.adapters.generate=async()=>({text:'[引用:55][戳:777]你好[表情:happy.png]',inputTokens:10,outputTokens:3});
 await f.engine.receive(friendEvent('你好','55'));await settle(f.engine);
 assert.equal(f.calls.send[0].action,'send_private_msg');assert.ok(f.calls.send[0].params.message.some(m=>m.type==='reply'));
 assert.ok(f.calls.send[0].params.message.some(m=>m.type==='image'));assert.equal(f.calls.send[1].action,'friend_poke');assert.equal(f.calls.send[1].params.user_id,'777');
});
test('deleting a shared memory cancels an in-flight draft based on that memory',async t=>{
 const f=privateFixture(t);const memory=f.engine.memories.save({scope:'123',origin:'private:777',text:'待删除事实'});const gate=deferred();
 f.adapters.generate=async()=>{await gate.promise;return {text:'过期内容',inputTokens:10,outputTokens:3};};
 const work=f.engine._reply('123','小星你好');await delay(5);f.engine.memories.remove(memory.id);gate.resolve();
 await assert.rejects(work);assert.equal(f.calls.send.length,0);
});

test('stable sender IDs distinguish same nicknames and track nickname changes',async t=>{
 const f=fixture(t);f.store.addMessage({groupId:'123',role:'user',status:'received',source:'qq',senderId:'777',senderName:'旧昵称',messageId:'1',content:'我的第一句话'});
 f.store.addMessage({groupId:'123',role:'user',status:'received',source:'qq',senderId:'888',senderName:'新昵称',messageId:'2',content:'另外一个人的话'});
 await f.engine.receive(event('小星，这是我第二句话','3',{sender:{nickname:'新昵称'}}));await settle(f.engine);
 const body=JSON.stringify(f.calls.generate[0].messages);assert.ok(body.includes('QQ=777'));assert.ok(body.includes('QQ=888'));assert.ok(body.includes('旧昵称'));assert.ok(body.includes('新昵称'));
 assert.ok(!f.calls.send[0].params.message.some(m=>m.type==='reply')); // No unsolicited automatic quote just because several people spoke.
});
test('mention replies automatically quote real focus even when model emits plain text',async t=>{
 const f=fixture(t);await f.engine.receive(event('','91',{message:[{type:'at',data:{qq:'900'}},{type:'text',data:{text:'你好'}}]}));await settle(f.engine);
 assert.equal(f.calls.send[0].params.message[0].type,'reply');assert.equal(f.calls.send[0].params.message[0].data.id,'91');
});
test('learned expression is shared by persona across groups and preview but not other personas',async t=>{
 const f=fixture(t,c=>{c.groups.push({...c.groups[0],id:'456'});c.personas.push({...c.personas[0],id:'other'});});
 await f.engine.receive(event('小星，你以后说话可爱一点','pref'));await settle(f.engine);assert.equal(f.engine.learning.get('default').text,'说话可爱一点。');
 await f.engine.receive(event('小星，你好','other-group',{group_id:'456'}));await settle(f.engine);assert.match(f.calls.generate.at(-1).system,/说话可爱一点/);
 await f.engine.preview({message:'你好',personaId:'default'});assert.match(f.calls.generate.at(-1).system,/说话可爱一点/);
 await f.engine.preview({message:'你好',personaId:'other'});assert.ok(!f.calls.generate.at(-1).system.includes('说话可爱一点'));
});
test('model learning JSON never reaches QQ text or history',async t=>{
 const f=fixture(t);f.store.setMeta('persona:learning:default',{...f.engine.learning.get('default'),count:7});
 f.adapters.generate=async()=>({text:'好呀<persona_update>{"add":["偶尔用短句接梗。"]}</persona_update>',inputTokens:50,outputTokens:20});
 await f.engine.receive(event());await settle(f.engine);assert.equal(f.engine.learning.get('default').text,'偶尔用短句接梗。');assert.ok(!JSON.stringify(f.calls.send).includes('persona_update'));assert.ok(!f.store.rows.at(-1).content.includes('persona_update'));
});
test('image priority admits a 600-character persona within 3500 budget and records missing address precisely',async t=>{
 const f=fixture(t,c=>{c.budget.maxInputTokens=3500;c.personas[0].prompt='自然聊天。'.repeat(115);});
 t.mock.method(globalThis,'fetch',async()=>new Response(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])));
 await f.engine.receive(event('','image-priority',{message:[{type:'at',data:{qq:'900'}},{type:'image',data:{url:'https://gchat.qpic.cn/a'}}]}));await settle(f.engine);assert.equal(f.calls.generate[0].images.length,1);
 await f.engine.receive(event('','bad-url',{message:[{type:'at',data:{qq:'900'}},{type:'image',data:{url:'file:///D:/secret.png'}}]}));await settle(f.engine);assert.match(f.engine._state('123').vision.detail,/下载地址/);
});

test('diagnostics explain skipped messages and track a sent reply independently',async t=>{
 const f=fixture(t);await f.engine.receive(event('路过','d1'));await f.engine.receive(event('小星你好','d2'));await settle(f.engine);
 assert.deepEqual(f.store.traces.filter(x=>x.messageId==='d1').map(x=>x.stage),['received','skipped']);
 const stages=f.store.traces.filter(x=>x.messageId==='d2').map(x=>x.stage);for(const stage of ['received','queued','processing','model_request','model_result','qq_sending','sent'])assert.ok(stages.includes(stage),stage);
});
test('diagnostics attribute TTS fallback to the correct incoming message',async t=>{
 const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';});f.adapters.synthesize=async()=>{throw Error('TTS unavailable')};
 await f.engine.receive(event('小星，用语音说：你好','voice-diag'));await settle(f.engine);
 const stages=f.store.traces.filter(x=>x.messageId==='voice-diag').map(x=>x.stage);assert.ok(stages.includes('voice_request'));assert.ok(stages.includes('voice_fallback'));assert.ok(stages.includes('sent'));
});


test('plastic memory remembers a personal address, isolates identities and returns the exact command without LLM',async t=>{const f=fixture(t);await f.engine.receive(event('小星，以后叫我小主人','plast1'));await settle(f.engine);assert.match(f.engine.personality.render('default','123','777'),/小主人/);const n=f.calls.generate.length;await f.engine.receive(event('/可变人格','plast2'));await settle(f.engine);assert.equal(f.calls.generate.length,n);assert.ok(f.calls.send.at(-1).params.message.some(s=>s.type==='text'&&s.data.text.includes('QQ=777')));});
test('persistent voice request remains across replies and can be cancelled',async t=>{const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='auto';c.groups[0].voiceIntervalSec=9999;});await f.engine.receive(event('小星，后面的所有消息都发语音','voice-p1'));await settle(f.engine);await f.engine.receive(event('小星，今天怎么样','voice-p2'));await settle(f.engine);assert.equal(f.calls.synthesize.length,2);await f.engine.receive(event('小星，不用语音了，改回文字','voice-p3'));await settle(f.engine);assert.equal(f.calls.synthesize.length,2);});
test('100% group replies to other people are limited to light reactions without learning or TTS',async t=>{
  const f=fixture(t,c=>{
    c.voice.enabled=true;
    c.groups[0].voiceMode='always';
    c.groups[0].reactionStyle='allow';
    c.groups[0].turnCheckEnabled=true;c.groups[0].replyProbability=1;
  });
  const member={groupId:'123',source:'qq',role:'user',status:'received',senderId:'888',senderName:'桃子',messageId:'98',content:'有人吗'};
  f.store.addMessage(member);
  f.engine.random=(()=>{const draws=[0.2,0];return ()=>draws.shift()??0.2;})();
  await f.engine.receive(event('','other-at',{message:[{type:'at',data:{qq:'888'}},{type:'text',data:{text:'以后叫我老板，用语音读：晚上好'}}]}));
  await settle(f.engine);
  assert.deepEqual(f.calls.send[0].params.message,[{type:'text',data:{text:'(・ω・)'}}]);
  f.engine.random=()=>0;
  await f.engine.receive(event('','other-quote',{message:[{type:'reply',data:{id:'98'}},{type:'text',data:{text:'你吃了没'}}]}));
  await settle(f.engine);
  assert.deepEqual(f.calls.send[1].params.message,[{type:'text',data:{text:'(・ω・)'}}]);
  f.engine.random=()=>0.9;
  await f.engine.receive(event('桃子，去不去','other-name'));
  await settle(f.engine);
  assert.deepEqual(f.calls.send[2].params.message.map(segment=>segment.type),['image']);
  assert.equal(f.engine.personality.get('default').entries.length,0);
  assert.equal(f.calls.generate.length,0);
  assert.equal(f.calls.synthesize.length,0);
  assert.equal(f.calls.send.length,3);
});
test('a real at or quote cannot be downgraded by an old model decision marker',async t=>{
  const f=fixture(t,c=>{c.groups[0].turnCheckEnabled=true;c.groups[0].replyProbability=1;c.groups[0].autoEmoji=false;});
  f.adapters.generate=async(p,input)=>{
    f.calls.generate.push(input);
    return {text:'[群聊:轻回应]\n还没睡',inputTokens:10,outputTokens:6};
  };
  await f.engine.receive(event('','at-me',{message:[{type:'at',data:{qq:'900'}},{type:'text',data:{text:'睡了没'}}]}));
  await f.engine.receive(event('那你几点睡','ambient-other',{user_id:'888'}));
  await settle(f.engine);
  assert.equal(f.calls.generate.length,1);
  assert.match(f.calls.generate[0].system,/本条已确认/);
  assert.equal(f.calls.send[0].params.message.at(-1).data.text,'还没睡');
  const botMessage=f.store.rows.at(-1);
  for(let i=0;i<110;i++)f.store.addMessage({groupId:'123',role:'user',source:'qq',status:'received',senderId:'888',content:'别的话题',messageId:'old-'+i});
  await f.engine.receive(event('','quote-me',{message:[{type:'reply',data:{id:botMessage.messageId}},{type:'text',data:{text:'？'}}]}));
  await settle(f.engine);
  assert.equal(f.calls.generate.length,2);
  assert.equal(f.calls.send[1].params.message.at(-1).data.text,'还没睡');
});

test('a member can ask a follow-up after the bot mentions them; unrelated chat does not take over',async t=>{
  const f=fixture(t,c=>{c.groups[0].turnCheckEnabled=true;c.groups[0].replyProbability=1;c.groups[0].autoEmoji=false;});
  f.store.addMessage({groupId:'123',source:'qq',role:'user',status:'received',senderId:'777',senderName:'群友',content:'昨天打游戏',messageId:'98'});
  f.adapters.generate=async(p,input)=>{
    f.calls.generate.push(input);
    const current=input.messages.findLast(m=>m.role==='user').content;
    const text=f.calls.generate.length===1?'[艾特:777]你这个派蒙头像还挺好认':current.includes('原神')?'[对象:自己][回应:正文]\n偶尔玩一下':'[对象:他人][回应:轻]';
    return {text,inputTokens:10,outputTokens:6};
  };
  await f.engine.proactive('123');
  assert.equal(f.calls.send[0].params.message[0].type,'at');
  f.advance(14000);
  await f.engine.receive(event('派蒙头像','short-first'));
  await f.engine.receive(event('你也玩原神','follow-up'));
  await settle(f.engine);
  assert.equal(f.calls.generate.length,2);
  assert.equal(f.calls.send[1].params.message.at(-1).data.text,'偶尔玩一下');
  await f.engine.receive(event('今天到底去哪','other', {user_id:'888'}));
  await settle(f.engine);
  await f.engine.receive(event('你觉得呢','interrupted'));
  await settle(f.engine);
  assert.equal(f.calls.generate.length,4);
  assert.equal(f.calls.send.length,2);
  assert.ok(f.calls.generate[1].messages.some(m=>m.content.includes('此前你明确对当前发言者')));
});
test('context determines target and whether to reply without requiring at, quote or a pronoun',async t=>{
  const f=fixture(t,c=>{c.groups[0].turnCheckEnabled=true;c.groups[0].replyProbability=1;c.groups[0].autoEmoji=false;});
  f.store.addMessage({groupId:'123',source:'qq',role:'assistant',status:'sent',senderId:'900',messageId:'91',content:'试试周六九点，地铁还开着'});
  let response='[对象:自己][回应:正文]\n末班是十点半。';
  f.adapters.generate=async(p,input)=>{
    f.calls.generate.push(input);
    return {text:response,inputTokens:10,outputTokens:6};
  };
  await f.engine.receive(event('末班几点','without-pronoun'));
  await settle(f.engine);
  assert.equal(f.calls.generate.length,1);
  assert.match(f.calls.generate[0].system,/先判断这条群消息是否真的/);
  assert.ok(f.calls.generate[0].messages.some(m=>m.content.includes('周六九点')));
  assert.equal(f.calls.send[0].params.message[0].data.text,'末班是十点半。');

  response='[对象:他人][回应:正文]\n我替他答';
  await f.engine.receive(event('知道了','third-person',{user_id:'888'}));await settle(f.engine);
  assert.equal(f.calls.send.length,1);
  response='可以，我来试试';
  await f.engine.receive(event('试一下','plain-body',{user_id:'888'}));await settle(f.engine);
  assert.equal(f.calls.send.at(-1).params.message[0].data.text,response);
});
test('private plain group greeting and authorized group listing work without false inability',async t=>{const f=privateFixture(t);await f.engine.receive(friendEvent('那你去123这个群说话','relayplain'));await settle(f.engine);assert.equal(f.calls.send[0].action,'send_group_msg');const n=f.calls.generate.length;await f.engine.receive(friendEvent('你现在自己查查有哪些群可以去','relaylist'));await settle(f.engine);assert.equal(f.calls.generate.length,n);assert.match(f.calls.send.at(-1).params.message[0].data.text,/123/);});

test('reinforced context keeps the full persona before and after history and bills both',async t=>{const f=fixture(t,c=>{c.budget.maxInputTokens=6000;});f.store.setMeta('context:reinforce:123',true);await f.engine.receive(event('小星你好','reinforce'));await settle(f.engine);const input=f.calls.generate[0],prompt=f.store.config.personas[0].prompt;assert.ok(input.system.startsWith(prompt));assert.equal(input.messages.at(-1).role,'system');assert.ok(input.messages.at(-1).content.endsWith(prompt));});

test('long memory command sends all chunks despite ordinary reply cooldown without model calls',async t=>{const f=fixture(t,c=>{c.groups[0].cooldownSec=30;});f.engine.personality.edit('default',{text:'约定'.repeat(2000),enabled:true,revision:0});await f.engine.receive(event('/可变人格','long-memory'));await settle(f.engine);assert.equal(f.calls.generate.length,0);assert.equal(f.calls.send.length,3);assert.equal(f.calls.send.map(c=>c.params.message[0].data.text).join(''),'约定'.repeat(2000));});

test('voice decisions report exact TTS instructions and distinguish fallback from model tone',async t=>{const f=fixture(t,c=>{c.voice.enabled=true;c.groups[0].voiceMode='always';c.groups[0].dynamicVoiceTone=true;});await f.engine.receive(event('小星晚安','tone1'));await settle(f.engine);const d=f.store.getMeta('voice:last:123');assert.equal(d.instructions,f.calls.synthesize[0].config.instructions);assert.match(d.source,/本地语境规则/);assert.match(d.instructions,/睡前/);f.advance(1000);f.adapters.generate=async()=>({text:'[语音:轻快开心]你好',inputTokens:1,outputTokens:1});await f.engine.receive(event('小星你好','tone2'));await settle(f.engine);assert.match(f.store.getMeta('voice:last:123').source,/模型/);});

test('explicit style preference is learned with evidence even without triggering a reply',async t=>{const f=fixture(t);await f.engine.receive(event('你以后说话能不能可爱点','style-no-reply'));await settle(f.engine);assert.equal(f.calls.generate.length,0);const state=f.engine.learning.get('default');assert.equal(state.text,'说话可爱一点。');assert.equal(state.sources[state.text].messageId,'style-no-reply');assert.equal(state.sources[state.text].senderId,'777');});

test('private relay collects group member and body across separate user messages',async t=>{const f=privateFixture(t);const base=f.adapters.onebotCall;f.adapters.onebotCall=async(c,a,p)=>a==='get_group_member_list'?[{user_id:456,nickname:'小桃'}]:base(c,a,p);await f.engine.receive(friendEvent('去测试群那个群@小桃','rp1'));await settle(f.engine);await f.engine.receive(friendEvent('123','rp2'));await settle(f.engine);await f.engine.receive(friendEvent('说你好','rp3'));await settle(f.engine);assert.equal(f.calls.generate.length,0);assert.ok(f.calls.send.some(c=>c.action==='send_group_msg'&&c.params.group_id==='123'&&c.params.message.some(m=>m.type==='text'&&m.data.text==='你好')));});

test('vocative keyword and uninterrupted performance request both get normal replies',async t=>{
  const f=fixture(t,c=>Object.assign(c.groups[0],{turnCheckEnabled:true,replyProbability:1,keywords:['大肥鱼'],autoEmoji:false}));
  await f.engine.receive(event('大肥鱼出来','call'));await settle(f.engine);
  await f.engine.receive(event('表演个才艺','request'));await settle(f.engine);
  assert.equal(f.calls.send.length,2);
  assert.ok(f.calls.generate.every(i=>i.system.includes('本条已确认')));
});
test('reaction-only ignores judgement and attachment odds and uses no model',async t=>{
  const f=fixture(t,c=>Object.assign(c.groups[0],{turnCheckEnabled:false,turnCheckPercent:0,replyProbability:0,emojiProbability:0,reactionStyle:'only'}));
  await f.engine.receive(event('','explicit',{message:[{type:'at',data:{qq:'900'}}]}));await settle(f.engine);
  assert.equal(f.calls.generate.length,0);assert.equal(f.calls.send[0].params.message[0].type,'image');
});
test('independent reaction is possible even with zero attachment probability',async t=>{
  const f=fixture(t,c=>Object.assign(c.groups[0],{turnCheckEnabled:false,emojiProbability:0,reactionStyle:'allow'}));
  f.adapters.generate=async()=>({text:'[轻回应]',inputTokens:3,outputTokens:2});
  await f.engine.receive(event());await settle(f.engine);
  assert.equal(f.calls.send[0].params.message[0].type,'image');
});
test('zero contextual sampling keeps normal body and does not reply for an explicitly addressed third party',async t=>{
  const f=fixture(t,c=>Object.assign(c.groups[0],{turnCheckEnabled:true,turnCheckPercent:0,replyProbability:1}));
  await f.engine.receive(event('还有别的吗','amb'));await settle(f.engine);
  assert.doesNotMatch(f.calls.generate[0].system,/单独输出\[旁观\]/);
  await f.engine.receive(event('','other',{message:[{type:'at',data:{qq:'888'}},{type:'text',data:{text:'帮我看看'}}]}));await settle(f.engine);
  assert.equal(f.calls.send.length,1);
});
