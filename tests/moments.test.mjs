import test from 'node:test';
import assert from 'node:assert/strict';
import { Moments } from '../app/lib/moments.mjs';
function fixture(){
  let value;
  const calls=[];
  const store={getMeta:(_,d)=>structuredClone(value??d),setMeta:(_,v)=>{value=structuredClone(v)},paths:{mediaPath:()=> 'D:/Unusual/data/emoji/demo.png'},config:{defaultProviderId:'a',providers:[{id:'a',enabled:true}],onebot:{},budget:{dailyTokenLimit:50000,maxInputTokens:9000,maxOutputTokens:300}},todayUsage:()=>({totalTokens:0}),recordUsage(){}};
  const api={generate:async()=>({text:'我今天给窗台上的豆苗量了身高。'}),onebotCall:async(_,action,params)=>{calls.push({action,params});return action==='get_friend_list'?[{user_id:123456,nickname:'朋友'}]:{tid:'test-id'};}};
  const media={listEmoji:()=>[{name:'demo.png'}]};
  const moments=new Moments(store,api,media,()=>true);
  return {moments,api,calls,store,due:()=>store.setMeta('',{...moments.state(),next:1})};
}
for (const mention of ['none','manual','auto'])test('scheduled moment '+mention,async()=>{
 const f=fixture(),initial=f.moments.state();assert.equal(initial.enabled,false);assert.equal(initial.chance,50);assert.equal(initial.hours,24);assert.equal(initial.mention,'none');
 f.moments.save({...initial,active:"测试",topic:"测试主题",enabled:true,prompt:'一个独立人设',mention,friend:'123456',chance:mention==='none'?0:100});
 await f.moments.tick();assert.equal(f.calls.length,0);f.due();await Promise.all([f.moments.tick(),f.moments.tick()]);
 const posts=f.calls.filter(x=>x.action==='send_qzone_msg');assert.equal(posts.length,1);assert.equal(posts[0].params.ugc_right,4);assert.equal(!!posts[0].params.images,mention!=='none');assert.equal(posts[0].params.content.includes('@{uin:123456,nick:朋友}'),mention!=='none');
 assert.equal(f.moments.state().history[0].tid,'test-id');await new Moments(f.store,f.api,{},()=>true).tick();assert.equal(f.calls.filter(x=>x.action==='send_qzone_msg').length,1);
});
test('unknown publish outcome does not retry the same time slot',async()=>{const f=fixture();f.moments.save({...f.moments.state(),active:"测试",topic:"测试主题",enabled:true,prompt:'test',chance:0});f.due();let count=0;f.api.onebotCall=async()=>{count++;throw Error('timeout')};await f.moments.tick();await f.moments.tick();assert.equal(count,1);assert.equal(f.moments.state().history[0].status,'未确认发布');});
test('web moments use retrieved sources and store references with the post',async()=>{
 const f=fixture(); f.moments.save({...f.moments.state(),active:"测试",topic:"测试主题",prompt:'日常',web:true,chance:0});
 f.api.momentSources=async()=>[{title:'测试新闻',url:'https://example.org/story',content:'测试内容'}];
 let prompt='';f.api.generate=async(_p,args)=>{prompt=args.messages[0].content;return {text:'我看到这个实验啦。'}};
 const result=await f.moments.tick(true);assert.match(prompt,/测试内容/);assert.equal(result.sources[0].title,'测试新闻');assert.equal(f.moments.state().enabled,false);assert.equal(f.calls.length,1);
});
test('empty web results stop before generating or publishing',async()=>{const f=fixture();f.moments.save({...f.moments.state(),active:"测试",topic:"测试主题",prompt:'测试',web:true});f.api.momentSources=async()=>[];await assert.rejects(f.moments.tick(true),/没有返回/);assert.equal(f.calls.length,0);});

test('legacy dynamic friend migrates and all selected friends are included once',async()=>{
  const f=fixture();
  const {friends:unused,...legacy}=f.moments.state();
  f.store.setMeta('',{...legacy,mention:'manual',friend:'123456'});
  assert.deepEqual(f.moments.state().friends,['123456']);
  const base=f.api.onebotCall;
  f.api.onebotCall=async(c,a,p)=>a==='get_friend_list'
    ?[{user_id:123456,nickname:'甲'},{user_id:234567,nickname:'乙'}]
    :base(c,a,p);
  f.moments.save({...f.moments.state(),active:"测试",topic:"测试主题",prompt:'日常',friends:['123456','234567','123456'],chance:0});
  assert.deepEqual(f.moments.state().friends,['123456','234567']);
  await f.moments.tick(true);
  assert.equal(f.calls.length,1);
  assert.match(f.calls[0].params.content,/@\{uin:123456,nick:甲\} @\{uin:234567,nick:乙\}$/);
  assert.deepEqual(f.moments.state().history[0].friends,['123456','234567']);
  f.moments.save({...f.moments.state(),active:"测试",topic:"测试主题",prompt:'日常',friends:['999999']});
  f.api.generate=()=>assert.fail('已失效的名单不应消耗模型调用');
  await assert.rejects(f.moments.tick(true),/找不到指定好友/);
  assert.equal(f.calls.length,1);
});
