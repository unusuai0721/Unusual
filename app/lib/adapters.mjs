import {MEME_TOOL,MEME_TOOL_BYTES} from './memewiki.mjs';
import qqFaces from './qq-faces.mjs';
import { checkedImage, qqImageUrl, IMAGE_TOKENS } from './vision.mjs';
// HTTP-only adapters. Output is text or a validated fixed dictionary query, never executable commands or filesystem paths.
const JSON_LIMIT = 2 * 1024 * 1024;
const AUDIO_LIMIT = 12 * 1024 * 1024;
const MAX_MESSAGE = 32_000;
const ONEBOT_ACTIONS = new Set(['get_qzone_msg_list','get_qzone_comment_list','get_qzone_comment_replies','comment_qzone','send_qzone_msg','get_login_info', 'get_group_list', 'get_status', 'send_group_msg', 'group_poke', 'send_private_msg', 'get_friend_list', 'friend_poke', 'get_group_member_list']);
const AUDIO_FORMATS = {
  mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg',
  aac: 'audio/aac', flac: 'audio/flac',
};

class AdapterError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function invalid(message) { throw new AdapterError(message, 'INVALID_CONFIG'); }
function string(value, maximum = MAX_MESSAGE) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function estimateTokens(text) { return Math.ceil(Buffer.byteLength(text, 'utf8') / 3); }

function baseUrl(value) {
  let url;
  try { url = new URL(value); } catch { invalid('接口地址无效，请填写完整的 HTTP 或 HTTPS 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) invalid('接口只允许 HTTP 或 HTTPS 协议。');
  if (url.username || url.password || url.search || url.hash) {
    invalid('接口地址不能包含账号、密码、查询参数或片段；密钥请填写在独立字段。');
  }
  if (url.href.length > 2048) invalid('接口地址过长。');
  return url;
}

function endpoint(value, suffix) {
  const url = baseUrl(value);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url;
}

function authHeaders(key) {
  const token = string(key, 4096).trim();
  if (/[\r\n]/.test(token)) invalid('接口密钥格式无效。');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Timeout covers both headers and body, including a server that stalls mid-stream.
// Never forward remote error bodies, URLs, or low-level errors: they can echo credentials.
async function request(url, { method = 'POST', body, headers = {}, timeoutMs = 45_000,
  limit = JSON_LIMIT, binary = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let reader;
  try {
    const response = await fetch(url, {
      method, redirect: 'manual', signal: controller.signal,
      headers: { Accept: binary ? 'audio/*, application/octet-stream' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new AdapterError('接口返回了重定向，已拒绝跟随；请直接填写最终接口地址。', 'REDIRECT_BLOCKED', response.status);
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '，请检查密钥与访问权限'
        : response.status === 429 ? '，请检查额度或稍后重试' : '';
      throw new AdapterError(`接口请求失败（HTTP ${response.status}）${hint}。`, 'HTTP_ERROR', response.status);
    }
    if (Number(response.headers.get('content-length')) > limit) {
      throw new AdapterError('接口响应超过允许的大小。', 'RESPONSE_TOO_LARGE');
    }
    reader = response.body?.getReader();
    if (!reader) throw new AdapterError('接口返回了空响应。', 'EMPTY_RESPONSE');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AdapterError('接口响应超过允许的大小。', 'RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks, size);
    if (binary) return { buffer, contentType: response.headers.get('content-type') || '', historyId:response.headers.get('history-item-id')||'' };
    let data;
    try { data = JSON.parse(buffer.toString('utf8')); }
    catch { throw new AdapterError('接口未返回有效的 JSON，请检查接口地址与服务类型。', 'INVALID_RESPONSE'); }
    if (!data || typeof data !== 'object') throw new AdapterError('接口返回的数据格式无效。', 'INVALID_RESPONSE');
    return data;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
      throw new AdapterError('接口请求超时，请检查网络或稍后重试。', 'REQUEST_TIMEOUT');
    }
    throw new AdapterError('无法连接接口，请检查地址、网络与服务运行状态。', 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { try { await reader.cancel(); } catch { /* already closed/aborted */ } }
  }
}

function chatInput(options) {
  const system = string(options.system, 200_000);
  const messages = (Array.isArray(options.messages) ? options.messages : []).slice(-200).map(message => {
    if (!['user', 'assistant', 'system'].includes(message?.role) || typeof message.content !== 'string') {
      invalid('消息仅支持 user、assistant、system 角色及纯文本内容。');
    }
    return { role: message.role, content: string(message.content, 200_000) };
  });
  if (!messages.length) invalid('发送给模型的消息不能为空。');
  const maxOutputTokens = Number(options.maxOutputTokens ?? 300);
  const temperature = Number(options.temperature ?? 0.8);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16_384) {
    invalid('输出 Token 上限应为 1 到 16384 的整数。');
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) invalid('温度应在 0 到 2 之间。');
  return { system, messages, maxOutputTokens, temperature,
    estimatedInput: estimateTokens(system) + messages.reduce((sum, item) => sum + estimateTokens(item.content) + 4, 0) + 4 };
}

function usage(input, output, fallbackInput, text) {
  return {
    inputTokens: nonNegativeInteger(input) ? input : fallbackInput,
    outputTokens: nonNegativeInteger(output) ? output : estimateTokens(text),
    estimated: !nonNegativeInteger(input) || !nonNegativeInteger(output),
  };
}

function memeCall(calls,enabled){
 if(!calls?.length)return {};
 if(!enabled||calls.length!==1||calls[0]?.name!=='search_meme_wiki')throw new AdapterError('模型请求了未开放或过多的词典操作。','INVALID_RESPONSE');
 let args=calls[0].args;try{if(typeof args==='string'){if(args.length>4096)throw Error();args=JSON.parse(args);}}catch{throw new AdapterError('模型查梗参数格式无效。','INVALID_RESPONSE');}
 if(!args||typeof args.query!=='string'||!args.query.trim()||args.query.length>120||Object.keys(args).some(k=>k!=='query'))throw new AdapterError('模型查梗参数无效。','INVALID_RESPONSE');
 return {memeQuery:args.query.trim()};
}
export async function generate(provider, options = {}) {
  if (!provider || provider.enabled === false) invalid('模型接口未启用。');
  const model = string(provider.model, 256).trim();
  if (!model) invalid('请先填写模型名称。');
  const input = chatInput(options);
  const images=(options.images||[]).slice(0,1).map(checkedImage);
  input.estimatedInput+=images.length*IMAGE_TOKENS+(options.memeTool===true?MEME_TOOL_BYTES:0);
  if (provider.type === 'gemini') {
    const modelId = model.replace(/^models\//, '');
    if (!/^[a-zA-Z0-9._-]+$/.test(modelId)) invalid('Gemini 模型名称格式无效。');
    const url = baseUrl(provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
    const prefix = url.pathname.replace(/\/+$/, '') || '/v1beta';
    url.pathname = `${prefix}/models/${modelId}:generateContent`;
    const systemParts = [input.system, ...input.messages.filter(item => item.role === 'system').map(item => item.content)].filter(Boolean);
    const contents = [];
    for (const message of input.messages.filter(item => item.role !== 'system')) {
      const role = message.role === 'assistant' ? 'model' : 'user';
      // Consecutive messages of the same role are represented as parts of a single turn.
      if (contents.at(-1)?.role === role) contents.at(-1).parts.push({ text: message.content });
      else contents.push({ role, parts: [{ text: message.content }] });
    }
    if (!contents.length) invalid('Gemini 至少需要一条用户或助手消息。');
    if(images.length){const turn=contents.findLast(item=>item.role==='user');if(!turn)invalid('识图需要用户消息');for(const image of images){const [head,data]=image.split(',');turn.parts.push({inlineData:{mimeType:head.slice(5,-7),data}});}}
    const key = string(provider.apiKey, 4096).trim();
    if (/[\r\n]/.test(key)) invalid('接口密钥格式无效。');
    const generationConfig = { maxOutputTokens: input.maxOutputTokens, temperature: input.temperature, candidateCount: 1 };
    // Flash 2.5 supports zero thinking budget. Pro requires reasoning and is left untouched.
    if (/^gemini-2\.5-flash(?:-|$)/.test(modelId)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const response = await request(url, {
      headers: key ? { 'x-goog-api-key': key } : {},
      body: { contents, ...(options.memeTool===true?{tools:[{functionDeclarations:[{name:MEME_TOOL.name,description:MEME_TOOL.description,parameters:{type:'OBJECT',properties:{query:{type:'STRING',description:'要查询的梗名或缩写，最多120字'}},required:['query']}}]}]}:{}), ...(systemParts.length ? { systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] } } : {}), generationConfig },
    });
    if (response.error) throw new AdapterError('Gemini 返回错误，请检查模型、密钥和额度。', 'PROVIDER_ERROR');
    const parts = response.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.filter(part => part && part.thought !== true && typeof part.text === 'string')
      .map(part => part.text).join('').trim() : '';
    const meta = response.usageMetadata || {};
    let output;
    if (nonNegativeInteger(meta.candidatesTokenCount)) output = meta.candidatesTokenCount + (nonNegativeInteger(meta.thoughtsTokenCount) ? meta.thoughtsTokenCount : 0);
    if (nonNegativeInteger(meta.totalTokenCount) && nonNegativeInteger(meta.promptTokenCount)) {
      output = Math.max(output ?? 0, meta.totalTokenCount - meta.promptTokenCount);
    }
    return { text, ...memeCall((parts||[]).filter(p=>p.functionCall&&p.thought!==true).map(p=>p.functionCall),options.memeTool===true), ...usage(meta.promptTokenCount, output, input.estimatedInput, text) };
  }
  if (provider.type !== 'openai') invalid('不支持的模型接口类型。');
  const url = endpoint(provider.baseUrl, '/chat/completions');
  if(images.length){const turn=input.messages.findLast(item=>item.role==='user');if(!turn)invalid('识图需要用户消息');turn.content=[{type:'text',text:turn.content},...images.map(url=>({type:'image_url',image_url:{url,detail:'low'}}))];}
  const body = {
    model, messages: [...(input.system ? [{ role: 'system', content: input.system }] : []), ...input.messages],
    max_tokens: input.maxOutputTokens, temperature: input.temperature, stream: false,
    ...(options.memeTool===true?{tools:[{type:'function',function:MEME_TOOL}],tool_choice:'auto',parallel_tool_calls:false}:{}),
  };
  // This is a documented DeepSeek extension; do not send it to unrelated compatible APIs.
  if (url.hostname === 'api.deepseek.com' && /^deepseek-/.test(model)) body.thinking = { type: 'disabled' };
  const response = await request(url, { headers: authHeaders(provider.apiKey), body });
  if (response.error) throw new AdapterError('模型接口返回错误，请检查模型、密钥和额度。', 'PROVIDER_ERROR');
  if (!Array.isArray(response.choices)) throw new AdapterError('模型接口缺少 choices，请检查接口类型。', 'INVALID_RESPONSE');
  const content = response.choices[0]?.message?.content;
  const text = (typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '').trim();
  return { text, ...memeCall((response.choices[0]?.message?.tool_calls||[]).map(c=>({name:c.function?.name,args:c.function?.arguments})),options.memeTool===true), ...usage(response.usage?.prompt_tokens, response.usage?.completion_tokens, input.estimatedInput, text) };
}

function searchResults(results, maximum) {
  if (!Array.isArray(results)) throw new AdapterError('搜索接口未返回结果列表。', 'INVALID_RESPONSE');
  const output = [];
  const seen = new Set();
  for (const item of results) {
    if (!item || typeof item.url !== 'string') continue;
    let url;
    try { url = new URL(item.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
    if (url.href.length > 2048) continue;
    seen.add(url.href);
    output.push({ title: string(item.title, 180) || url.hostname, url: url.href, content: string(item.content, 1400) });
    if (output.length >= maximum) break;
  }
  return output;
}

export async function searchWeb(config, query) {
  if (!config?.enabled) return [];
  const text = string(query, 1500).trim();
  if (!text) return [];
  const maximum = Math.max(1, Math.min(5, Math.floor(Number(config.maxResults) || 3)));
  if (config.type === 'tavily') {
    if (!string(config.apiKey).trim()) invalid('请填写 Tavily API 密钥。');
    const response = await request(endpoint(config.baseUrl || 'https://api.tavily.com', '/search'), {
      headers: authHeaders(config.apiKey), timeoutMs: 20_000,
      body: { query: text, search_depth: 'basic', max_results: maximum, include_answer: false,
        include_raw_content: false, include_images: false, auto_parameters: false },
    });
    return searchResults(response.results, maximum);
  }
  if (config.type === 'searxng') {
    const url = endpoint(config.baseUrl, '/search');
    url.searchParams.set('q', text);
    url.searchParams.set('format', 'json');
    const response = await request(url, { method: 'GET', headers: authHeaders(config.apiKey), timeoutMs: 20_000 });
    return searchResults(response.results, maximum);
  }
  invalid('不支持的搜索服务类型。');
}

function qqId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^[1-9]\d{0,19}$/.test(id) ? id : '';
}

function outgoingMessage(message) {
  if (typeof message === 'string') {
    if (!message || message.length > MAX_MESSAGE) invalid('群消息为空或过长。');
    return message;
  }
  if (!Array.isArray(message) || !message.length || message.length > 20) invalid('群消息格式无效。');
  return message.map(segment => {
    if (segment?.type === 'text') {
      if (typeof segment.data?.text !== 'string' || segment.data.text.length > MAX_MESSAGE) invalid('文本消息格式无效。');
      return { type: 'text', data: { text: segment.data.text } };
    }
    if(segment?.type==='reply'){const id=String(segment.data?.id||'');if(!/^-?\d{1,20}$/.test(id))invalid('引用消息 ID 无效');return {type:'reply',data:{id}};}
    if(segment?.type==='at'){const qq=qqId(segment.data?.qq);if(!qq)invalid('只能艾特具体 QQ 成员');return {type:'at',data:{qq}};}
    if (segment?.type === 'image' || segment?.type === 'record') {
      const file = segment.data?.file;
      const maximum = segment.type === 'image' ? 7 * 1024 * 1024 : 17 * 1024 * 1024;
      if (typeof file !== 'string' || file.length > maximum || !/^base64:\/\/[A-Za-z0-9+/]+={0,2}$/.test(file)) {
        invalid('图片和语音只允许发送软件目录中已读取的 Base64 数据。');
      }
      return { type: segment.type, data: { file } };
    }
    invalid('不支持的群消息类型；只允许文字、引用、成员艾特、本地表情包和语音。');
  });
}

export async function onebotCall(config, action, params = {}) {
  if (!ONEBOT_ACTIONS.has(action)) invalid('未授权的 OneBot 操作。');
  let body = {};
  if(['get_qzone_msg_list','get_qzone_comment_list','get_qzone_comment_replies','comment_qzone'].includes(action))body=params;
  if(action==='send_qzone_msg'){
    if(typeof params.content!=='string'||!params.content.trim()||params.content.length>1600||params.ugc_right!==4)invalid('动态发布参数无效');
    body={content:params.content,ugc_right:4};
    if(params.images){if(params.images.length!==1||!params.images[0].startsWith('file:///'))invalid('动态图片无效');body.images=params.images;}
  }
  if(action==='send_private_msg'){const userId=qqId(params.user_id);if(!userId)invalid('好友 QQ 号无效');body={user_id:userId,message:outgoingMessage(params.message),auto_escape:true};}
  if(action==='friend_poke'){const userId=qqId(params.user_id);if(!userId)invalid('好友 QQ 号无效');body={user_id:userId};}
  if(action==='get_group_member_list'){const groupId=qqId(params.group_id);if(!groupId)invalid('群号无效');body={group_id:groupId};}
  if (action === 'send_group_msg') {
    const groupId = qqId(params.group_id);
    if (!groupId) invalid('QQ群号格式无效。');
    body = { group_id: groupId, message: outgoingMessage(params.message), auto_escape: true };
  }
  if(action==='group_poke'){const group=qqId(params.group_id),user=qqId(params.user_id);if(!group||!user)invalid('戳一戳必须指定有效群号和成员');body={group_id:group,user_id:user};}
  const response = await request(endpoint(config?.baseUrl, `/${action}`), {
    body, headers: authHeaders(config?.accessToken), timeoutMs: 15_000,
  });
  if (response.status !== 'ok' || ![0, '0'].includes(response.retcode)) {
    const code = Number.isSafeInteger(Number(response.retcode)) ? Number(response.retcode) : '未知';
    throw new AdapterError(`OneBot 操作失败（返回码 ${code}），请检查桥接器日志。`, 'ONEBOT_ERROR');
  }
  if (['send_group_msg','send_private_msg'].includes(action) && !/^-?\d+$/.test(String(response.data?.message_id ?? ''))) {
    throw new AdapterError('OneBot 未返回消息 ID，无法确认发送成功。', 'INVALID_RESPONSE');
  }
  return response.data;
}

export async function listBreezeVoices(config, {page=1,search='',favorites=false,language='zh'}={}) {
  if(config.type!=='breeze'||!config.apiKey)invalid('请先保存 Breeze 密钥与服务类型。');
  const url=new URL('https://api.breeze.blue/v1/voices');
  url.searchParams.set('page',String(Math.max(1,Math.min(10000,Math.floor(Number(page)||1)))));url.searchParams.set('page_size','100');
  if(search)url.searchParams.set('search',String(search).slice(0,100));
  if(language==='zh')url.searchParams.set('language_code','zh');
  if(favorites)url.searchParams.set('favorites_only','true');
  const data=await request(url,{method:'GET',headers:{'xi-api-key':config.apiKey},timeoutMs:20000});
  return {voices:(Array.isArray(data.voices)?data.voices:[]).map(v=>({voice_id:string(v.voice_id,200),name:string(v.name,200),language_code:string(v.language_code,20),description:string(v.description,500),gender:string(v.gender,20),age:string(v.age,20),tone:Array.isArray(v.tone)?v.tone.slice(0,3).map(x=>string(x,40)):[],is_favorited:!!v.is_favorited})),has_more:!!data.has_more,total:Number(data.total)||0};
}

function billingRow(h){const mc=h?.cost_millicredits;return {id:string(h?.history_item_id,200),voice:string(h?.voice_name,200),text:string(h?.text,120),state:string(h?.state,60),date:Number(h?.date_unix)||0,credits:typeof mc==='number'&&Number.isFinite(mc)&&mc>=0?mc/1000:null};}
export async function breezeBilling(config, historyId='') {
 if(config.type!=='breeze'||!config.apiKey)invalid('请先配置 Breeze 接口');
 const suffix=historyId?'/'+encodeURIComponent(historyId):'?page_size=30';
 const d=await request('https://api.breeze.blue/v1/history'+suffix,{method:'GET',headers:{'xi-api-key':config.apiKey},timeoutMs:5000});
 return historyId?billingRow(d):{items:(Array.isArray(d.history)?d.history:[]).map(billingRow)};
}
export async function synthesize(config, text) {
  if (!config?.enabled) invalid('语音接口未启用。');
  const input = string(text, 4097).trim();
  if (!input || input.length > 4096) invalid('语音文本应为 1 到 4096 个字符。');
  const format = config.format || 'mp3';
  if (!Object.hasOwn(AUDIO_FORMATS, format)) invalid('不支持的语音输出格式。');
  const breeze=config.type==='breeze';
  if(breeze&&(!config.apiKey||!/^[-a-zA-Z0-9_]+$/.test(config.voice||'')))invalid('请填写 Breeze 密钥并选择有效音色。');
  if(breeze&&input.length>1000)invalid('Breeze 单次语音最多 1000 字，请缩短回复。');
  const target=breeze?new URL('https://api.breeze.blue/v1/text-to-speech/'+encodeURIComponent(config.voice)):endpoint(config.baseUrl,'/audio/speech');
  if(breeze)target.searchParams.set('output_format',format);
  const { buffer, contentType, historyId } = await request(target, {
    headers:breeze?{'xi-api-key':config.apiKey}:authHeaders(config.apiKey), binary:true,timeoutMs:60000,limit:AUDIO_LIMIT,
    body:breeze?{text:input,model_id:config.model||'breeze-tts-2',instructions:config.instructions||'',voice_settings:{guidance_scale:config.guidanceScale??4}}:{model:string(config.model,256)||'tts-1',voice:string(config.voice,128)||'alloy',input,response_format:format},
  });
  if (!buffer.length || !/^(audio\/|application\/octet-stream(?:;|$))/i.test(contentType)) {
    throw new AdapterError('语音接口没有返回音频，请检查兼容性与输出格式。', 'INVALID_RESPONSE');
  }
  let billing=null;if(breeze&&historyId){try{billing=await breezeBilling(config,historyId);if(billing.id!==historyId)billing={id:historyId,credits:null};}catch{billing={id:historyId,credits:null};}}
  return { buffer, extension: format === 'opus' ? 'ogg' : format, mime: AUDIO_FORMATS[format],...(breeze?{billing}: {}) };
}

function decodeCq(text) {
  // Decode once, after segment recognition, so escaped literal CQ never becomes an action.
  return text.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
}

function cqSegments(message) {
  const segments = [];
  const pattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g;
  let previous = 0;
  for (const match of message.matchAll(pattern)) {
    if (segments.length >= 255) break;
    if (match.index > previous) segments.push({ type: 'text', data: { text: decodeCq(message.slice(previous, match.index)) } });
    const data = {};
    for (const field of match[2].split(',').slice(1, 17)) {
      const separator = field.indexOf('=');
      if (separator <= 0) continue;
      const key = field.slice(0, separator);
      if (/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key) && !['constructor', '__proto__', 'prototype'].includes(key)) {
        data[key] = decodeCq(field.slice(separator + 1, separator + 4097));
      }
    }
    segments.push({ type: match[1], data });
    previous = match.index + match[0].length;
  }
  if (previous < message.length) segments.push({ type: 'text', data: { text: decodeCq(message.slice(previous)) } });
  return segments;
}

function normalizeSegments(message) {
  return message.slice(0, 256).filter(segment => segment && typeof segment.type === 'string').map(segment => {
    const type = string(segment.type, 32);
    const data = {};
    // Attachment URLs are later validated by a fixed QQ CDN allowlist. Never retain local file paths.
    for (const key of ['text', 'qq', 'id', 'name', 'url']) {
      const value = key==='url'?(qqImageUrl(segment.data?.[key])||qqImageUrl(segment.data?.file)):segment.data?.[key];
      if (typeof value === 'string' || typeof value === 'number') data[key] = String(value).slice(0, key === 'text' ? MAX_MESSAGE : key === 'url' ? 8192 : 256);
    }
    return { type, data };
  });
}

export function parseOneBotEvent(event) {
  if (!event || event.post_type !== 'message' || !['group','private'].includes(event.message_type) || event.sub_type === 'notice') return null;
  if(event.message_type==='private'&&event.sub_type!=='friend')return null;
  const groupId = event.message_type==='private'?'private:'+qqId(event.user_id ?? event.sender?.user_id):qqId(event.group_id);
  const senderId = qqId(event.user_id ?? event.sender?.user_id);
  if (!groupId || !senderId) return null;
  const selfId = qqId(event.self_id);
  const raw = event.message ?? event.raw_message;
  const segments = Array.isArray(raw) ? normalizeSegments(raw)
    : typeof raw === 'string' ? normalizeSegments(cqSegments(raw.slice(0, 65_536))) : [];
  const mentioned = Boolean(selfId) && segments.some(segment => segment.type === 'at' && String(segment.data.qq) === selfId);
  const labels = { image: '[图片]', record: '[语音]', video: '[视频]', face: '[表情]', file: '[文件]',
    forward: '[转发消息]', json: '[卡片消息]', xml: '[卡片消息]', share: '[分享]', location: '[位置]', poke: '[戳一戳]' };
  const content = segments.map(segment => {
    if (segment.type === 'text') return segment.data.text || '';
    if (segment.type === 'at') return segment.data.qq === 'all' ? '@全体成员 ' : `@${qqId(segment.data.qq) || '成员'} `;
    if (segment.type === 'reply') return '';
    if (segment.type === 'face') return '[QQ表情:'+ (qqFaces[segment.data.id]||('编号'+String(segment.data.id||'未知'))) +']';
    return Object.hasOwn(labels, segment.type) ? labels[segment.type] : '[消息]';
  }).join('').trim().slice(0, MAX_MESSAGE);
  if (!content) return null;
  const rawId = event.message_id;
  const messageId = (typeof rawId === 'string' || typeof rawId === 'number') ? String(rawId).slice(0, 128) : '';
  return { groupId, senderId, senderName: string(event.sender?.card, 120) || string(event.sender?.nickname, 120) || senderId,
    content, messageId, selfId, mentioned, segments };
}

export async function listBreezeModels(config) {
 if(config.type!=='breeze'||!config.apiKey)invalid('请先保存 Breeze 密钥');
 const data=await request('https://api.breeze.blue/v1/models',{method:'GET',headers:{'xi-api-key':config.apiKey},timeoutMs:15000});
 if(!Array.isArray(data))invalid('官方模型列表格式不正确');
 return data.slice(0,100).filter(m=>typeof m.model_id==='string'&&/^[-a-zA-Z0-9_]{1,160}$/.test(m.model_id)).map(m=>({id:m.model_id,name:string(m.name,200)||m.model_id,languages:(m.languages||[]).map(l=>string(l.language_id,12)).slice(0,200)}));
}

export async function listModels(provider){
 const gemini=provider.type==='gemini',items=[];let page='';
 for(let i=0;i<(gemini?10:1);i++){
  const url=endpoint(provider.baseUrl,'/models');if(gemini){url.searchParams.set('pageSize','100');if(page)url.searchParams.set('pageToken',page);}
  const data=await request(url,{method:'GET',headers:gemini?{'x-goog-api-key':provider.apiKey}:authHeaders(provider.apiKey),timeoutMs:15000});
  const rows=gemini?data.models:data.data;if(!Array.isArray(rows))invalid('模型列表格式无效');
  for(const m of rows){if(gemini&&m.supportedGenerationMethods&&!m.supportedGenerationMethods.includes('generateContent'))continue;const id=string(gemini?m.name?.replace(/^models\//,''):m.id,200);if(!id||items.some(x=>x.id===id))continue;items.push({id,name:string(m.displayName||m.name||id,200),inputModalities:Array.isArray(m.input_modalities)?m.input_modalities.filter(x=>['text','image','audio'].includes(x)):[],contextWindow:m.context_window||m.inputTokenLimit||null});}
  if(!gemini||!data.nextPageToken)break;if(data.nextPageToken===page)invalid('模型列表分页重复');page=string(data.nextPageToken,1000);
 }
 return items;
}
