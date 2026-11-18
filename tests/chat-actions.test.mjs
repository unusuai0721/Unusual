import test from 'node:test';import assert from 'node:assert/strict';import {voiceRequest,extractInteractions,interactionScope} from '../app/lib/chat-actions.mjs';import {onebotCall} from '../app/lib/adapters.mjs';
test('speech scripts preserve user wording and separate delivery style',()=>{
 assert.equal(voiceRequest('发一句晚安的语音啊').text,'晚安');assert.equal(voiceRequest('用语音说晚安').text,'晚安');assert.equal(voiceRequest('用语音读：“你好，世界。”').text,'你好，世界。');assert.equal(voiceRequest('不要发语音').requested,false);assert.equal(voiceRequest('用语音回答').text,'');
});
test('OneBot transmits reply and at segments and validates group poke IDs',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return Response.json({status:'ok',retcode:0,data:{message_id:'123'}});});const c={baseUrl:'http://127.0.0.1:1234',accessToken:'fake'};
 await onebotCall(c,'send_group_msg',{group_id:'123',message:[{type:'reply',data:{id:'-22'}},{type:'at',data:{qq:'777'}},{type:'text',data:{text:'hi'}}]});assert.equal(calls[0].body.message[0].data.id,'-22');await onebotCall(c,'group_poke',{group_id:'123',user_id:'777'});assert.equal(calls[1].url,'http://127.0.0.1:1234/group_poke');assert.deepEqual(calls[1].body,{group_id:'123',user_id:'777'});
 await assert.rejects(onebotCall(c,'send_group_msg',{group_id:'123',message:[{type:'at',data:{qq:'all'}}]}));await assert.rejects(onebotCall(c,'group_poke',{group_id:'123',user_id:'../file'}));await assert.rejects(onebotCall(c,'delete_msg',{message_id:'22'}));
});

test('colloquial measure words are not read as part of the supplied speech',()=>{assert.equal(voiceRequest('发句宝贝晚安的语音').text,'宝贝晚安');assert.equal(voiceRequest('发一句晚安的语音').text,'晚安');assert.equal(voiceRequest('语音').requested,true);assert.equal(voiceRequest('[语音]').requested,false);});
