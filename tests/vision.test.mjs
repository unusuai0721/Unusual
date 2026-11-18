import test from 'node:test';import assert from 'node:assert/strict';import {qqImageUrl,loadQQImage,checkedImage} from '../app/lib/vision.mjs';import {generate,parseOneBotEvent} from '../app/lib/adapters.mjs';
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),data='data:image/png;base64,'+png.toString('base64');
test('vision refuses filesystem, local networks, credentials, deceptive hosts and redirects',async t=>{
 for(const url of ['file:///D:/secret','https://127.0.0.1/x','http://gchat.qpic.cn/x','https://gchat.qpic.cn.evil.test/x','https://name@gchat.qpic.cn/x','https://gchat.qpic.cn:444/x']){assert.equal(qqImageUrl(url),null);await assert.rejects(loadQQImage(url));}
 t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}}));await assert.rejects(loadQQImage('https://gchat.qpic.cn/x'));
 assert.throws(()=>checkedImage('file:///D:/a'));assert.throws(()=>checkedImage('data:image/png;base64,aGVsbG8='));
});
test('vision rejects excessive sizes and nonimage server content',async t=>{
 const mock=t.mock.method(globalThis,'fetch',async()=>new Response('bad',{headers:{'content-length':String(6*1024*1024)}}));await assert.rejects(loadQQImage('https://gchat.qpic.cn/x'),/5 MB/);mock.mock.mockImplementation(async()=>new Response('<html>not an image</html>'));await assert.rejects(loadQQImage('https://gchat.qpic.cn/x'),/图片格式/);
});
test('OneBot retains allowed image CDN addresses but never a local file',()=>{const parsed=parseOneBotEvent({post_type:'message',message_type:'group',group_id:'123',user_id:'456',message:[{type:'image',data:{url:'https://multimedia.nt.qq.com.cn/download?appid=1',file:'D:/private'}}]});assert.match(parsed.segments[0].data.url,/multimedia/);assert.equal(parsed.segments[0].data.file,undefined);});
test('OpenAI vision payload includes actual low-detail image and Gemini includes inline bytes',async t=>{
 let body; t.mock.method(globalThis,'fetch',async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{message:{content:'看到图片'}}],candidates:[{content:{parts:[{text:'看到图片'}]}}]});});
 const provider={enabled:true,type:'openai',model:'vision',baseUrl:'https://example.test/v1',apiKey:'fake'};const options={system:'test',messages:[{role:'user',content:'图片'}],images:[data],maxOutputTokens:30};
 await generate(provider,options);assert.equal(body.messages.at(-1).content[1].image_url.url,data);assert.equal(body.messages.at(-1).content[1].image_url.detail,'low');assert.equal(body.tools,undefined);
 await generate({...provider,type:'gemini'},options);assert.deepEqual(body.contents.at(-1).parts.at(-1),{inlineData:{mimeType:'image/png',data:png.toString('base64')}});
});

test('Breeze model catalog uses official host and returns selectable IDs',async t=>{
 const {listBreezeModels}=await import('../app/lib/adapters.mjs');t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(String(url),'https://api.breeze.blue/v1/models');assert.equal(options.method,'GET');assert.equal(options.headers['xi-api-key'],'fake');return Response.json([{model_id:'breeze-tts-2',name:'Breeze TTS 2',languages:[{language_id:'zh'}]},{model_id:'breeze-tts-2-multilingual',name:'Multilingual',languages:[{language_id:'ja'}]}]);});
 const models=await listBreezeModels({type:'breeze',apiKey:'fake'});assert.equal(models.length,2);assert.equal(models[1].id,'breeze-tts-2-multilingual');
});

test('native QQ faces keep their actual meanings without a vision request',()=>{const parsed=parseOneBotEvent({post_type:'message',message_type:'group',group_id:'123',user_id:'456',message:[{type:'face',data:{id:'14'}},{type:'face',data:{id:'9'}}]});assert.equal(parsed.content,'[QQ表情:微笑][QQ表情:大哭]');});
