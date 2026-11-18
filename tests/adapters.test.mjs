import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generate, searchWeb, onebotCall, synthesize, parseOneBotEvent } from '../app/lib/adapters.mjs';

async function serverFor(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const received = { url: request.url, method: request.method, headers: request.headers, body: raw ? JSON.parse(raw) : null };
    requests.push(received);
    try { await handler(received, response); }
    catch { response.writeHead(500); response.end('fixture failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function json(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}
function provider(baseUrl, extra = {}) {
  return { type: 'openai', model: 'test-chat', baseUrl, apiKey: 'test-api-secret', enabled: true, ...extra };
}
const prompt = { system: '你是小星。', messages: [{ role: 'user', content: '你好' }], maxOutputTokens: 90, temperature: 0.6 };
const completion = { choices: [{ message: { role: 'assistant', content: '  你好呀！  ' } }], usage: { prompt_tokens: 18, completion_tokens: 5 } };

test('OpenAI compatible endpoint sends bounded plain text messages and reports real usage', async t => {
  const service = await serverFor(t, (request, response) => json(response, completion));
  const result = await generate(provider(`${service.baseUrl}/v1`), { ...prompt, tools: [{ type: 'computer' }] });
  assert.deepEqual(result, { text: '你好呀！', inputTokens: 18, outputTokens: 5, estimated: false });
  const [request] = service.requests;
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer test-api-secret');
  assert.deepEqual(request.body.messages, [{ role: 'system', content: '你是小星。' }, ...prompt.messages]);
  assert.equal(request.body.max_tokens, 90);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.tools, undefined);
  assert.equal(request.body.functions, undefined);
  assert.equal(request.body.thinking, undefined);
});

test('DeepSeek official endpoint disables thinking without leaking key in URL', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(JSON.parse(options.body).thinking, { type: 'disabled' });
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(completion);
  });
  await generate(provider('https://api.deepseek.com', { model: 'deepseek-flash' }), prompt);
});

test('Gemini maps history and instructions, excludes thoughts and bills reasoning tokens', async t => {
  const service = await serverFor(t, (request, response) => json(response, {
    candidates: [{ content: { parts: [{ text: 'private thought', thought: true }, { text: '晚安' }] } }],
    usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 2, thoughtsTokenCount: 13, totalTokenCount: 40 },
  }));
  const result = await generate(provider(service.baseUrl, { type: 'gemini', model: 'models/gemini-2.5-flash' }), {
    ...prompt, messages: [{ role: 'system', content: '保持简短' }, { role: 'user', content: '晚上好' }, { role: 'user', content: '该睡了' }],
  });
  assert.deepEqual(result, { text: '晚安', inputTokens: 25, outputTokens: 15, estimated: false });
  const request = service.requests[0];
  assert.equal(request.url, '/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(request.headers['x-goog-api-key'], 'test-api-secret');
  assert.equal(request.body.systemInstruction.parts[0].text, '你是小星。\n\n保持简短');
  assert.deepEqual(request.body.contents, [{ role: 'user', parts: [{ text: '晚上好' }, { text: '该睡了' }] }]);
  assert.deepEqual(request.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(request.body.generationConfig.maxOutputTokens, 90);
  assert.equal(request.body.tools, undefined);
});

test('Gemini preserves configured version prefix and returns usage for blocked empty output', async t => {
  const service = await serverFor(t, (request, response) => json(response, {
    candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 9, totalTokenCount: 9 },
  }));
  const result = await generate(provider(`${service.baseUrl}/v1`, { type: 'gemini', model: 'gemini-2.5-pro' }), prompt);
  assert.deepEqual(result, { text: '', inputTokens: 9, outputTokens: 0, estimated: false });
  assert.equal(service.requests[0].url, '/v1/models/gemini-2.5-pro:generateContent');
  assert.equal(service.requests[0].body.generationConfig.thinkingConfig, undefined);
});

test('missing provider usage is explicitly estimated', async t => {
  const service = await serverFor(t, (request, response) => json(response, { choices: [{ message: { content: '测试回答' } }] }));
  const result = await generate(provider(service.baseUrl), prompt);
  assert.equal(result.estimated, true);
  assert.ok(result.inputTokens > 0);
  assert.equal(result.outputTokens, 4);
});

test('provider errors never expose reflected credentials, body text or unsafe URL', async t => {
  const service = await serverFor(t, (request, response) => json(response, { error: 'test-api-secret sensitive input' }, 401));
  await assert.rejects(generate(provider(service.baseUrl), prompt), error => {
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /test-api-secret|sensitive input|127\.0\.0\.1/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('redirects are refused rather than forwarding authorization', async t => {
  const service = await serverFor(t, (request, response) => {
    response.writeHead(302, { Location: '/redirect-target' });
    response.end();
  });
  await assert.rejects(generate(provider(service.baseUrl), prompt), { code: 'REDIRECT_BLOCKED' });
  assert.equal(service.requests.length, 1);
});

test('unsafe protocols and credential-bearing base URLs are rejected before network', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('unexpected'); });
  for (const baseUrl of ['file:///C:/secret', 'ftp://localhost', 'https://user:secret@example.org', 'https://example.org?key=secret', 'https://example.org#secret']) {
    await assert.rejects(generate(provider(baseUrl), prompt), { code: 'INVALID_CONFIG' });
  }
  await assert.rejects(generate(provider('https://example.org'), { ...prompt, messages: [{ role: 'tool', content: 'read file' }] }), { code: 'INVALID_CONFIG' });
  await assert.rejects(generate(provider('https://example.org'), { ...prompt, maxOutputTokens: 0 }), { code: 'INVALID_CONFIG' });
  assert.equal(calls, 0);
});

test('body size limits apply to advertised and chunked responses', async t => {
  const service = await serverFor(t, (request, response) => {
    if (request.url.startsWith('/advertised')) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 3 * 1024 * 1024 });
      response.end('{}');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('x'.repeat(2 * 1024 * 1024));
      response.end('overflow');
    }
  });
  for (const prefix of ['/advertised', '/chunked']) {
    await assert.rejects(generate(provider(service.baseUrl + prefix), prompt), { code: 'RESPONSE_TOO_LARGE' });
  }
});

test('network and timeout errors are sanitized, even when a transport embeds secrets', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret-key https://secret.example'); });
  await assert.rejects(generate(provider('https://example.org'), prompt), error => error.code === 'NETWORK_ERROR' && !error.message.includes('secret'));
  mock.mock.mockImplementation(async () => { throw new DOMException('secret-key', 'TimeoutError'); });
  await assert.rejects(generate(provider('https://example.org'), prompt), { code: 'REQUEST_TIMEOUT' });
});

test('request timeout aborts a native HTTP connection before headers and during body streaming', async t => {
  const realTimeout = globalThis.setTimeout;
  // Shorten only the adapter's 45-second deadline, keeping the production transport intact.
  t.mock.method(globalThis, 'setTimeout', (callback, duration, ...args) => realTimeout(callback, duration === 45_000 ? 60 : duration, ...args));
  const service = await serverFor(t, (request, response) => {
    if (request.url.startsWith('/body')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"choices":');
    }
    // Deliberately leave the connection open until the client's abort closes it.
  });
  for (const prefix of ['/headers', '/body']) {
    const started = Date.now();
    await assert.rejects(generate(provider(service.baseUrl + prefix), prompt), { code: 'REQUEST_TIMEOUT' });
    assert.ok(Date.now() - started < 2000);
  }
  assert.equal(service.requests.length, 2);
});

test('invalid JSON is rejected without forwarding raw server text', async t => {
  const service = await serverFor(t, (request, response) => { response.writeHead(200); response.end('<html>secret-key</html>'); });
  await assert.rejects(generate(provider(service.baseUrl), prompt), error => error.code === 'INVALID_RESPONSE' && !error.message.includes('secret-key'));
});

test('Tavily uses basic bounded searches and filters unsafe, duplicate result URLs', async t => {
  const service = await serverFor(t, (request, response) => json(response, { results: [
    { title: 'bad', url: 'file:///etc/passwd', content: 'no' },
    { title: 'good', url: 'https://example.org/story', content: 'a'.repeat(3000) },
    { title: 'duplicate', url: 'https://example.org/story', content: 'again' },
    { title: 'second', url: 'https://example.org/other', content: 'news' },
    { title: 'third', url: 'https://example.org/extra', content: 'extra' },
  ] }));
  const result = await searchWeb({ enabled: true, type: 'tavily', baseUrl: service.baseUrl, apiKey: 'search-key', maxResults: 2 }, '今日天气');
  assert.equal(result.length, 2);
  assert.equal(result[0].content.length, 1400);
  assert.equal(result[0].url, 'https://example.org/story');
  const request = service.requests[0];
  assert.equal(request.headers.authorization, 'Bearer search-key');
  assert.equal(request.url, '/search');
  assert.equal(request.body.search_depth, 'basic');
  assert.equal(request.body.include_raw_content, false);
  assert.equal(request.body.max_results, 2);
});

test('SearXNG uses JSON GET queries without visiting search result pages', async t => {
  const service = await serverFor(t, (request, response) => json(response, { results: [{ title: '结果', url: 'https://example.com', content: '摘要' }] }));
  const result = await searchWeb({ enabled: true, type: 'searxng', baseUrl: `${service.baseUrl}/search`, maxResults: 3 }, '中文 & 空格');
  assert.equal(result.length, 1);
  assert.equal(service.requests.length, 1);
  assert.equal(service.requests[0].method, 'GET');
  const url = new URL(service.requests[0].url, service.baseUrl);
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), '中文 & 空格');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.deepEqual(await searchWeb({ enabled: false }, 'anything'), []);
});

test('OneBot safe operations sanitize params and force literal strings', async t => {
  const service = await serverFor(t, (request, response) => json(response, { status: 'ok', retcode: 0, data: { message_id: -123 } }));
  const config = { baseUrl: service.baseUrl, accessToken: 'bridge-key' };
  const result = await onebotCall(config, 'send_group_msg', { group_id: 12345, message: '[CQ:image,file=file:///secret]', auto_escape: false, path: 'secret' });
  assert.deepEqual(result, { message_id: -123 });
  assert.deepEqual(service.requests[0].body, { group_id: '12345', message: '[CQ:image,file=file:///secret]', auto_escape: true });
  assert.equal(service.requests[0].headers.authorization, 'Bearer bridge-key');
  await onebotCall(config, 'get_status', { arbitrary: 'ignored' });
  assert.deepEqual(service.requests[1].body, {});
});

test('OneBot accepts only inline local media and strips extra segment params', async t => {
  const service = await serverFor(t, (request, response) => json(response, { status: 'ok', retcode: 0, data: { message_id: 7 } }));
  const config = { baseUrl: service.baseUrl };
  await onebotCall(config, 'send_group_msg', { group_id: '123', message: [
    { type: 'text', data: { text: 'hi', path: '/etc' } },
    { type: 'image', data: { file: 'base64://AQID', url: 'file:///etc' } },
    { type: 'record', data: { file: 'base64://BAUG' } },
  ] });
  assert.deepEqual(service.requests[0].body.message[1], { type: 'image', data: { file: 'base64://AQID' } });
  for (const file of ['file:///etc/passwd', 'C:\\secret.txt', 'https://example.org/image.png', '../secret', 'base64://']) {
    await assert.rejects(onebotCall(config, 'send_group_msg', { group_id: '123', message: [{ type: 'image', data: { file } }] }), { code: 'INVALID_CONFIG' });
  }
  await assert.rejects(onebotCall(config, 'clean_cache', {}), { code: 'INVALID_CONFIG' });
  await assert.rejects(onebotCall(config, 'send_group_msg', { group_id: '123', message: [{ type: 'node', data: {} }] }), { code: 'INVALID_CONFIG' });
  assert.equal(service.requests.length, 1);
});

test('OneBot failed or unconfirmed sends never return success', async t => {
  let failed = true;
  const service = await serverFor(t, (request, response) => json(response, failed
    ? { status: 'failed', retcode: 100, wording: 'sensitive-token' }
    : { status: 'ok', retcode: 0, data: {} }));
  await assert.rejects(onebotCall({ baseUrl: service.baseUrl }, 'get_status'), error => error.code === 'ONEBOT_ERROR' && !error.message.includes('sensitive'));
  failed = false;
  await assert.rejects(onebotCall({ baseUrl: service.baseUrl }, 'send_group_msg', { group_id: '123', message: 'hello' }), { code: 'INVALID_RESPONSE' });
});

test('TTS compatibility endpoint returns bounded audio bytes with safe extension', async t => {
  const bytes = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
  const service = await serverFor(t, (request, response) => { response.writeHead(200, { 'Content-Type': 'audio/mpeg' }); response.end(bytes); });
  const result = await synthesize({ enabled: true, baseUrl: `${service.baseUrl}/v1`, apiKey: 'voice-key', model: 'tts-1', voice: 'alloy', format: 'mp3' }, '你好');
  assert.equal(result.extension, 'mp3');
  assert.equal(result.mime, 'audio/mpeg');
  assert.deepEqual(result.buffer, bytes);
  assert.equal(service.requests[0].url, '/v1/audio/speech');
  assert.deepEqual(service.requests[0].body, { model: 'tts-1', voice: 'alloy', input: '你好', response_format: 'mp3' });
});

test('TTS rejects JSON masquerading as audio and unsupported output extensions', async t => {
  const service = await serverFor(t, (request, response) => json(response, { error: 'sensitive-key' }));
  const config = { enabled: true, baseUrl: service.baseUrl, format: 'mp3' };
  await assert.rejects(synthesize(config, 'hello'), { code: 'INVALID_RESPONSE' });
  await assert.rejects(synthesize({ ...config, format: '../exe' }, 'hello'), { code: 'INVALID_CONFIG' });
});

function event(message, extra = {}) {
  return { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 123, user_id: 456,
    self_id: 789, message_id: -99, sender: { nickname: '群友', card: '昵称' }, message, ...extra };
}

test('OneBot CQ parsing detects only actual mentions of this bot', () => {
  const parsed = parseOneBotEvent(event('[CQ:at,qq=789]你好 &amp; &#91;文字&#93; [CQ:image,file=abc,url=https://example.org]'));
  assert.equal(parsed.mentioned, true);
  assert.equal(parsed.groupId, '123');
  assert.equal(parsed.messageId, '-99');
  assert.equal(parsed.senderName, '昵称');
  assert.equal(parsed.content, '@789 你好 & [文字] [图片]');
  assert.equal(parsed.segments.at(-1).data.url, undefined);
  assert.equal(parseOneBotEvent(event('[CQ:at,qq=987]hi')).mentioned, false);
  assert.equal(parseOneBotEvent(event('[CQ:at,qq=all]hi')).mentioned, false);
  assert.equal(parseOneBotEvent(event('&#91;CQ:at,qq=789&#93;')).mentioned, false);
  assert.equal(parseOneBotEvent(event('[CQ:at,qq=789]', { self_id: undefined })).mentioned, false);
});

test('OneBot array text remains literal and non-message events are ignored', () => {
  const parsed = parseOneBotEvent(event([
    { type: 'text', data: { text: '[CQ:at,qq=789] &amp;' } },
    { type: 'at', data: { qq: 987 } }, { type: 'record', data: { url: 'file:///secret' } },
  ]));
  assert.equal(parsed.mentioned, false);
  assert.equal(parsed.content, '[CQ:at,qq=789] &amp;@987 [语音]');
  assert.equal(parseOneBotEvent(event('hi', { post_type: 'message_sent' })), null);
  assert.equal(parseOneBotEvent(event('hi', { message_type: 'private' })), null);
  assert.equal(parseOneBotEvent(event('notice', { sub_type: 'notice' })), null);
  assert.equal(parseOneBotEvent(event('hi', { group_id: '../x' })), null);
  assert.equal(parseOneBotEvent(event('')), null);
});

test('OpenAI exposes only the fixed read-only meme tool and validates returned query',async t=>{const service=await serverFor(t,(req,res)=>json(res,{choices:[{message:{content:null,tool_calls:[{id:'one',type:'function',function:{name:'search_meme_wiki',arguments:JSON.stringify({query:'康神开播了'})}}]}}],usage:{prompt_tokens:123,completion_tokens:9}}));const r=await generate(provider(service.baseUrl),{...prompt,memeTool:true,tools:[{type:'computer'}]});assert.equal(r.memeQuery,'康神开播了');assert.equal(r.inputTokens,123);assert.deepEqual(service.requests[0].body.tools.map(t=>t.function.name),['search_meme_wiki']);assert.equal(service.requests[0].body.parallel_tool_calls,false);});
test('Gemini advertises the native fixed function and reads its structured arguments',async t=>{const service=await serverFor(t,(req,res)=>json(res,{candidates:[{content:{parts:[{functionCall:{name:'search_meme_wiki',args:{query:'48'}}}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:4}}));const r=await generate(provider(service.baseUrl,{type:'gemini',model:'gemini-2.5-flash'}),{...prompt,memeTool:true});assert.equal(r.memeQuery,'48');assert.equal(service.requests[0].body.tools[0].functionDeclarations[0].parameters.properties.query.type,'STRING');});
test('meme function calls reject arbitrary tool names, excess arguments and repeated calls',async t=>{let calls=[];const service=await serverFor(t,(req,res)=>json(res,{choices:[{message:{content:'',tool_calls:calls}}]}));for(const c of [[{function:{name:'shell',arguments:'{}'}}],[{function:{name:'search_meme_wiki',arguments:'{"query":"48","path":"C:/"}'}}],[{function:{name:'search_meme_wiki',arguments:'bad-json'}}],[{function:{name:'search_meme_wiki',arguments:'{"query":"48"}'}},{function:{name:'search_meme_wiki',arguments:'{"query":"49"}'}}]]){calls=c;await assert.rejects(()=>generate(provider(service.baseUrl),{...prompt,memeTool:true}));}calls=[{function:{name:'search_meme_wiki',arguments:'{"query":"48"}'}}];await assert.rejects(()=>generate(provider(service.baseUrl),prompt));});

test('provider catalog preserves all official model IDs without a completion request',async t=>{const {listModels}=await import('../app/lib/adapters.mjs');let called;t.mock.method(globalThis,'fetch',async(url,opts)=>{called={url:String(url),opts};return new Response(JSON.stringify({data:[{id:'deepseek-flash',name:'Flash',input_modalities:['text','image']},{id:'deepseek-v4-pro',name:'Pro'}]}),{status:200});});const models=await listModels({type:'openai',baseUrl:'https://api.deepseek.com',apiKey:'fake'});assert.deepEqual(models.map(m=>m.id),['deepseek-flash','deepseek-v4-pro']);assert.equal(called.opts.method,'GET');assert.ok(called.url.endsWith('/models'));});
