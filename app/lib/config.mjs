import { randomBytes } from 'node:crypto';

export const token = () => randomBytes(24).toString('hex');
export function defaultConfig() {
  return {
    version: 1, bot: { enabled: false, name: 'Unusual', selfId: '' },
    providers: [
      { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '', enabled: true },
      { id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite', apiKey: '', enabled: false },
    ], defaultProviderId: 'deepseek', defaultPersonaId: '',
    personas: [],
    official: { enabled:false, appId:'', appSecret:'' }, groups: [], onebot: { baseUrl: 'http://127.0.0.1:3000', accessToken: '', webhookToken: token(), secret: '' },
    budget: { dailyTokenLimit: 30000, maxInputTokens: 3500, maxOutputTokens: 300, contextMessages: 18, retentionDays: 90 },
    search: { enabled: false, type: 'tavily', baseUrl: 'https://api.tavily.com', apiKey: '', maxResults: 3, triggerKeywords: ['搜索', '查一下', '最新'] },
    voice: { enabled: false, baseUrl: '', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' },
    api: { enabled: true, token: token() },
  };
}
const str = (x, name, max = 200, optional = false) => {
  if (typeof x !== 'string' || x.length > max || (!optional && !x.trim())) throw new Error(`${name}不能为空且不得超过 ${max} 个字符`);
  return x;
};
const num = (x, name, min, max, integer = true) => {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max || (integer && !Number.isInteger(x))) throw new Error(`${name}必须为 ${min} 到 ${max} 之间的${integer ? '整数' : '数字'}`);
  return x;
};
const bool = x => x === true;
const id = (x, name) => { str(x, name, 80); if (!/^[a-zA-Z0-9_-]+$/.test(x)) throw new Error(`${name}仅允许字母、数字、下划线和短横线`); return x; };
const list = (x, name, max = 100) => { if (!Array.isArray(x) || x.length > max) throw new Error(`${name}最多 ${max} 项`); return x; };
const strings = (x, name, max = 100, len = 100) => list(x || [], name, max).map(v => str(v, name, len));
const pick = (x, values, name) => { if (!values.includes(x)) throw new Error(`${name}不支持该选项`); return x; };
function url(x, name, optional = false) {
  str(x, name, 1000, optional); if (!x && optional) return '';
  let u; try { u = new URL(x); } catch { throw new Error(`${name}不是有效网址`); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error(`${name}只支持不含用户信息、查询或片段的 HTTP(S) 地址`);
  if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`${name}远程连接必须使用 HTTPS；HTTP 仅限本机`);
  return x.replace(/\/+$/, '');
}
function unique(items, name) { if (new Set(items.map(v => v.id)).size !== items.length) throw new Error(`${name} ID 不能重复`); }
const clock = x => { if (x === '') return ''; if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw new Error('免打扰时间须为 HH:mm 格式'); return x; };
export function validateConfig(c) {
  if (!c || typeof c !== 'object') throw new Error('配置格式不正确');
  const b = c.bot || {}, o = c.onebot || {}, k = c.budget || {}, s = c.search || {}, v = c.voice || {}, a = c.api || {};
  const providers = list(c.providers, '模型接口', 30).map(p => ({ id: id(p.id, '接口 ID'), name: str(p.name, '接口名称'), type: pick(p.type, ['openai', 'gemini'], '接口类型'), baseUrl: url(p.baseUrl, '接口地址'), model: str(p.model, '模型名称', 160), apiKey: str(p.apiKey || '', 'API Key', 4096, true), enabled: bool(p.enabled) }));
  const personas = list(c.personas, '人设', 100).map(p => ({ id: id(p.id, '人设 ID'), name: str(p.name, '人设名称'), description: str(p.description || '', '人设描述', 1000, true), prompt: str(p.prompt ?? '', '人设提示词', 20000, true), injectionMode: pick(p.injectionMode || 'legacy', ['legacy','single','double','tail','reminder'], '人设注入方式'), temperature: num(p.temperature ?? 0.8, '温度', 0, 2, false) }));
  if (!providers.length) throw new Error('请至少保留一个模型接口');
  unique(providers, '接口'); unique(personas, '人设');
  const defaultProviderId = id(c.defaultProviderId, '默认接口'), defaultPersonaId = c.defaultPersonaId ? id(c.defaultPersonaId, '默认人设') : '';
  if (!providers.some(p => p.id === defaultProviderId) || (defaultPersonaId && !personas.some(p => p.id === defaultPersonaId))) throw new Error('默认接口或人设不存在');
  const official = { enabled:bool(c.official?.enabled), appId:str(c.official?.appId || '', '官方 AppID', 30, true), appSecret:str(c.official?.appSecret || '', '官方 AppSecret', 4096, true) };
  if (official.appId && !/^[1-9]\d{0,29}$/.test(official.appId)) throw new Error('官方 AppID 必须为数字');
  if (official.enabled && (!official.appId || !official.appSecret)) throw new Error('请填写官方 AppID 和 AppSecret');
  const groups = list(c.groups, 'QQ群', 200).map(g => {
    const channel = g.channel || 'napcat';
    if (!['napcat','official'].includes(channel)) throw new Error('未知群连接类型');
    if (typeof g.id !== 'string' || !(channel==='official' ? /^official:[1-9]\d{0,29}:[A-Za-z0-9_-]{1,128}$/ : /^(?:private:)?[1-9]\d{0,19}$/).test(g.id)) throw new Error('群标识格式不正确');
    if (!providers.some(p => p.id === g.providerId) || (g.personaId && !personas.some(p => p.id === g.personaId))) throw new Error(`群 ${g.name || g.id} 绑定的接口或人设不存在`);
    const pr = g.proactive || {};
    return { id: g.id, channel, relayTargets:strings(g.relayTargets,'转达目标群',200,80).filter(v=>/^[1-9]\d{0,19}$/.test(v)),sharedTargets:strings(g.sharedTargets,'共享记忆目标群',200,80).filter(v=>/^[1-9]\d{0,19}$/.test(v)), name: str(g.name || g.id, '群名称'), enabled: bool(g.enabled), personaId: g.personaId || '', providerId: g.providerId, replyMode: pick(g.replyMode || 'smart', ['smart', 'all', 'keywords', 'mention'], '回复模式'), keywords: strings(g.keywords, '关键词', 40), replyProbability: num(g.replyProbability ?? 0.08, '主动接话概率', 0, 1, false), cooldownSec: num(g.cooldownSec ?? 45, '冷却时间', 0, 86400), debounceSec: num(g.debounceSec ?? 3, '消息合并时间', 0, 60), mentionReply: bool(g.mentionReply ?? true), ignoreUserIds: strings(g.ignoreUserIds, '忽略用户', 200, 128), maxRepliesPerHour: num(g.maxRepliesPerHour ?? 20, '每小时回复上限', 1, Number.MAX_SAFE_INTEGER), quietStart: clock(g.quietStart ?? '23:00'), quietEnd: clock(g.quietEnd ?? '08:00'), proactive: { enabled: bool(pr.enabled), randomMeme:bool(pr.randomMeme ?? false), intervalMin: num(pr.intervalMin ?? 120, '主动发言间隔', 1, 10080), prompt: str(pr.prompt || '自然地发起一个轻松话题。', '主动发言提示', 4000) }, autoEmoji: bool(g.autoEmoji ?? true), emojiProbability:num(g.emojiProbability??35,'表情发送概率',0,100),quoteReply:bool(g.quoteReply??true),allowMention:bool(g.allowMention??true),allowPoke:bool(g.allowPoke??true),pokeIntervalSec:num(g.pokeIntervalSec??300,'戳一戳间隔',60,86400), visionEnabled:bool(g.visionEnabled ?? true), voiceId:str(g.voiceId||'','本群音色',200,true),voiceInstructions:str(g.voiceInstructions||'','本群语气',2000,true),voiceMode:pick(g.voiceMode||(g.autoVoice?'always':'text'),['text','auto','always'],'回复形式'),dynamicVoiceTone:bool(g.dynamicVoiceTone??true),voiceIntervalSec:num(g.voiceIntervalSec??120,'语音最短间隔',0,86400),voiceMaxChars:num(g.voiceMaxChars??200,'自动语音最大字数',10,1000),autoVoice: g.voiceMode?g.voiceMode==='always':bool(g.autoVoice) };
  });
  unique(groups, 'QQ群');
  const webhookToken = str(o.webhookToken, '上报令牌', 256), apiToken = str(a.token, '本机 API 令牌', 256);
  if (webhookToken.length < 24 || apiToken.length < 24 || webhookToken === apiToken) throw new Error('上报和 API 令牌至少 24 位且不能相同');
  return { version: 1, official, bot: { enabled: bool(b.enabled), name: str(b.name || 'Unusual', '机器人名称'), selfId: str(b.selfId || '', '机器人 QQ', 30, true) }, providers, personas, defaultProviderId, defaultPersonaId, groups,
    onebot: { baseUrl: url(o.baseUrl, 'OneBot 地址'), accessToken: str(o.accessToken || '', 'OneBot Token', 4096, true), webhookToken, secret: str(o.secret || '', 'HMAC secret', 4096, true) },
    budget: { dailyTokenLimit: num(k.dailyTokenLimit, '每日 token 上限', 100, 100000000), maxInputTokens: num(k.maxInputTokens, '输入 token 上限', 256, 128000), maxOutputTokens: num(k.maxOutputTokens, '输出 token 上限', 16, 16000), contextMessages: num(k.contextMessages, '上下文条数', 0, 200), retentionDays: num(k.retentionDays, '记录保留天数', 1, 3650) },
    search: { enabled: bool(s.enabled), type: pick(s.type, ['tavily', 'searxng'], '搜索类型'), baseUrl: url(s.baseUrl, '搜索地址'), apiKey: str(s.apiKey || '', '搜索 Key', 4096, true), maxResults: num(s.maxResults, '搜索条数', 1, 5), triggerKeywords: strings(s.triggerKeywords, '搜索触发词', 40) },
    voice: { type:pick(v.type||'openai',['openai','breeze'],'语音服务类型'), instructions:str(v.instructions||'','语气指令',2000,true), guidanceScale:num(v.guidanceScale??4,'语气引导强度',0,10,false), testText:str(v.testText||'晚上好，你们刚才在聊什么？','试音文本',500), enabled: bool(v.enabled), baseUrl: url(v.baseUrl || '', '语音地址', true), apiKey: str(v.apiKey || '', '语音 Key', 4096, true), model: str(v.model || 'tts-1', '语音模型'), voice: str(v.voice || 'alloy', '音色'), format: pick(v.format || 'mp3', ['mp3', 'wav', 'opus', 'aac', 'flac'], '音频格式') },
    api: { enabled: bool(a.enabled), token: apiToken } };
}
