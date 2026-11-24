'use strict';
const themeControl=document.querySelector('#theme-toggle');
function applyTheme(dark){
  document.documentElement.dataset.theme=dark?'dark':'light';
  themeControl.setAttribute('aria-pressed',String(dark));
  themeControl.title=dark?'切换到日间模式':'切换到黑夜模式';
  document.querySelector('meta[name="theme-color"]').content=dark?'#151c19':'#f7f8f5';
}
let savedTheme;
try{savedTheme=localStorage.getItem('unusual.theme');}catch{}
applyTheme(savedTheme==='dark');
themeControl.addEventListener('click',()=>{
  const dark=document.documentElement.dataset.theme!=='dark';
  applyTheme(dark);
  try{localStorage.setItem('unusual.theme',dark?'dark':'light');}catch{}
});

const ContextUI={id:'',data:null};
function sessionLabel(g){return (g.id.startsWith('private:')?'私聊 · ':'群聊 · ')+g.name;}
function privateSettings(g,p){if(!g.id.startsWith('private:'))return '';const choices=S.config.groups.filter(x=>!x.id.startsWith('private:')&&x.channel!=='official');return '<section class="panel section-gap"><h3>跨会话权限</h3><p class="field-help">仅选中的目标群可接收此好友的明确转达或共享记忆。默认不授权；普通私聊记录永不拼接到群上下文。</p>'+['relayTargets','sharedTargets'].map(key=>'<h4>'+(key==='relayTargets'?'允许转达的群':'允许共享记忆的群')+'</h4>'+choices.map(t=>'<label class="checkline"><input type="checkbox" data-cross-target="'+key+'" data-config-path="'+p+'" data-target-id="'+esc(t.id)+'" '+((g[key]||[]).includes(t.id)?'checked':'')+'>'+esc(t.name)+' · '+esc(t.id)+'</label>').join('')).join('')+'<p class="field-help">示例：去群123456 @987654 说：你好。／去群123456 艾特昵称说句话。／记住群123456：小王是个帅哥。只想在私聊记住则说“记住：…”；只授权一个共享群时，“群里小王是个帅哥”会记到那个群，否则仅记在当前私聊。</p></section>';}
async function addFriend(){
 if(!await saveConfig({quiet:true}))return;
 const result=await request('/api/qq/friends');const friends=result.friends.filter(f=>/^[1-9]\d{0,19}$/.test(f.user_id));
 if(!friends.length)throw new Error('未读取到好友，请先登录 QQ 并确认已互加好友。');
 const answer=await ask({title:'添加好友会话',description:'仅添加勾选的好友；不会自动通过陌生人申请或启用所有好友。',fields:'<div class="group-picker">'+friends.map(f=>'<label class="checkline"><input type="checkbox" name="f_'+f.user_id+'"><span>'+esc(f.name)+'<small> · '+f.user_id+'</small></span></label>').join('')+'</div>',confirm:'添加所选好友'});if(!answer)return;
 for(const key of Object.keys(answer).filter(k=>k.startsWith('f_'))){const uid=key.slice(2),remote=friends.find(f=>f.user_id===uid);if(!remote)continue;const id='private:'+uid;if(!S.config.groups.some(g=>g.id===id)){const g={...newGroup(id,remote.name),replyMode:'all',replyProbability:1,cooldownSec:3,debounceSec:2,quietStart:'00:00',quietEnd:'00:00',maxRepliesPerHour:500,voiceMode:'auto',dynamicVoiceTone:true,visionEnabled:true,emojiProbability:35,quoteReply:true,allowMention:false,allowPoke:true,pokeIntervalSec:300,relayTargets:[],sharedTargets:[],enabled:true};S.config.groups.push(g);}S.groupId=id;}
 markDirty();if(await saveConfig({quiet:true})){await navigate('groups');toast('好友会话已添加；请按需设置跨会话权限。');}
}
async function loadContexts(){if(!S.config.groups.some(g=>g.id===ContextUI.id))ContextUI.id=S.config.groups[0]?.id||'';ContextUI.data=ContextUI.id?await request('/api/context?id='+encodeURIComponent(ContextUI.id)):null;if(S.page==='contexts'||S.page==='personas')renderPage();}
function contexts(){const data=ContextUI.data;return heading('CONTEXT','本轮上下文','按会话查看当前上下文。长期记忆在人设管理的可塑性记忆中编辑。')+'<section class="panel"><select id="context-session">'+S.config.groups.map(g=>'<option value="'+esc(g.id)+'" '+(g.id===ContextUI.id?'selected':'')+'>'+esc(sessionLabel(g))+'</option>').join('')+'</select><div class="toolbar">'+button('开始新上下文','context-new','refresh','secondary')+button('查看完整历史','context-history','clock','secondary')+'</div><p>最多显示当前轮 200 条，实际输入按预算裁剪。</p>'+(data?.items||[]).map(m=>'<article class="panel"><small>'+esc(m.senderName||m.role)+' · '+esc(time(m.createdAt))+'</small><p style="white-space:pre-wrap">'+esc(m.content)+'</p></article>').join('')+'</section>';}
function legacyPersonality(){return '<details class="field wide"><summary>原有会话记忆（保留共享权限）</summary><select id="context-session">'+S.config.groups.map(g=>'<option value="'+esc(g.id)+'" '+(g.id===ContextUI.id?'selected':'')+'>'+esc(sessionLabel(g))+'</option>').join('')+'</select>'+button('新增记忆','memory-add','plus','secondary')+(ContextUI.data?.memories||[]).map(m=>'<article class="panel"><p>'+esc(m.text)+'</p><small>'+esc(groupName(m.origin))+' → '+esc(groupName(m.scope))+'</small>'+button('编辑','memory-edit','edit','ghost','data-id="'+m.id+'"')+button('删除','memory-delete','trash','ghost','data-id="'+m.id+'"')+'</article>').join('')+'</details>';}
async function editMemory(item=null){if(!ContextUI.id)throw new Error('请先选择会话');const origin=item?.origin||ContextUI.id;const source=S.config.groups.find(g=>g.id===origin);const allowed=S.config.groups.filter(g=>g.id===origin||(source?.sharedTargets||[]).includes(g.id));const result=await ask({title:item?'编辑记忆':'新增记忆',fields:'<label class="field"><span>内容（最多 600 字）</span><textarea name="text" maxlength="600" required>'+esc(item?.text||'')+'</textarea></label><label class="field"><span>使用会话</span><select name="scope">'+allowed.map(g=>'<option value="'+esc(g.id)+'" '+(g.id===(item?.scope||ContextUI.id)?'selected':'')+'>'+esc(sessionLabel(g))+'</option>').join('')+'</select></label>',confirm:'保存记忆'});if(!result)return;await request('/api/memories',{method:'POST',body:{...result,origin,...(item?{id:item.id}:{})}});await loadContexts();}



const icons = {
  grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z',
  users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  persona:'M20 21v-2a7 7 0 0 0-14 0v2M17 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M3 5h3M4.5 3.5v3',
  cpu:'M8 8h8v8H8zM5 5h14v14H5zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4',
  clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2',
  smile:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 14s1.5 3 4 3 4-3 4-3M8 8h.01M16 8h.01',
  tools:'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0L21 6a6 6 0 0 1-7.7 7.7l-7.1 7.1a2 2 0 0 1-3-3l7.1-7.1A6 6 0 0 1 18 3z',
  code:'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  settings:'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M9 3l-1 3-3 1-2 4 2 3v4l4 3 3-1 3 1 4-3v-4l2-3-2-4-3-1-1-3z',
  logs:'M7 3h10l3 3v15H4V3zM8 9h8M8 13h8M8 17h5',
  arrow:'M5 12h14M14 7l5 5-5 5', check:'M5 12l4 4L19 6',plus:'M12 5v14M5 12h14',
  refresh:'M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9',
  shield:'M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7zM8 12l3 3 5-6',
  send:'M22 2L9 15M22 2l-7 20-6-7-7-6z', trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', upload:'M12 16V3M7 8l5-5 5 5M4 15v6h16v-6',
  copy:'M8 8h13v13H8zM16 5V2H2v14h3', download:'M12 3v13M7 11l5 5 5-5M3 17v4h18v-4',
  bolt:'M13 2L3 14h8l-1 8 11-13h-8z', info:'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',
  mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
  folder:'M3 5h6l2 3h10v13H3z', power:'M12 2v10M5 5a9 9 0 1 0 14 0', eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
};
const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name] || icons.info}"/></svg>`;
const number = value => new Intl.NumberFormat('zh-CN').format(Number(value)||0);
const time = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}) : '暂无';
const shortTime = value => value ? new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}) : '—';
const id = prefix => `${prefix}_${crypto.randomUUID().slice(0,8)}`;
const pages = [
  ['setup','快速开始','bolt','工作台'],['overview','总览','grid'],['activity','运行与用量','bolt'],['preview','对话预览','chat'],['groups','QQ 会话','users'],['moments','QQ 动态','globe'],
  ['official','QQ 官方机器人','users'],['personas','人设管理','persona','能力与内容'],['providers','模型与 API','cpu'],['history','聊天记录','clock'],['contexts','上下文与记忆','clock'],['backups','备份与恢复','download'],['memewiki','梗百科','chat'],['emoji','表情包','smile'],['voice','Breeze 语音','mic'],['tools','联网搜索','tools'],
  ['api','对外 API','code','本地服务'],['settings','设置与用量','settings'],['updates','软件更新','download'],['logs','运行日志','logs'],['guide','使用教程','info'],
];

const BreezeUI={models:[],voices:[],loaded:false,page:1,more:false,total:0,search:'',language:'zh',favorites:false,category:null,localFavorites:[],updatedAt:null};
const voiceTones=['自然聊天，语速适中，不要播音腔。','轻松愉快，语气活泼，但不要夸张。','声音柔和，语速稍慢，表达平静。','认真清楚地解释，节奏平稳。','轻声说话，亲切自然，停顿适当。','开心分享好消息，声音明亮，语速稍快。','略带惊讶和好奇，语调有变化，避免夸张尖叫。','低落失望，声音稍轻，表达克制，不哭喊。','坚定严肃，重音清楚，不吼叫。','带一点俏皮的调侃，轻松自然，不刻意嘲讽。','耐心安慰，语气柔和，留出自然停顿。','睡前讲故事，语速缓慢，音量轻柔。','清晰专业的新闻播报，语速稳定，发音准确。','热情有活力地介绍，节奏明快，不高声叫卖。','紧张急切，语速稍快，保持吐字清楚。','若有所思，语速稍慢，在重点处停顿。','平静讲述故事，随内容轻微变化情绪。','自信干脆，句尾收稳，避免拖音。','小声分享秘密，轻声但清晰，不刻意喘息。','轻松闲聊，略带笑意，表达随意自然。','认真道歉，声音平稳诚恳，不戏剧化。'];
function voicePage(){const v=S.config.voice,b=v.type==='breeze';return heading('BREEZE VOICE STUDIO','语音设置','选择音色、调整语气，先在这里试听；群语音由群设置中的开关控制。')+
'<div class="settings-columns"><section class="panel">'+panelHead('语音服务与表达')+toggle('启用语音合成','voice.enabled')+field('服务类型','voice.type',{options:[['breeze','Breeze 官方云'],['openai','OpenAI 兼容 TTS']]})+field('API 密钥','voice.apiKey',{type:'password',hint:'保存在本软件目录；不会放入音色查询网址或日志。'})+(b?notice('官方云地址固定为 api.breeze.blue；音色目录查询不生成语音。'):field('服务 Base URL','voice.baseUrl'))+(b?field('语音模型','voice.model',{options:[...BreezeUI.models.map(m=>[m.id,m.name+(m.id==='breeze-tts-2'?' · 中英双语':m.id==='breeze-tts-2-multilingual'?' · 多语言':'' )]),...(!BreezeUI.models.some(m=>m.id===v.model)?[[v.model,v.model+'（当前配置）']]:[])],hint:'中英聊天可继续使用 Breeze TTS 2；日语等其他语言选择 Multilingual。模型目录以当前账号的官方接口结果为准。'})+button('刷新官方模型列表','breeze-models','refresh','secondary small'):field('模型','voice.model'))+field('当前音色 ID','voice.voice',{hint:'从右侧音色列表选择，也可以粘贴自己的 voice_id。'})+field('输出格式','voice.format',{options:['mp3','wav','opus','aac','flac']})+
(b?'<label class="field"><span>语气预设</span><select id="voice-tone"><option value="">选择预设，或在下方自定义</option>'+voiceTones.map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join('')+'</select></label>'+field('自定义语气指令','voice.instructions',{type:'textarea',rows:3,hint:'描述语速、情绪和表达方式；这些指令不会作为正文朗读。'})+field('指令引导强度','voice.guidanceScale',{type:'number',min:0,max:10,step:.5,hint:'默认 4。与音色、文本共同影响结果。'}):'')+
'<label class="field"><span>合成／试听文本</span><textarea id="voice-text" data-bind="voice.testText" maxlength="500" rows="3">'+esc(v.testText||'晚上好，你们刚才在聊什么？')+'</textarea></label><div class="toolbar">'+button('保存并生成试听','voice-test','mic','')+'</div><p class="field-help">点击生成会使用官方 API 额度，音频只在软件中播放，不发至 QQ。群聊时正文由聊天模型生成，不使用这段试听文本。</p><div id="voice-result"></div></section><section class="panel">'+voiceCatalog()+'</section></div>'+voiceDecisionPanel()+voiceBillingPanel()+notice('群聊设置：回复形式选“自动混合”，即可自主选择文字或语音；可开启动态语气。冷场主动发言需另启用主动话题。');}


const voiceCategories=[['child','童声音色'],['old','年长音色'],['female_mature','女声 · 成熟沉稳'],['female_bright','女声 · 明亮活泼'],['female_soft','女声 · 温柔舒缓'],['female_other','女声 · 其他风格'],['male','男声音色'],['neutral','中性音色'],['unknown','未标注音色']];
function voiceCategory(v){if(v.age==='child')return 'child';if(v.age==='old')return 'old';if(v.gender==='female'){const tones=v.tone||[];if(v.age==='middle_aged'||tones.some(t=>['authoritative','refined','steady','precise'].includes(t)))return 'female_mature';if(tones.some(t=>['bright','energetic','playful','passionate'].includes(t)))return 'female_bright';if(tones.some(t=>['gentle','warm','calm','compassionate','reflective','measured'].includes(t)))return 'female_soft';return 'female_other';}return ['male','neutral'].includes(v.gender)?v.gender:'unknown';}
function applyVoiceLibrary(d){BreezeUI.voices=d.voices;BreezeUI.localFavorites=d.favorites||[];BreezeUI.updatedAt=d.updatedAt;BreezeUI.loaded=!!d.updatedAt;}
async function loadVoiceLibrary(){VoiceDecisions=(await request('/api/voice/decisions')).items;BreezeUI.models=(await request('/api/voice/models')).models||[];applyVoiceLibrary(await request('/api/voice/library'));}
function updateVoiceResults(){const el=$('#voice-library-results');if(el)el.innerHTML=voiceResults();}
function voiceCatalog(){return panelHead('我的音色库','空分类自动隐藏。女声按官方年龄/语气标签依次归入成熟、明亮、温柔、其他；每个音色只归入一类。')+'<div class="form-grid"><label class="field"><span>即时搜索</span><input id="breeze-search" value="'+esc(BreezeUI.search)+'" placeholder="名称、描述、音色 ID"></label><label class="field"><span>语言</span><select id="breeze-language"><option value="zh" '+(BreezeUI.language==='zh'?'selected':'')+'>中文</option><option value="all" '+(BreezeUI.language==='all'?'selected':'')+'>全部语言</option></select></label></div><label class="checkline"><input id="breeze-favorites" type="checkbox" '+(BreezeUI.favorites?'checked':'')+'>只看本地收藏（不需要去官网）</label><div class="toolbar">'+button('同步全部音色','breeze-list','refresh','')+'</div><p class="field-help">搜索和分类使用本地缓存，不生成语音；收藏即时保存。本地收藏不是一个重复分类。</p><div id="voice-library-results" style="scroll-margin-top:96px">'+voiceResults()+'</div>';}
function voiceResults(){const q=BreezeUI.search.trim().toLocaleLowerCase();const items=BreezeUI.voices.filter(v=>(BreezeUI.language!=='zh'||v.language_code==='zh')&&(!BreezeUI.favorites||BreezeUI.localFavorites.includes(v.voice_id))&&(!q||[v.name,v.description,v.voice_id,...(v.tone||[])].join(' ').toLocaleLowerCase().includes(q)));const stamp='<p class="field-help">缓存 '+BreezeUI.voices.length+' 个音色 · 更新：'+esc(time(BreezeUI.updatedAt))+'</p>';if(!BreezeUI.category)return stamp+'<div class="form-grid">'+voiceCategories.map(([id,label])=>{const count=items.filter(v=>voiceCategory(v)===id).length;if(!count)return '';return '<button class="panel button secondary" style="min-height:100px;white-space:normal;justify-content:center" data-action="breeze-category" data-id="'+id+'">'+esc(label)+' · '+count+'</button>';}).join('')+'</div>'+(items.length?'':'<p class="muted">没有匹配音色。可调整筛选或同步目录。</p>');const rows=items.filter(v=>voiceCategory(v)===BreezeUI.category),pages=Math.max(1,Math.ceil(rows.length/12));BreezeUI.page=Math.max(1,Math.min(pages,BreezeUI.page));return stamp+button('返回分类','breeze-category','arrow','secondary','data-id=""')+'<h3>'+esc(voiceCategories.find(x=>x[0]===BreezeUI.category)?.[1])+' · '+rows.length+'</h3>'+'<div class="toolbar">'+button('上一页','breeze-prev','arrow','secondary',BreezeUI.page<=1?'disabled':'')+'<span>'+BreezeUI.page+' / '+pages+'</span>'+button('下一页','breeze-next','arrow','secondary',BreezeUI.page>=pages?'disabled':'')+'</div>'+rows.slice((BreezeUI.page-1)*12,BreezeUI.page*12).map(v=>'<div class="panel section-gap"><strong>'+esc(v.name)+'</strong><p class="field-help">'+esc(v.description||v.language_code)+'</p><small>'+esc(v.voice_id)+'</small><div class="toolbar">'+button(S.config.voice.voice===v.voice_id?'已选择':'使用音色','breeze-pick','check','secondary','data-id="'+esc(v.voice_id)+'"')+button(BreezeUI.localFavorites.includes(v.voice_id)?'取消收藏':'收藏','breeze-favorite','smile','secondary','data-id="'+esc(v.voice_id)+'"')+'</div></div>').join('')+'<div class="toolbar">'+button('上一页','breeze-prev','arrow','secondary',BreezeUI.page<=1?'disabled':'')+'<span>'+BreezeUI.page+' / '+pages+'</span>'+button('下一页','breeze-next','arrow','secondary',BreezeUI.page>=pages?'disabled':'')+'</div>';}

let voiceBills=null,voiceBillsError='';
function creditText(b){return typeof b?.credits==='number'?b.credits.toLocaleString('zh-CN',{maximumFractionDigits:3})+' 积分（官网实际记录）':'积分待官网确认';}
function voiceBillingPanel(){return '<section class="panel section-gap">'+panelHead('官网语音积分记录','显示此账号最近 30 条生成记录，可能包含网页或其他软件的生成。按记录 ID 区分，不通过余额差估算。',button('刷新积分记录','breeze-billing','refresh','secondary'))+'<div id="voice-billing-records">'+voiceBillingRows()+'</div></section>';}
function voiceBillingRows(){return (voiceBillsError?notice(voiceBillsError):'')+(voiceBills?voiceBills.map(b=>'<div class="status-row"><div><strong>'+esc(b.voice||'语音生成')+'</strong><p class="field-help">'+esc(b.text)+'</p><small>'+esc(b.date?time(b.date*1000):'')+' · '+esc(b.state)+' · '+esc(b.id)+'</small></div><span>'+esc(creditText(b))+'</span></div>').join('')||'<p class="muted">暂无生成记录</p>':'<p class="muted">点击刷新读取官网账单；查询不会生成语音。</p>');}
const S = {qq:null,desktop:null,qqBusy:false,config:null,status:null,page:'overview',dirty:false,revision:0,saving:false,groupId:null,personaId:null,providerId:null,emoji:[],messages:[],messageTotal:0,historyGroup:'',historyQuery:'',selectedMessages:new Set(),logs:[],logLevel:'all',chat:[],previewPersona:'',previewProvider:'',previewSearch:false,previewSession:crypto.randomUUID(),previewBusy:false,previewDraft:'',bridgeBusy:false,pollError:false};
let toastTimer;
function toast(message,error=false){const box=$('#toast');box.textContent=message;box.className=`show${error?' error':''}`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>box.className='',4500);}
async function request(path,{method='GET',body}={}){
  const response=await fetch(path,{method,credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const content=await response.text();let data;try{data=content?JSON.parse(content):{};}catch{data={error:content.slice(0,240)};}
  if(!response.ok){const error=new Error(typeof data.error==='string'?data.error:(data.error?.message||data.message||`请求失败 (${response.status})`));error.status=response.status;throw error;}return data;
}
function get(path){return path.split('.').reduce((value,key)=>value?.[key],S.config);}
function set(path,value){const keys=path.split('.');let current=S.config;for(const key of keys.slice(0,-1))current=current[key];current[keys.at(-1)]=value;markDirty();}
function markDirty(){S.dirty=true;S.revision++;renderSaveState();}
function renderSaveState(){const state=$('#save-state'),button=$('#save-config');if(state)state.textContent=S.saving?'正在保存…':S.dirty?'有未保存的更改':'已保存到本地';if(button){button.disabled=S.saving||!S.dirty;button.innerHTML=`${icon(S.saving?'refresh':'check')}${S.saving?'保存中':'保存设置'}`;}}
function button(label,action,ico='plus',kind='secondary',extra=''){return `<button class="button ${kind}" data-action="${action}" ${extra}>${icon(ico)}${esc(label)}</button>`;}
function field(label,path,{type='text',hint='',placeholder='',wide=false,min='',max='',step='',rows='',options=null,cls=''}={}){
  const value=get(path);let input;
  if(options)input=`<select data-bind="${path}">${options.map(option=>{const [v,l]=Array.isArray(option)?option:[option,option];return `<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(l)}</option>`;}).join('')}</select>`;
  else if(type==='textarea')input=`<textarea data-bind="${path}" class="${cls}" ${rows?`rows="${rows}"`:''} placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
  else input=`<input data-bind="${path}" ${type==='list'?'data-list="true"':''} type="${type==='list'?'text':type}" value="${esc(Array.isArray(value)?value.join('，'):value)}" placeholder="${esc(placeholder)}" ${min!==''?`min="${min}"`:''} ${max!==''?`max="${max}"`:''} ${step!==''?`step="${step}"`:''} autocomplete="${type==='password'?'new-password':'off'}">`;
  return `<label class="field ${wide?'wide':''}"><span>${esc(label)}${path.endsWith('.maxRepliesPerHour')?` <span id="group-hourly-usage" style="font-size:12px;margin-left:10px" aria-live="polite">${esc(hourlyUsage(get(path.replace('.maxRepliesPerHour','.id'))))}</span>`:''}</span>${input}${hint?`<small>${esc(hint)}</small>`:''}</label>`;
}
function toggle(label,path,hint=''){return `<div class="toggle-row"><div><strong>${esc(label)}</strong>${hint?`<small>${esc(hint)}</small>`:''}</div><label class="toggle"><input type="checkbox" data-bind="${path}" ${get(path)?'checked':''} aria-label="${esc(label)}"><span class="toggle-track"></span></label></div>`;}
function notice(text,kind=''){return `<div class="notice ${kind}">${icon(kind==='error'?'info':'shield')}<span>${esc(text)}</span></div>`;}
function empty(title,description,ico='chat',action=''){return `<div class="empty"><div class="empty-icon">${icon(ico)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;}
function heading(kicker,title,description,actions=''){return `<div class="page-heading"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions}</div>`;}
function panelHead(title,description='',actions=''){return `<div class="panel-head"><div><h2>${esc(title)}</h2>${description?`<div class="muted">${esc(description)}</div>`:''}</div>${actions}</div>`;}
function optionsFor(key){const items=S.config[key].map(item=>[item.id,item.name]);return key==='personas'?[['','不使用人设'],...items]:items;}
function badge(text,kind=''){return `<span class="badge ${kind}">${esc(text)}</span>`;}
function groupName(groupId){return S.config.groups.find(g=>g.id===groupId)?.name||({'preview':'对话预览','api':'对外 API'}[groupId])||groupId;}
function safeUrl(value){try{const url=new URL(value,location.origin);return ['http:','https:'].includes(url.protocol)?esc(url.href):'#';}catch{return '#';}}

function shell(){
  $('#app').innerHTML=`<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">✦</div><div class="brand-copy"><div class="brand-name">Unusual</div><div class="brand-caption">UNUSUAL COMPANION</div></div></div><nav aria-label="主导航">${pages.filter(p=>!['activity','providers','tools','api','settings','logs','guide','backups','official','contexts','updates'].includes(p[0])).map(([key,label,ico,section])=>`${section?`<div class="nav-label">${section}</div>`:''}<button class="nav-item" data-page="${key}" title="${label}">${icon(ico)}<span>${label}</span></button>`).join('')}<button class="nav-item" data-action="open-settings">${icon('settings')}<span>设置</span></button></nav><div class="side-bottom"><div class="local-badge">运行在你的电脑上</div><div class="side-note">本地存储 · 配置与记录保存在本机</div></div></aside><main class="workspace"><header class="topbar"><div class="breadcrumb">我的工作空间 <span>/</span> <strong id="breadcrumb-title">总览</strong></div><div class="top-actions"><span id="top-status" class="top-state"><i class="dot"></i>本地服务在线</span><span id="save-state" class="save-state"></span><button id="save-config" class="button small" data-action="save"></button></div></header><div id="content" class="content"></div></main></div>`;
  renderPage();renderSaveState();updateStatusPill();
}
function renderPage(){
  $$('.nav-item').forEach(item=>item.classList.toggle('active',item.dataset.page===S.page));
  $('#breadcrumb-title').textContent=pages.find(page=>page[0]===S.page)?.[1]||'';
  const renderers={moments:momentsPage,setup,guide,overview,activity:activityPage,memewiki:memePage,preview,groups,official:officialPage,personas,providers,history:historyPage,contexts,backups:backupPage,emoji,tools:toolbox,voice:voicePage,api:apiPage,settings,updates:updatesPage,logs};
  $('#content').innerHTML=renderers[S.page]();if(S.page==='history')$('#content').insertAdjacentHTML('afterbegin','<div class="toolbar">'+button('查看本轮上下文','navigate','clock','secondary','data-target="contexts"')+'</div>');
  if(S.page==='preview')scrollChat();
  if(S.page==='activity'){const chart=$('.usage-chart');if(chart)chart.scrollLeft=chart.scrollWidth;}
}
async function navigate(page){S.page=page;renderPage();try{if(page==='moments'){momentsState=await request('/api/moments');if(S.page===page)renderPage();}if(page==='providers')await loadProviderModels();if(page==='memewiki')await loadMeme();if(page==='activity')await loadActivity();if(page==='voice'){await loadVoiceLibrary();if(S.page==='voice')renderPage();}if(page==='official')await refreshOfficial();if(page==='setup'||page==='groups')await refreshQQ();if(page==='history')await loadHistory();if(page==='contexts')await loadContexts();if(page==='backups')await loadBackups();if(page==='personas'){await loadLearning();await loadPersonality();await loadContexts();}if(page==='emoji')await loadEmoji();if(page==='groups'){await loadBudgetEstimate();await loadEmoji();if(S.page==='groups')renderPage();}if(page==='logs')await loadLogs();}catch(error){toast(error.message,true);}}
function updateStatusPill(){const el=$('#top-status');if(!el)return;el.className=`top-state${S.pollError?' offline':''}`;el.innerHTML=`<i class="dot"></i>${S.pollError?'服务暂时不可用':'本地服务在线'}`;}
const replyReasons={observing:'这条在和其他群友说话，已跳过',paused:'自动聊天已暂停',group_disabled:'本群未启用',qq_offline:'本群 QQ 连接离线',quiet_hours:'处于安静时段',cooldown:'回复冷却中',hourly_limit:'达到每小时发送上限',not_triggered:'未命中关键词或接话概率',waiting_cooldown:'已排队，冷却结束后回复',scheduled:'已收到，等待合并消息',generating:'正在生成回复',sent:'已成功发送',context_reset:'已重新应用人设',queue_expired:'等待超过 5 分钟，已取消旧回复',daily_budget:'今日剩余 Token 预算不足',settings_changed:'生成时设置变化，已取消',empty_response:'模型没有返回可发送内容',persona_too_large:'人设超过单次输入预算'};
function hourlyUsage(groupId){const st=S.status.engine?.groups?.find(g=>g.id===groupId);return st?'最近 60 分钟：已回复 '+number(st.repliesThisHour)+' / '+number(st.hourlyLimit)+' 条':'最近 60 分钟：等待统计';}
function groupReplyStatus(groupId){const st=S.status.engine?.groups?.find(g=>g.id===groupId);if(!st)return '<p class="muted">等待状态</p>';const d=st.lastAutomaticDecision||st.lastDecision;return '<div class="status-row"><span>最近一小时回复</span><span>'+esc(st.repliesThisHour??0)+' / '+esc(st.hourlyLimit??20)+'</span></div>'+(st.limitResumesAt?notice('最早恢复时间：'+time(st.limitResumesAt),'warning'):'')+(st.vision?'<p class="field-help">识图：'+esc(st.vision.detail)+'</p>':'')+'<div class="status-row"><span>当前限制</span><span>'+esc(st.blockedReason?(replyReasons[st.blockedReason]||st.blockedReason):'无')+'</span></div><div class="status-row"><span>最近自动处理</span><span>'+esc(d?(replyReasons[d.reason]||d.reason):'暂无')+'</span></div>'+(d?.detail?notice(d.detail,'warning'):'')+'<p class="field-help">'+esc(d?time(d.at):'')+(st.pending?' · 有回复正在等待或生成':'')+'</p>';}
function replyDiagnostics(){return '<section class="panel section-gap">'+panelHead('各群回复状态','不回复时，在这里查看原因。')+S.config.groups.map(g=>'<h3>'+esc(g.name)+'</h3>'+groupReplyStatus(g.id)).join('')+'</section>';}
function overview(){
  const st=S.status,c=S.config,usage=st.summary?.todayUsage||{},ready=st.setup||{};
  const enabled=c.groups.filter(group=>group.enabled).length;
  const steps=[['连接你的模型','添加 API Key，选择希望与你对话的模型。',ready.providerReady,'providers'],['连接 QQ','按快速开始设置外部 OneBot v11 桥接。',ready.bridgeReady,'groups'],['选择一起聊天的群','添加群号，按每个群的节奏设置回复策略。',ready.groupsReady,'groups']];
  return `${heading('YOUR LOCAL COMPANION','运行总览','这里是Unusual的工作台。一眼了解连接、对话与今日用量。',`<span class="responsive-date">${new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long',timeZone:'Asia/Shanghai'})}</span>`)}
  <section class="hero"><div><div class="eyebrow">A LITTLE PRESENCE, EVERY DAY</div><h2>${c.bot.enabled?'Unusual已准备好倾听。':'你好，欢迎来到Unusual。'}</h2><p>${c.bot.enabled?'按你设定的人设与群聊节奏，回应聊天，也主动分享生活里的小事。':'连接一个模型，写下它的性格，再让它加入你的群聊。所有人设与聊天记录，都留在这个文件夹里。'}</p><div class="hero-actions">${button(c.bot.enabled?'打开对话预览':'开始配置','navigate','arrow','',`data-target="${c.bot.enabled?'preview':'setup'}"`)}<span class="muted">${c.bot.enabled?'QQ 自动聊天已开启':'QQ 自动聊天尚未开启'}</span></div></div><div class="hero-art" aria-hidden="true"><div class="orbit"></div><div class="orbit two"></div><div class="hero-star">✦</div><div class="little-star">✧</div><div class="little-star two">✦</div></div></section>
  <div class="metric-grid">${metric('已启用群聊',enabled,'users',`共配置 ${c.groups.length} 个群聊`)}${metric('聊天记录',st.summary?.messageCount||0,'chat','接收、生成和发送的本地记录')}${metric('今日 Token',usage.totalTokens||0,'bolt',`每日上限 ${number(c.budget.dailyTokenLimit)}`)}${metric('今日模型调用',usage.calls||0,'cpu',`${number(usage.inputTokens)} 输入 · ${number(usage.outputTokens)} 输出`)}</div>
  <div class="columns"><section class="panel">${panelHead('让我们开始吧','完成连接后，就可以开启群聊陪伴。',badge(`${steps.filter(s=>s[2]).length} / 3 已完成`))}${steps.map(([title,copy,done,page],i)=>`<div class="setup-item"><div class="setup-number ${done?'done':''}">${done?icon('check'):String(i+1).padStart(2,'0')}</div><div class="setup-copy"><strong>${title}</strong><p>${copy}</p></div><button class="text-button" data-page="${page}">${done?'管理':'去设置'}${icon('arrow')}</button></div>`).join('')}<div class="divider"></div>${toggle('开启 QQ 自动聊天','bot.enabled','完成模型、桥接和群设置后，保存即可生效。')}</section>
  <section class="panel">${panelHead('此刻的Unusual','所有状态来自本机服务。')}${st.bridge?.incoming?.lastError?notice(st.bridge.incoming.lastError):''}<div class="status-row"><span>消息接收通道</span><span>${st.bridge?.incoming?.lastError?badge('校验失败','gray'):st.bridge?.incoming?.lastReceivedAt?badge('已收到事件'):badge('等待消息验证','gray')}</span></div><div class="status-row"><span>NapCat 连接</span><span>${st.bridge?.connected?badge(st.bridge.stale?'曾连接 · 待复查':'连接正常'):badge('等待连接','gray')}</span></div><div class="status-row"><span>官方机器人连接</span><span>${st.official?.connected?badge("连接正常"):badge("未连接","gray")}</span></div><div class="status-row"><span>官方群最近事件</span><span>${esc(time(st.official?.lastEventAt))}</span></div><div class="status-row"><span>自动聊天</span><span>${c.bot.enabled?badge('已开启'):badge('已暂停','gray')}</span></div><div class="status-row"><span>等待回复的群</span><span>${esc(Array.isArray(st.engine?.pendingGroups)?st.engine.pendingGroups.length:(st.engine?.pendingGroups||0))}</span></div><div class="status-row"><span>最近收到群消息</span><span>${esc(time(st.engine?.lastEventAt))}</span></div><div class="status-row"><span>最近自动回复</span><span>${esc(time(st.engine?.lastReplyAt))}</span></div><div class="callout">${icon('shield')}<div><strong>一个有边界的聊天伙伴</strong><p>没有命令执行工具，数据只写入软件目录。</p></div></div></section></div>
  <div class="section-gap">${button('查看运行与用量','navigate','bolt','secondary','data-target="activity"')}</div>${replyDiagnostics()}${st.engine?.lastError?`<div class="section-gap">${notice(`最近运行提示：${typeof st.engine.lastError==='string'?st.engine.lastError:JSON.stringify(st.engine.lastError)}`,'warning')}</div>`:''}<div class="footnote">一点温度，一点留白。让对话有自己的节奏。</div>`;
}
function metric(label,value,ico,footer){return `<div class="metric"><div class="metric-top"><span>${label}</span>${icon(ico)}</div><div class="metric-value">${number(value)}</div><div class="metric-footer">${esc(footer)}</div></div>`;}
function preview(){
  const c=S.config,pid=S.previewPersona||c.defaultPersonaId,provider=S.previewProvider||c.defaultProviderId,persona=c.personas.find(item=>item.id===pid);
  return `${heading('CONVERSATION STUDIO','对话预览','先聊一聊，找到你喜欢的语气。这里的对话只发生在本地预览中。')}
  <div class="chat-layout"><section class="panel chat-panel"><div class="chat-top"><div class="chat-persona"><div class="entity-icon">✦</div><div><h3>${esc(persona?.name||'未选择人设')}</h3><small>独立预览会话 · 不发送至 QQ</small></div></div><div class="inline-actions">${button('重新应用提示词','reset-preview','refresh','ghost small')}${button('新对话','new-chat','plus','ghost small')}</div></div><div id="chat-messages" class="chat-messages">${chatMessages()}</div><div class="composer"><textarea id="preview-message" placeholder="和它打个招呼，或试试一个群聊话题…" aria-label="预览消息" ${S.previewBusy?'disabled':''}>${esc(S.previewDraft)}</textarea><div class="composer-footer"><span>Ctrl + Enter 发送</span>${button(S.previewBusy?'正在思考…':'发送消息','preview-send','send','',S.previewBusy?'disabled':'')}</div></div></section>
  <aside class="chat-sidebar"><div class="panel">${panelHead('这次和谁聊天')}<label class="field"><span>人设</span><select id="preview-persona">${c.personas.map(item=>`<option value="${esc(item.id)}" ${item.id===pid?'selected':''}>${esc(item.name)}</option>`).join('')}</select></label><label class="field"><span>模型接口</span><select id="preview-provider">${c.providers.map(item=>`<option value="${esc(item.id)}" ${item.id===provider?'selected':''}>${esc(item.name)}${item.enabled?'':'（已停用）'}</option>`).join('')}</select></label><label class="checkline"><input type="checkbox" id="preview-search" ${S.previewSearch?'checked':''}>允许本次联网搜索</label><p class="field-help">需先在「联网与语音」配置搜索接口。</p><div class="divider"></div><div class="muted">${esc(persona?.description||'在「人设管理」中写下性格与对话习惯。')}</div></div><div class="panel"><h3>上下文预算</h3><p class="field-help">默认只携带近期对话，并限制单次输出。可以在「设置与用量」调整上下文与每日额度。</p><div class="status-row"><span>上下文消息</span><span>${c.budget.contextMessages} 条</span></div><div class="status-row"><span>单次输出上限</span><span>${number(c.budget.maxOutputTokens)} Token</span></div></div></aside></div>`;
}
function chatMessages(){return S.chat.length?S.chat.map(message=>`<div class="message ${message.role} ${message.error?'error':''}"><div class="avatar">${message.role==='user'?'你':'✦'}</div><div><div class="bubble">${esc(message.content)}</div>${message.sources?.length?`<div class="source-links">${message.sources.map((source,i)=>`<a href="${safeUrl(source.url)}" target="_blank" rel="noopener noreferrer">${i+1}. ${esc(source.title||source.url)}</a>`).join('')}</div>`:''}<div class="message-meta">${esc(shortTime(message.at))}${message.usage?` · ${number(message.usage.inputTokens||0)} 输入 / ${number(message.usage.outputTokens||0)} 输出`:''}</div></div></div>`).join(''):empty('从一句「你好」开始','在发送到群聊之前，试试人设、调整语气，看看它会如何回应。','chat');}
function scrollChat(){const box=$('#chat-messages');if(box)box.scrollTop=box.scrollHeight;}
function groups(){
  const c=S.config,st=S.status;if(!c.groups.some(g=>g.id===S.groupId))S.groupId=c.groups[0]?.id;const index=c.groups.findIndex(g=>g.id===S.groupId),g=c.groups[index],p=`groups.${index}`;
  return `${heading('QQ CONNECTION','QQ 会话','选择群聊或好友，分别设置人设、回复节奏和媒体功能。',button('选择聊天的群','import-groups','users','')+button('添加好友','add-friend','users','secondary'))}
  <div class="section-gap editor-layout session-editor"><section class="panel entity-list">${c.groups.map(group=>`<button class="entity ${group.id===S.groupId?'active':''}" data-action="select-group" data-id="${esc(group.id)}"><div class="entity-icon">${icon('users')}</div><div class="entity-copy"><strong>${esc(sessionLabel(group))}</strong><small>${group.channel==='official'?'官方机器人':'NapCat'} · ${esc(c.personas.find(p=>p.id===group.personaId)?.name||'未指定')} · ${group.enabled?'已启用':'已暂停'}</small></div></button>`).join('')}${button('添加一个群','add-group','plus','ghost entity-add')}</section><section class="panel">${g?groupEditor(g,p):empty('添加你的第一个会话','添加群号，或点击“添加好友”选择已登录 QQ 的好友。只有添加并启用的会话才会自动回复。','users',button('添加群聊','add-group','plus',''))}</section></div>`;
}
function groupTurnSettings(g,p){
  if(g.id.startsWith('private:'))return '';
  const percent=g.turnCheckPercent??100;
  return '<h3>群聊接话</h3>'+toggle('判断群友在和谁说话',p+'.turnCheckEnabled','明确 @、引用和连续追问优先回应；其余消息可以结合上下文判断。')
    +'<label class="field"><span>模糊消息使用上下文判断的概率 <output>'+percent+'%</output></span><input type="range" min="0" max="100" step="1" data-bind="'+p+'.turnCheckPercent" value="'+percent+'"><small>仅在上方开关开启时生效。0% 跳过模糊判断，按原接话条件回答；100% 每次都判断。明确指向其他成员的消息单独处理。</small></label>'
    +field('自动回复内容',p+'.reactionStyle',{options:[['normal','正常回答，表情可配文字'],['allow','允许单独发表情包或颜文字'],['only','仅发表情包或颜文字']],hint:'独立于判断概率和文字配图概率。启用「仅发」后，命中回复条件就直接发表情，无需调用聊天模型；没有可用图片时发颜文字。'})
    +'<div class="divider"></div>';
}
function groupEditor(g,p){return `${budgetEstimatePanel(g.id)}`+`${button('重新应用人设（新上下文）','reset-group-context','refresh','secondary',`data-id="${esc(g.id)}"`)}<p class="field-help">开始新上下文，保留历史与可塑性记忆。每次请求读取当前人设；重新应用后在历史前后携带完整基础人设，可能增加输入消耗。</p>${privateSettings(g,p)}${panelHead(g.name||'群聊设置',`${g.id.startsWith('private:')?'好友 QQ':g.channel==='official'?'官方机器人群':'NapCat 群号'} ${g.id.replace('private:','')}`,button('删除','delete-group','trash','ghost small',`data-id="${esc(g.id)}"`))}<div id="group-reply-status">${groupReplyStatus(g.id)}</div>${toggle('启用这个会话',`${p}.enabled`,'还需在总览或设置中开启 QQ 自动聊天总开关。')}<div class="divider"></div><div class="form-grid">${field('会话名称',`${p}.name`)}${field('回复方式',`${p}.replyMode`,{options:[['smart','自然参与 · 关键词 + 概率'],['all','每条消息都尝试回应'],['keywords','匹配关键词时回应'],['mention',g.id.startsWith('private:')?'直接回应好友':'仅被 @ 时回应']],hint:'自然参与无需被 @。冷却中的已触发消息会合并排队，最长等待 5 分钟；仍受安静时段与额度限制。'})}${field('使用人设',`${p}.personaId`,{options:optionsFor('personas'),hint:'切换并保存后，从新上下文开始；旧聊天记录保留。'})}${field('使用模型',`${p}.providerId`,{options:optionsFor('providers')})}${field('触发关键词',`${p}.keywords`,{type:'list',hint:'用逗号分隔，例如：小星，大家，今天'})}<label class="field"><span>自然参与概率 <output>${Math.round((g.replyProbability??.08)*100)}%</output></span><input type="range" min="0" max="100" data-bind="${p}.replyProbability" data-percent="true" value="${Math.round((g.replyProbability??.08)*100)}"><small>控制自然参与模式下普通消息触发回复的机会。明确 @、引用或命中关键词可单独触发。</small></label>${field('回复冷却（秒）',`${p}.cooldownSec`,{type:'number',min:0})}${field('连续消息合并等待（秒）',`${p}.debounceSec`,{type:'number',min:0,max:60,hint:'短时间的多条聊天消息合并成一次请求，减少消耗。'})}${field('每小时最多回复',`${p}.maxRepliesPerHour`,{type:'number',min:1,step:1,hint:'可自定义任意正整数，不再限制 300 条。旁边显示已生效设置的最近 60 分钟滑动统计（约 12 秒刷新）；修改后需保存。仍独立于 Token 预算。'})}${field('忽略的 QQ 号',`${p}.ignoreUserIds`,{type:'list',hint:'以逗号分隔，建议添加其他机器人 QQ 号。'})}${field('安静时段开始',`${p}.quietStart`,{type:'time'})}${field('安静时段结束',`${p}.quietEnd`,{type:'time',hint:'按北京时间。开始与结束相同时不启用安静时段。'})}</div>${groupTurnSettings(g,p)}${toggle('被 @ 时也触发回复',`${p}.mentionReply`,'不受接话概率影响。冷却中会排队，仍遵守安静时段与额度限额。')}${toggle('识别聊天图片和图片表情',`${p}.visionEnabled`,'需要所选模型支持识图。每次最多读取最近 90 秒内的一张图片，最大 5 MB；低分辨率识别，不额外调用一次模型。')}${toggle('允许自动发送表情包',`${p}.autoEmoji`,'只会选择软件目录中已有的表情。')}<label class="field"><span>自动表情概率 · 从低到高 <output>${g.emojiProbability??35}%</output></span><input type="range" min="0" max="100" step="5" data-bind="${p}.emojiProbability" value="${g.emojiProbability??35}"><small>0% 不主动配图，100% 每次符合条件的文字回复都配图；明确要求表情时不受概率限制，语音回复不混发图片。</small></label>${toggle('允许自主引用回复',`${p}.quoteReply`,'引用当前会话近期的真实消息。')}${toggle('允许自主 @ 群成员',`${p}.allowMention`,'仅限当前会话近期发言成员，不支持 @ 全体。')}${toggle('允许自主戳一戳',`${p}.allowPoke`,'仅限当前会话近期发言成员，每次回复最多一次。')}${field('戳一戳最短间隔（秒）',`${p}.pokeIntervalSec`,{type:'number',min:60,max:86400})}${field('回复形式',`${p}.voiceMode`,{options:[['text','只发文字'],['auto','自动混合 · 自主选择文字或语音'],['always','全部转语音']],hint:'自动混合无需你每次要求；仍需触发回复。想在冷场主动说话，还需开启下方主动发起话题。'})}${toggle('根据聊天自动生成语气',`${p}.dynamicVoiceTone`,'利用同一次聊天模型请求生成语气，不额外调用一次模型；不能感知麦克风或房间环境。')}${field('自动混合：语音最短间隔（秒）',`${p}.voiceIntervalSec`,{type:'number',min:0})}${field('自动混合：语音最长字数',`${p}.voiceMaxChars`,{type:'number',min:10,max:1000,hint:'超过长度或尚在间隔内，本次改发文字，不丢掉回复。'})}${field('当前会话音色 ID（留空用全局）',`${p}.voiceId`)}${field('当前会话语气（留空用全局）',`${p}.voiceInstructions`,{type:'textarea',rows:2})}<div class="divider"></div><h3>主动聊一聊</h3>${toggle('主动发起话题',`${p}.proactive.enabled`,'按间隔发起对话，并遵守当前会话安静时段。')}<div class="form-grid">${toggle('主动发言时随机抽取一个梗',`${p}.proactive.randomMeme`,'每次先从本地梗库随机选一条，再结合上面的主动聊天引导生成。每个会话避开最近成功发送的20个梗；库太小时允许复用。需要启用梗百科，不依赖自动思考梗开关，不额外调用模型。')}<p id="proactive-meme-status" class="field-help">${esc(proactiveMemeStatus(g.id))}</p>${field('主动消息间隔（分钟）',`${p}.proactive.intervalMin`,{type:'number',min:5})}${field('主动聊天引导',`${p}.proactive.prompt`,{type:'textarea',rows:2})}</div><div class="divider"></div><h3>提示词与上下文</h3><p class="field-help">每次模型请求都带上当前人设。重新应用会取消当前会话等待中的回复并开始新上下文，历史记录保留；此操作不调用模型，也不直接向群发送消息。</p><div class="divider"></div><h3>手动发送到这个会话</h3><p class="field-help">以下操作会真实发送 QQ 消息。请先保存设置；发送同样受总开关、安静时段和冷却限制。</p><label class="field section-gap"><span>消息内容</span><textarea id="manual-message" placeholder="写一条聊天消息，可在下方搭配本地表情…" rows="3"></textarea></label><label class="field section-gap"><span>搭配表情（可单独发送）</span><select id="manual-emoji"><option value="">不发送表情</option>${S.emoji.map(item=>`<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('')}</select><small>从表情库选择。语音模式仅发送语音，不搭配图片。</small></label>${groupMentionControl(g)}<div class="toolbar"><label class="checkline"><input id="manual-voice" type="checkbox">以语音发送</label>${button('发送到此会话','manual-send','send','',`data-id="${esc(g.id)}"`)}${button('让它主动聊一句','proactive','bolt','secondary',`data-id="${esc(g.id)}"`)}</div>`;}
function personas(){
  const c=S.config;if(!c.personas.some(p=>p.id===S.personaId))S.personaId=c.personas[0]?.id;const index=c.personas.findIndex(p=>p.id===S.personaId),p=`personas.${index}`,persona=c.personas[index];
  return `${heading('PERSONALITY LIBRARY','人设管理','为不同的群创造不同的陪伴。人设会用于群聊、对话预览和对外 API。',button('新建人设','add-persona','plus',''))}<div class="editor-layout"><section class="panel entity-list">${c.personas.map(item=>`<button class="entity ${item.id===S.personaId?'active':''}" data-action="select-persona" data-id="${esc(item.id)}"><div class="entity-icon">${esc(item.name.charAt(0)||'✦')}</div><div class="entity-copy"><strong>${esc(item.name)}</strong><small>${item.id===c.defaultPersonaId?'默认人设':esc(item.description||item.id)}</small></div></button>`).join('')}${button('新建人设','add-persona','plus','ghost entity-add')}</section><section class="panel">${persona?`${panelHead('人设详情','修改后点击右上角保存设置。',`<div class="inline-actions">${button('复制','duplicate-persona','copy','ghost small')}${button('删除','delete-persona','trash','ghost small')}</div>`)}<div class="form-grid">${field('名字',`${p}.name`)}<div class="field"><span>人设 ID</span><input value="${esc(persona.id)}" readonly><small>对外 API 可通过此 ID 指定人设。</small></div>${field('一句话介绍',`${p}.description`,{wide:true,placeholder:'例如：温柔但有主见，偶尔说点冷笑话。'})}${field('人设提示词',`${p}.prompt`,{type:'textarea',wide:true,cls:'prompt',placeholder:'写下它的性格、说话方式、偏好，以及你希望它记住的约定。',hint:'写清楚语气、关系与回复长度，通常比堆叠规则更省 Token。'})}${field('注入方式',`${p}.injectionMode`,{options:[['legacy','沿用旧规则 · 人设约 1–2 倍'],['single','前置一次 · 人设 1 倍（省用量）'],['double','前后各一次 · 人设约 2 倍（加强提醒）'],['tail','仅后置人设 · 约 1 倍'],['reminder','前置＋末尾简短提醒 · 1 倍＋少量提醒']],wide:true,hint:'倍数仅指基础人设文本；聊天记录、记忆和回复不翻倍。前后注入在同一次请求内完成，不是调用两次模型。仅后置：完整人设放在历史后；简短提醒：末尾重申遵守前文，不重复全文。Gemini 会将 system 消息合并，不能保证人设位于历史后。旧规则：新上下文后使用前后两份。'})}<div class="field wide" id="persona-token-summary">${personaTokenSummary(persona)}</div><h3>可塑性记忆</h3>${variablePersona(persona.id)}${variablePersonality(persona.id)}${legacyPersonality()}${field('表达温度',`${p}.temperature`,{type:'number',min:0,max:2,step:.1,hint:'通常 0.6–1.0 比较自然。不同模型支持范围可能不同。'})}<div class="field"><span>默认人设</span><select data-bind="defaultPersonaId"><option value="">不使用人设</option>${c.personas.map(item=>`<option value="${esc(item.id)}" ${item.id===c.defaultPersonaId?'selected':''}>${esc(item.name)}</option>`).join('')}</select><small>新群与未指定人设的 API 请求默认使用。</small></div></div>${notice('人设只用于生成聊天内容。模型只能使用已开放的固定聊天功能和只读梗库查询，不能运行命令或任意读写电脑文件。')}`:empty('还没有人设','新建一个人设，写下它的名字与性格。','persona')}</section></div>`;
}
function providers(){
  const c=S.config;if(!c.providers.some(p=>p.id===S.providerId))S.providerId=c.providers[0]?.id;const index=c.providers.findIndex(p=>p.id===S.providerId),p=`providers.${index}`,provider=c.providers[index];
  return `${heading('MODEL CONNECTIONS','选择思考的方式','支持 Google Gemini、DeepSeek，以及 OpenAI 兼容接口。按群分配不同模型。',button('添加接口','add-provider','plus',''))}<div class="editor-layout"><section class="panel entity-list">${c.providers.map(item=>`<button class="entity ${item.id===S.providerId?'active':''}" data-action="select-provider" data-id="${esc(item.id)}"><div class="entity-icon">${item.type==='gemini'?'✦':icon('cpu')}</div><div class="entity-copy"><strong>${esc(item.name)}</strong><small>${esc(item.model)} · ${item.enabled?'已启用':'已停用'}</small></div></button>`).join('')}${button('添加接口','add-provider','plus','ghost entity-add')}</section><section class="panel">${provider?`${panelHead('模型接口设置','API Key 仅保存在软件自己的配置文件中。',button('删除接口','delete-provider','trash','ghost small'))}${toggle('启用这个接口',`${p}.enabled`)}<div class="divider"></div><div class="form-grid">${field('显示名称',`${p}.name`)}${field('协议类型',`${p}.type`,{options:[['openai','OpenAI 兼容（含 DeepSeek）'],['gemini','Google Gemini 原生']]})}${field('API Base URL',`${p}.baseUrl`,{wide:true,placeholder:'https://api.deepseek.com',hint:'填写接口根地址，如 OpenAI 兼容服务的 /v1，或 Gemini 的 /v1beta。'})}${field('API Key',`${p}.apiKey`,{type:'password',wide:true,placeholder:'粘贴你的 API Key'})}${modelPicker(provider,p)}${field('模型名称 / ID',`${p}.model`,{placeholder:'deepseek-flash',hint:'可自由填写该服务支持的模型 ID。'})}<div class="field"><span>接口 ID</span><input value="${esc(provider.id)}" readonly><small>对外 API 可通过此 ID 选择接口。</small></div><div class="field wide"><span>默认模型接口</span><select data-bind="defaultProviderId">${c.providers.map(item=>`<option value="${esc(item.id)}" ${item.id===c.defaultProviderId?'selected':''}>${esc(item.name)}</option>`).join('')}</select><small>新群和未指定模型的 API 请求使用此接口。</small></div></div><div class="toolbar">${button('保存并到预览测试','test-provider','chat','',`data-id="${esc(provider.id)}"`)}<span class="muted">发送预览消息会产生真实 API 用量。</span></div><div class="section-gap">${notice('模型、搜索与语音会将所需文本发送到你配置的服务商。密钥不会存入浏览器 localStorage。')}</div>`:empty('添加你的第一个模型','准备好 API Key，即可连接 Google、DeepSeek 或兼容服务。','cpu',button('添加接口','add-provider','plus',''))}</section></div>`;
}

function historyPage(){
  return `${heading('LOCAL CONVERSATION ARCHIVE','聊天记录','查看、搜索和整理本地记录。群聊、私聊、预览与 API 会话都会留下清晰的来源。',button('刷新记录','history-refresh','refresh','secondary'))}<section class="panel"><div class="toolbar"><div class="grow search-wrap">${icon('search')}<input id="history-query" value="${esc(S.historyQuery)}" placeholder="搜索消息内容…" aria-label="搜索消息内容"></div><input id="history-group" list="history-groups" value="${esc(S.historyGroup)}" placeholder="群号或 private:好友QQ（全部）" aria-label="群号或会话 ID" class="history-filter"><datalist id="history-groups">${S.config.groups.map(g=>`<option value="${esc(g.id)}">${esc(sessionLabel(g))}</option>`).join('')}</datalist>${button('搜索','history-search','search','')}</div><div class="toolbar section-gap">${button('导出当前会话记录','history-export','download','secondary small')}${button('删除选中','history-delete','trash','secondary small')}${button('清空当前会话记录','history-clear','trash','danger small')}<span class="muted">导出至软件目录下 data/exports。导出整个会话，不受关键词、日期等筛选限制；留空会话时导出全部记录。</span></div>${historyFilters()}<div id="history-results">${historyRows()}</div></section>`;
}
function historyRows(){
  const source={qq:'QQ 群聊',preview:'对话预览',api:'对外 API',manual:'手动发送'},status={received:'已接收',sent:'已发送',failed:'发送失败',generated:'已生成'},role={user:'成员',assistant:'Unusual',system:'系统'};
  return `${S.messages.length?`<div class="table-wrap"><table><thead><tr><th class="table-check"><input type="checkbox" id="history-select-all" aria-label="选择当前已加载的所有记录" ${S.messages.every(m=>S.selectedMessages.has(m.id))?'checked':''}></th><th>时间 / 来源</th><th>群聊 / 会话</th><th>发送者</th><th>消息内容</th><th>状态</th></tr></thead><tbody>${[...S.messages].reverse().map(m=>`<tr><td><input type="checkbox" data-message-id="${m.id}" aria-label="选择消息 ${m.id}" ${S.selectedMessages.has(m.id)?'checked':''}></td><td class="nowrap">${esc(time(m.createdAt))}<div class="muted">${esc(m.source==='qq'&&m.groupId.startsWith('private:')?'QQ 私聊':source[m.source]||m.source)}</div></td><td>${esc(groupName(m.groupId))}</td><td class="nowrap">${esc(m.senderName||role[m.role]||m.senderId||'—')}</td><td class="message-content">${esc(m.content)}</td><td>${badge(status[m.status]||m.status,m.status==='failed'?'red':m.status==='sent'?'':'gray')}${m.source==='qq'&&m.role==='user'?button('处理过程','message-trace','info','ghost small','data-id="'+m.id+'"'):''}</td></tr>`).join('')}</tbody></table></div>`:empty('还没有找到记录','群消息、对话预览与 API 请求会记录在这里。也可以调整搜索词或群号。','clock')}<div class="history-footer"><span class="history-count">已加载 ${number(S.messages.length)} / ${number(S.messageTotal)} 条 · 已选 ${number(S.selectedMessages.size)} 条</span>${S.messages.length<S.messageTotal?button('加载更早记录','history-more','clock','secondary small'):''}</div>`;
}
function bundlePrompt(){
  if(S.bundleEnabled!==false)return '';
  if(localStorage.getItem('emoji.bundle.declined')==='1')return button('导入自带表情包','emoji-bundle-show','smile','secondary');
  return '<div class="notice"><div><strong>是否启用自带表情包？</strong><p>73 张图片，选择是后导入本地表情库。</p><div class="toolbar">'+button('是，导入','emoji-bundle-yes','check')+button('否','emoji-bundle-no','close','secondary')+'</div></div></div>';
}
function emoji(){
  return `${heading('EXPRESSION COLLECTION','表情包管理','将喜欢的表情放进Unusual的文件夹。添加标签，帮助它挑选合适的表达。',button('刷新','emoji-refresh','refresh','secondary'))}<section class="panel"><div id="bundle-prompt">${bundlePrompt()}</div><div class="dropzone" id="emoji-drop">${icon('upload')}<div><h3>拖入表情包，或选择图片</h3><p>PNG / JPG / GIF / WebP · 单张最多 5 MB · 支持多选</p></div>${button('选择图片','emoji-upload','plus','')}<input id="emoji-files" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden></div>${emojiFilters()}<div id="emoji-grid">${emojiGrid()}</div></section>`;
}
function emojiGrid(){
 const words=EmojiUI.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
 const items=S.emoji.map((item,i)=>({item,i})).filter(({item})=>(!EmojiUI.untagged||!item.tags?.length)&&words.every(word=>(item.name+' '+(item.tags||[]).join(' ')).toLowerCase().includes(word)));
 const count='<p class="field-help">显示 '+items.length+' / '+S.emoji.length+' 张 · '+EmojiUI.drafts.size+' 张标签尚未保存</p>';
 if(!items.length)return count+empty(S.emoji.length?'没有匹配的表情':'表情库还是空的',S.emoji.length?'试试文件名或标签，也可以清除筛选。':'上传表情并填写标签，帮助模型理解什么时候发送。','smile');
 return count+'<div class="emoji-grid">'+items.map(({item,i})=>'<article class="emoji-card"><div class="emoji-picture"><img src="'+safeUrl(item.url)+'" alt="'+esc(item.name)+'" loading="lazy"></div><div class="emoji-name" title="'+esc(item.name)+'">'+esc(item.name)+'</div><input id="emoji-tags-'+i+'" value="'+esc(EmojiUI.drafts.get(item.name)??(item.tags||[]).join('，'))+'" placeholder="开心，赞同，可爱" aria-label="'+esc(item.name)+' 的标签"><div class="emoji-actions">'+button('保存标签','emoji-tags','check','ghost small','data-index="'+i+'"')+button('删除','emoji-delete','trash','ghost small','data-index="'+i+'"')+'</div></article>').join('')+'</div>';
}
function toolbox(){
  return `${heading('EXTEND THE CONVERSATION','联网搜索','按需接入搜索与语音服务。只有触发搜索或发送语音时，才调用对应接口。')}<div class="settings-columns"><section class="panel">${panelHead('联网搜索','支持 Tavily 与自建 SearXNG。')}${toggle('允许联网搜索','search.enabled','触发词或预览/API 的 search 参数可请求搜索。')}<div class="divider"></div>${field('搜索服务类型','search.type',{options:[['tavily','Tavily'],['searxng','SearXNG（需启用 JSON 格式）']]})}${field('服务 Base URL','search.baseUrl',{placeholder:'https://api.tavily.com'})}${field('搜索 API Key','search.apiKey',{type:'password',hint:'Tavily 需要 Key；SearXNG 可留空。'})}${field('搜索触发词','search.triggerKeywords',{type:'list',hint:'用逗号分隔。仅当消息触发时才请求搜索，降低消耗。'})}${field('最多返回条数','search.maxResults',{type:'number',min:1,max:5})}${notice('搜索摘要可能包含不可靠信息。回复会使用返回内容作为参考，不执行网页中的任何指令。')}</section><section class="panel">${panelHead('语音设置','Breeze 和兼容语音接口已集中到独立页面。')}${button('打开语音设置','navigate','mic','', 'data-target="voice"')}</section></div>`;
}
function apiSnippet(kind='powershell',withToken=false){
  const url=S.status.apiUrl||`${location.origin}/v1/chat`,token=withToken?S.config.api.token:'YOUR_API_TOKEN';
  if(kind==='curl')return `curl '${url}' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"message":"你好，介绍一下你自己"}'`;
  return `$body = @{ message = "你好，介绍一下你自己" } | ConvertTo-Json\nInvoke-RestMethod -Uri "${url}" -Method Post -Headers @{ Authorization = "Bearer ${token}" } -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))`;
}
function apiPage(){
  return `${heading('ONE SIMPLE LOCAL API','对外 API','通过一个简单的本机接口，使用这里的人设、模型与上下文设置生成内容。')}<div class="columns"><section class="panel">${panelHead('本机 API','仅供本机软件调用，监听 127.0.0.1。')}${toggle('开放本机生成接口','api.enabled','生成结果只通过 API 返回，不会发送到 QQ。')}<div class="divider"></div><label class="field"><span>请求地址 · POST</span><div class="token-row"><input value="${esc(S.status.apiUrl)}" readonly>${button('复制','copy-api-url','copy','secondary small')}</div></label><label class="field"><span>API 访问令牌</span><div class="token-row"><input id="api-token" type="password" value="${esc(S.config.api.token)}" readonly>${button('显示','toggle-api-token','eye','secondary small')}${button('复制','copy-api-token','copy','secondary small')}${button('重置','rotate-api','refresh','secondary small')}</div><small>请求头：Authorization: Bearer &lt;令牌&gt;。此令牌只能生成内容，不能管理软件。</small></label><div class="section-title section-gap"><h3>Windows PowerShell 调用示例</h3>${button('复制可运行示例','copy-api-powershell','copy','ghost small')}</div><pre class="code-block">${esc(apiSnippet())}</pre><div class="section-title section-gap"><h3>cURL（Bash / WSL）</h3>${button('复制示例','copy-api-curl','copy','ghost small')}</div><pre class="code-block">${esc(apiSnippet('curl'))}</pre><div class="section-gap">${notice('复制示例会带入当前 API 令牌。请只交给你信任的本机软件；重置后旧令牌立即失效。')}</div></section><section class="panel">${panelHead('只需一句消息')}<p class="field-help">最小请求体：</p><pre class="code-block">{"message": "你好"}</pre><div class="divider"></div><h3>可选参数</h3><div class="status-row"><span>personaId</span><span>指定人设 ID</span></div><div class="status-row"><span>providerId</span><span>指定模型接口 ID</span></div><div class="status-row"><span>sessionId</span><span>连续对话时复用会话 ID</span></div><div class="status-row"><span>search</span><span>true 时请求联网搜索</span></div><div class="divider"></div><h3>返回字段</h3><pre class="code-block">{\n  "text": "模型生成的内容",\n  "sessionId": "会话标识",\n  "usage": {\n    "inputTokens": 0,\n    "outputTokens": 0\n  },\n  "sources": []\n}</pre><p class="field-help">以上仅为响应结构示意。读取 text 即可得到回复；下次请求传入 sessionId 即可延续对话。会话与 QQ 群、预览相互隔离。</p><div class="divider"></div><h3>当前默认</h3><div class="status-row"><span>人设 ID</span><span>${esc(S.config.defaultPersonaId)}</span></div><div class="status-row"><span>接口 ID</span><span>${esc(S.config.defaultProviderId)}</span></div></section></div>`;
}
let appUpdate={phase:'idle'};
function updatePanel(){
  if(!window.qiliaoDesktop?.checkUpdate)return '<p>请在 Unusual 桌面窗口中检查和下载更新。</p>';
  const u=appUpdate,busy=['checking','downloading'].includes(u.phase);
  const mib=n=>(n/1048576).toFixed(1)+' MB';
  const text=u.phase==='idle'?'从项目的 GitHub 正式发布页检查 Windows 更新。':u.phase==='checking'?'正在检查 GitHub…':u.phase==='error'?('更新失败：'+u.error):u.phase==='downloading'?('正在下载 '+mib(u.received)+' / '+mib(u.total)):u.phase==='done'?('下载完成，校验通过：'+u.file):('GitHub 最新版 v'+u.latest+(u.available?' 可下载':'；当前已是此版本或更高'));
  return '<p role="status" class="field-help">'+esc(text)+'</p><div class="toolbar">'
    +button('检查更新','app-update-check','refresh','secondary',busy?'disabled':'')
    +(u.available&&u.phase!=='done'?button('下载更新','app-update-download','download','secondary',busy?'disabled':''):'')
    +(u.phase==='done'?button('保留数据并重启更新','app-update-apply','refresh')+button('查看已下载文件','app-update-folder','folder','secondary'):'')
    +'</div><p class="field-help">安装时会短暂离线。新版本沿用原目录的配置、群聊、人设、记录和连接凭据。</p>';
}
function updatesPage(){
  return '<div class="page-heading"><h1>软件更新</h1></div><section class="panel"><div class="status-row"><span>当前版本</span><strong>v'+esc(S.status.version)+'</strong></div><div id="app-update-panel">'+updatePanel()+'</div></section>';
}
function paintUpdate(){const panel=document.getElementById('app-update-panel');if(panel)panel.innerHTML=updatePanel();}
async function runUpdate(download){
  const desktop=window.qiliaoDesktop;
  appUpdate={...appUpdate,phase:download?'downloading':'checking',received:0};paintUpdate();
  let active=true;
  async function poll(){try{const s=await desktop.updateStatus();if(active){appUpdate=s;paintUpdate();}}catch{}}
  const timer=download?setInterval(poll,700):null;
  try{appUpdate=await (download?desktop.downloadUpdate():desktop.checkUpdate());}
  catch(e){appUpdate={phase:'error',error:e.message};}
  finally{active=false;clearInterval(timer);paintUpdate();}
}
function settings(){
  const c=S.config,usage=S.status.summary?.todayUsage||{},percent=Math.min(100,Math.round((usage.totalTokens||0)/c.budget.dailyTokenLimit*100));
  return `${heading('LOCAL & UNDER CONTROL','设置与用量','控制用量、记录保留和运行状态。修改配置后，点击右上角保存。')}<div class="settings-columns"><section class="panel">${panelHead('聊天与用量')}${field('机器人名称','bot.name')}${toggle('QQ 自动聊天总开关','bot.enabled','暂停后不自动回复或主动发言。预览与本机 API 仍可使用。')}<div class="divider"></div><h3>用量预设</h3><div class="toolbar">${button('节省','budget-economy','bolt','secondary')}${button('均衡','budget-balanced','chat','secondary')}</div><p class="field-help">预设只调整单次输入、输出和上下文长度，不改人设或群聊策略。</p><h3>今日模型用量</h3><div class="progress-track"><div class="progress-bar" style="width:${percent}%"></div></div><div class="mini-stat"><span>${number(usage.totalTokens)} / ${number(c.budget.dailyTokenLimit)} Token</span><span>${percent}%</span></div><div class="form-grid section-gap">${field('每日 Token 上限','budget.dailyTokenLimit',{type:'number',min:100,max:100000000,hint:'按北京时间每天重新计算。达到上限后暂停模型请求。'})}${field('单次输入上限','budget.maxInputTokens',{type:'number',min:256,max:128000,hint:'包含人设、消息与参考内容。'})}${field('单次输出上限','budget.maxOutputTokens',{type:'number',min:16,max:16000,hint:'日常群聊建议 150–400 Token。'})}${field('保留上下文消息数','budget.contextMessages',{type:'number',min:0,max:200,hint:'仅取近期消息；0 表示不带历史上下文。'})}${field('历史记录保留天数','budget.retentionDays',{type:'number',min:1,max:3650,hint:'过期记录定期清理；重要对话请先导出。'})}</div>${notice(`Token 用量优先采用服务商返回值，未返回或请求超时时采用保守估算。今日估算调用 ${number(usage.estimatedCalls)} 次。服务商账单为实际费用依据；搜索和 TTS 可能单独计费。`)}</section><section class="panel">${panelHead('本地工作空间','整个软件与运行数据放在同一文件夹内。')}<div class="path">${esc(S.status.root)}</div><div class="status-row"><span>搜索缓存命中 / 实际搜索</span><span>${number(S.status.engine?.searchCache?.hits)} / ${number(S.status.engine?.searchCache?.requests)}</span></div><div class="status-row"><span>聊天后台内存</span><span>${number(S.status.runtime?.memoryMB)} MB</span></div><div class="status-row"><span>软件版本</span><span>${esc(S.status.version)}</span></div><div class="status-row"><span>本地服务</span><span>${esc(location.origin)}</span></div><div class="status-row"><span>本次运行时长</span><span>${Math.floor((S.status.uptime||0)/3600)} 小时 ${Math.floor((S.status.uptime||0)%3600/60)} 分钟</span></div><div class="status-row"><span>表情包</span><span>data/emoji/</span></div><div class="status-row"><span>生成音频</span><span>data/audio/</span></div><div class="status-row"><span>导出的记录</span><span>data/exports/</span></div><div class="divider"></div><h3>聊天伙伴的能力边界</h3><ul class="permission-list"><li>${icon('check')}接收授权群消息，按策略生成和发送回复。</li><li>${icon('check')}使用配置好的模型、搜索与语音 HTTP 接口。</li><li>${icon('check')}在软件目录内保存配置、记录与媒体文件。</li><li>${icon('shield')}不提供终端、任意文件访问或电脑操作能力。</li></ul><div class="divider"></div>${button('退出Unusual','shutdown','power','danger')}<p class="field-help">停止后群聊与 API 都会离线。重新双击启动入口即可再次运行。</p></section></div>`;
}
function logs(){return `${heading('RUNTIME JOURNAL','运行日志','查看模型请求、桥接连接与运行异常，快速了解哪里需要调整。',button('刷新日志','logs-refresh','refresh','secondary'))}<section class="panel"><div class="toolbar"><h3 class="grow">最近运行日志</h3><select id="log-level" aria-label="日志级别"><option value="all" ${S.logLevel==='all'?'selected':''}>全部级别</option><option value="info" ${S.logLevel==='info'?'selected':''}>信息</option><option value="warn" ${S.logLevel==='warn'?'selected':''}>警告</option><option value="error" ${S.logLevel==='error'?'selected':''}>错误</option></select></div><div id="logs-list">${logRows()}</div></section>`;}
function logRows(){const items=S.logs.filter(item=>S.logLevel==='all'||item.level===S.logLevel);return items.length?`<div class="logs-list">${items.map(item=>`<div class="log-item"><time class="log-time">${esc(time(item.createdAt))}</time><div>${badge({info:'信息',warn:'警告',error:'错误'}[item.level]||item.level,{warn:'orange',error:'red'}[item.level]||'gray')}</div><div><strong>${esc(item.event)}</strong>${item.detail?`<div class="log-detail">${esc(formatLogDetail(item.detail))}</div>`:''}</div>`).join('')}</div>`:empty('这里暂时很安静','服务运行、连接测试或出现异常时，日志会显示在这里。','logs');}

async function saveConfig({quiet=false}={}){
  if(!S.dirty)return true;
  if(S.saving){toast('正在保存，请稍候。');return false;}
  S.saving=true;const revision=S.revision,snapshot=structuredClone(S.config);renderSaveState();
  try{const saved=await request('/api/config',{method:'PUT',body:snapshot});if(S.revision===revision){S.config=saved;S.dirty=false;}if(!quiet)toast('设置已保存到本地');return true;}catch(error){toast(`保存失败：${error.message}`,true);return false;}finally{S.saving=false;renderSaveState();}
}
async function refreshStatus(){try{S.status=await request('/api/status');S.pollError=false;updateStatusPill();const box=$('#group-reply-status');if(box)box.innerHTML=groupReplyStatus(S.groupId);const usage=$('#group-hourly-usage');if(usage)usage.textContent=hourlyUsage(S.groupId);const meme=$('#proactive-meme-status');if(meme)meme.textContent=proactiveMemeStatus(S.groupId);}catch{S.pollError=true;updateStatusPill();}}
async function loadHistory(more=false){
  const query=new URLSearchParams({limit:'100'});if(S.historyGroup)query.set('groupId',S.historyGroup);if(S.historyQuery)query.set('q',S.historyQuery);if(more&&S.messages.length)query.set('before',Math.min(...S.messages.map(m=>m.id)));
  for(const [key,value] of Object.entries(HistoryFilters))if(value)query.set(key,value);const seq=++historyRequest;
  const result=await request(`/api/messages?${query}`);if(seq!==historyRequest)return;S.messages=more?[...new Map([...result.items,...S.messages].map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id):result.items;if(!more)S.messageTotal=result.total;if(!more)S.selectedMessages.clear();if(S.page==='history')$('#history-results').innerHTML=historyRows();
}
async function loadEmoji(){const result=await request('/api/emoji');S.emoji=result.items||[];S.bundleEnabled=result.bundleEnabled;const prompt=$('#bundle-prompt');if(prompt)prompt.innerHTML=bundlePrompt();if(S.page==='emoji')$('#emoji-grid').innerHTML=emojiGrid();}
async function loadLogs(){const result=await request('/api/logs');S.logs=result.items||[];if(S.page==='logs')$('#logs-list').innerHTML=logRows();}
async function clipboard(text){if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);else{const temp=document.createElement('textarea');temp.value=text;document.body.append(temp);temp.select();const copied=document.execCommand('copy');temp.remove();if(!copied)throw new Error('无法自动复制，请手动选择文本。');}toast('已复制到剪贴板');}

const manualMentionDrafts=new Map();
const momentFriendNames=new Map();
const mentionLabel=(ids,names)=>ids.length?ids.map(id=>names.get(id)||id).join('、'):'未选择';
async function pickMentionTargets(rows,selected,{title,description}) {
  const entries=new Map(rows.filter(row=>/^[1-9]\d{0,19}$/.test(row.user_id)).map(row=>[row.user_id,row]));
  const result=await ask({title,description,confirm:'应用选择',
    fields:'<label class="field"><span>搜索</span><input type="search" id="mention-search" placeholder="昵称、备注、群名片或 QQ 号"></label>'+
      '<p class="field-help" id="mention-count" role="status"></p><p class="field-help" id="mention-no-results" hidden>没有匹配的成员</p>'+
      '<div class="group-picker">'+[...entries.values()].map(({user_id,name})=>
        '<label class="checkline"><input type="checkbox" name="mention_'+user_id+'" '+(selected.includes(user_id)?'checked':'')+'><span>'+esc(name)+'<small> · '+user_id+'</small></span></label>'
      ).join('')+'</div>',
    setup(dialog) {
      const labels=$$('.group-picker label',dialog), boxes=labels.map(label=>$('input',label));
      const search=$('#mention-search',dialog), count=$('#mention-count',dialog);
      const keys=[...entries.values()].map(row=>[row.name,row.nickname,row.user_id].join(' ').toLocaleLowerCase());
      function updateLimit(){
        const n=boxes.filter(box=>box.checked).length;
        count.textContent='已选择 '+n+' / 10';
        for(const box of boxes)box.disabled=n>=10&&!box.checked;
      }
      search.oninput=()=>{
        const q=search.value.trim().toLocaleLowerCase();
        let matches=0;
        labels.forEach((label,i)=>{const visible=keys[i].includes(q);label.style.display=visible?'':'none';if(visible)matches++;});
        $('#mention-no-results',dialog).hidden=matches>0;
      };
      search.onkeydown=e=>{if(e.key==='Enter')e.preventDefault();};
      for(const box of boxes)box.onchange=updateLimit;
      $('#mention-no-results',dialog).hidden=labels.length>0;
      updateLimit();
    }
  });
  if(!result)return null;
  return [...entries.keys()].filter(id=>Object.hasOwn(result,'mention_'+id)).map(id=>entries.get(id));
}
function groupMentionControl(group) {
  if(group.channel==='official'||!/^[1-9]\d{0,19}$/.test(group.id))return '';
  const picked=manualMentionDrafts.get(group.id)||[];
  return '<div class="field section-gap"><span>手动 @ 群成员</span>'+
    '<small id="manual-mentions-label">'+esc(picked.map(x=>x.name).join('、')||'未选择')+'</small>'+
    '<div class="toolbar">'+button('读取成员并多选','manual-mentions','users','secondary small','data-id="'+esc(group.id)+'"')+
    button('清空','clear-manual-mentions','trash','ghost small','data-id="'+esc(group.id)+'"')+
    '</div><small>最多 10 人，可单独 @，也可搭配文字或表情。语音发送请先清空 @。</small></div>';
}

function ask({title,description='',fields='',confirm='确定',danger=false,setup}){
  return new Promise(resolve=>{const dialog=$('#dialog');dialog.innerHTML=`<form id="dialog-form"><h2>${esc(title)}</h2><p>${esc(description)}</p>${fields}<div class="dialog-actions"><button class="button secondary" type="button" data-dialog-cancel>取消</button><button class="button ${danger?'danger':''}" type="submit">${esc(confirm)}</button></div></form>`;const finish=value=>{dialog.close();dialog.oncancel=null;resolve(value);};dialog.oncancel=event=>{event.preventDefault();finish(null);};$('[data-dialog-cancel]',dialog).onclick=()=>finish(null);$('#dialog-form',dialog).onsubmit=event=>{event.preventDefault();finish(Object.fromEntries(new FormData(event.target)));};setup?.(dialog);dialog.showModal();});
}
function dialogField(label,name,{value='',placeholder='',required=true,type='text'}={}){return `<label class="field"><span>${esc(label)}</span><input name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" type="${type}" ${required?'required':''}></label>`;}
function newGroup(groupId,name){return {id:String(groupId),name:name||String(groupId),enabled:false,personaId:S.config.defaultPersonaId,providerId:S.config.defaultProviderId,replyMode:'smart',keywords:[S.config.bot.name],replyProbability:.08,turnCheckEnabled:true,turnCheckPercent:100,reactionStyle:'normal',cooldownSec:45,debounceSec:3,mentionReply:true,ignoreUserIds:[],maxRepliesPerHour:20,quietStart:'23:00',quietEnd:'08:00',proactive:{enabled:false,intervalMin:120,prompt:'自然地发起一个轻松话题。'},autoEmoji:true,autoVoice:false};}
async function addGroup(){const result=await ask({title:'添加一个群聊',description:'添加后默认暂停，设置好回复策略并保存后再启用。',fields:dialogField('QQ群号','groupId',{placeholder:'输入数字群号'})+dialogField('群聊名称','name',{placeholder:'给这个群起个容易识别的名字',required:false}),confirm:'添加群聊'});if(!result)return;const groupId=result.groupId.trim();if(!/^[1-9]\d{0,19}$/.test(groupId))throw new Error('群号应为不以零开头的 1–20 位数字。');if(S.config.groups.some(g=>g.id===groupId))throw new Error('这个群已经添加过了。');S.config.groups.push(newGroup(groupId,result.name.trim()));S.groupId=groupId;markDirty();renderPage();}
async function addPersona(){const result=await ask({title:'新建人设',description:'先给它一个名字，再慢慢写下它的性格。',fields:dialogField('人设名称','name',{placeholder:'例如：小星'}),confirm:'创建人设'});if(!result)return;const persona={id:id('persona'),name:result.name.trim(),description:'',prompt:'',temperature:.8,injectionMode:'single'};S.config.personas.push(persona);S.personaId=persona.id;markDirty();renderPage();}
async function addProvider(){const result=await ask({title:'添加模型接口',description:'选择预设后，可以继续修改接口地址与模型名称。',fields:`<label class="field"><span>接口预设</span><select name="preset"><option value="deepseek">DeepSeek</option><option value="gemini">Google Gemini</option><option value="openai">OpenAI 兼容服务</option></select></label>`,confirm:'添加接口'});if(!result)return;const preset={deepseek:{name:'DeepSeek',type:'openai',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},gemini:{name:'Google Gemini',type:'gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-3.5-flash-lite'},openai:{name:'OpenAI 兼容接口',type:'openai',baseUrl:'https://api.openai.com/v1',model:'填写模型 ID'}}[result.preset];const provider={id:id(result.preset),...preset,apiKey:'',enabled:true};S.config.providers.push(provider);S.providerId=provider.id;markDirty();renderPage();}
async function removeEntity(kind){
  const key=kind==='group'?'groups':kind==='persona'?'personas':'providers',selected=S[`${kind}Id`],items=S.config[key],item=items.find(i=>i.id===selected);if(!item)return;
  if(kind==='provider'&&items.length<=1)throw new Error('请至少保留一个模型接口。');
  const bound=kind==='group'?[]:S.config.groups.filter(g=>g[`${kind}Id`]===selected);
  const result=await ask({title:`删除「${item.name}」？`,description:kind==='group'?'保存后此群不再接收自动回复。已有聊天记录会继续保留。':`删除后，${bound.length} 个绑定群及默认设置会切换到剩余的第一个选项。已有记录会保留。`,confirm:'删除并保留历史',danger:true});if(!result)return;
  S.config[key]=items.filter(i=>i.id!==selected);S[`${kind}Id`]=S.config[key][0]?.id;
  if(kind!=='group'){const fallback=S.config[key][0]?.id||'';for(const group of bound)group[`${kind}Id`]=fallback;const defaultKey=kind==='persona'?'defaultPersonaId':'defaultProviderId';if(S.config[defaultKey]===selected)S.config[defaultKey]=fallback;if(kind==='persona'&&S.previewPersona===selected)S.previewPersona=fallback;if(kind==='provider'&&S.previewProvider===selected)S.previewProvider=fallback;}
  markDirty();renderPage();
}
async function bridgeTest(importGroups=false){
  if(!await saveConfig({quiet:true}))return;S.bridgeBusy=true;if(S.page==='groups')renderPage();
  try{const result=await request('/api/bridge/test',{method:'POST',body:{}});if(result.info?.user_id&&!S.config.bot.selfId)S.config.bot.selfId=String(result.info.user_id);if(importGroups){let count=0;for(const item of result.groups||[]){const gid=String(item.group_id);if(/^\d{1,20}$/.test(gid)&&!S.config.groups.some(g=>g.id===gid)){S.config.groups.push(newGroup(gid,item.group_name));count++;}}if(count)markDirty();toast(count?`已导入 ${count} 个群，默认暂停。请设置后保存。`:'群列表已同步，没有新的群聊。');}else toast(`连接成功${result.info?.nickname?' · '+result.info.nickname:''}`);await refreshStatus();}finally{S.bridgeBusy=false;if(S.page==='groups')renderPage();}
}
async function sendPreview(){
  if(S.previewBusy)return;const message=$('#preview-message')?.value.trim();if(!message)return;if(!await saveConfig({quiet:true}))return;
  S.previewBusy=true;S.previewDraft='';const sessionId=S.previewSession;S.chat.push({role:'user',content:message,at:Date.now()});renderPage();
  try{const result=await request('/api/preview',{method:'POST',body:{message,personaId:S.previewPersona||S.config.defaultPersonaId,providerId:S.previewProvider||S.config.defaultProviderId,sessionId,search:S.previewSearch}});if(sessionId===S.previewSession){S.previewSession=result.sessionId||sessionId;S.chat.push({role:'assistant',content:result.text,at:Date.now(),usage:result.usage,sources:result.sources});}await refreshStatus();}catch(error){if(sessionId===S.previewSession)S.chat.push({role:'assistant',content:error.message,error:true,at:Date.now()});}finally{S.previewBusy=false;if(S.page==='preview')renderPage();}
}
async function uploadFiles(files){
  let uploaded=0;const failures=[];
  for(const file of files){try{if(file.size>5*1024*1024)throw new Error('超过 5 MB');if(!/\.(png|jpe?g|gif|webp)$/i.test(file.name))throw new Error('不支持此格式');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('读取图片失败'));reader.readAsDataURL(file);});await request('/api/emoji',{method:'POST',body:{name:file.name,data,tags:[]}});uploaded++;}catch(error){failures.push(`${file.name}：${error.message}`);}}
  await loadEmoji();toast(`已上传 ${uploaded} 张表情${failures.length?`；${failures.join('；')}`:''}`,failures.length>0);await refreshStatus();
}
async function rotateToken(kind){const result=await ask({title:`重置${kind==='api'?' API':'事件上报'}令牌？`,description:'旧令牌会立即失效。请将新令牌更新到使用它的其他软件中。',confirm:'重置令牌',danger:true});if(!result)return;const response=await request('/api/token/rotate',{method:'POST',body:{kind}});if(kind==='api')S.config.api.token=response.token;else S.config.onebot.webhookToken=response.token;renderPage();toast('令牌已重置并保存');}

const actions={
  'app-update-check':()=>runUpdate(false),
  'app-update-download':()=>runUpdate(true),
  'app-update-apply':async()=>{if(S.dirty)throw Error('请先保存设置再更新');if(await ask({title:'保留数据并重启更新？',description:'安装器将等待 Unusual 退出，在原目录更新程序，完成后自动打开。',confirm:'重启更新'}))await window.qiliaoDesktop.applyUpdate();},
  'app-update-folder':()=>window.qiliaoDesktop.showUpdate(),
  'qq-start':async()=>{if(!window.qiliaoDesktop)throw new Error('请双击Unusual.exe，从独立软件窗口连接 QQ。');if(!await saveConfig({quiet:true}))return;await window.qiliaoDesktop.startQQ();S.config=await request('/api/config');await refreshQQ();toast('QQ 组件正在启动，二维码会显示在此处。');},
  'qq-unbind':async()=>{if(!window.qiliaoDesktop?.unbindQQ)throw new Error('请彻底退出并打开新版 Unusual 后使用解绑');if(!await ask({title:'解绑当前 QQ？',description:'清除本软件保存的 QQ 登录状态，下次连接需要重新扫码。NapCat 群将暂停；人设、聊天记录和官方机器人连接保留。',confirm:'解绑并清除登录',danger:true}))return;if(!await saveConfig({quiet:true}))return;await window.qiliaoDesktop.unbindQQ();S.config=await request('/api/config');S.dirty=false;await refreshQQ();await refreshStatus();renderPage();toast('已解绑，点击连接 QQ 可扫码另一个账号。');},
  'reset-group-context':async el=>{if(!await saveConfig({quiet:true}))return;await request('/api/context/reset',{method:'POST',body:{groupId:el.dataset.id}});toast('已重新应用人设；下一次回复从新上下文开始，历史记录保留。');},
  'reset-preview':async()=>{if(S.previewBusy)throw new Error('请等当前回复完成后再重新应用');if(!await saveConfig({quiet:true}))return;S.chat=[];S.previewSession=crypto.randomUUID();renderPage();toast('提示词已重新应用；请发送一条消息开始新对话。');},
  'official-connect':async()=>{if(!await saveConfig({quiet:true}))return;await request('/api/official/connect',{method:'POST',body:{}});S.config=await request('/api/config');await refreshOfficial();toast('正在连接官方机器人，不需要扫码个人 QQ。');},
  'official-stop':async()=>{if(!await saveConfig({quiet:true}))return;await request('/api/official/disconnect',{method:'POST',body:{}});S.config=await request('/api/config');await refreshOfficial();},
  'official-refresh':refreshOfficial,
  'official-add-group':async el=>{const remote=(S.official?.groups||[]).find(g=>g.id===el.dataset.id);if(!remote||remote.removed)throw new Error('官方机器人已不在该群');if(!S.config.groups.some(g=>g.id===remote.id)){S.config.groups.push({...newGroup(remote.id,remote.name),channel:'official'});markDirty();}S.groupId=remote.id;await navigate('groups');toast('已添加官方群，请设置人设、启用本群并保存。');},
  'qq-stop':async()=>{if(!window.qiliaoDesktop)return;await window.qiliaoDesktop.stopQQ();await refreshQQ();toast('QQ 连接已停止。');},
  'qq-refresh':async()=>{await request('/api/qq/refresh',{method:'POST',body:{}});await refreshQQ();},
  'qq-state':refreshQQ,
  'qq-groups':chooseGroups,
  'setup-save':async()=>{const p=S.config.providers.find(p=>p.id===S.config.defaultProviderId);p.enabled=true;markDirty();if(await saveConfig()){await refreshStatus();toast('模型设置已保存。可以先到对话预览试聊。');}},
  'budget-economy':()=>applyBudget(2200,160,8),
  'budget-balanced':()=>applyBudget(3500,300,18),
  'copy-guide-url':el=>clipboard(el.dataset.url),

  save:async()=>{if(await saveConfig()){await refreshStatus();}},
  navigate:async el=>navigate(el.dataset.target),
  'select-group':async el=>{S.groupId=el.dataset.id;renderPage();await loadBudgetEstimate();},'select-persona':async el=>{S.personaId=el.dataset.id;renderPage();await loadLearning();await loadPersonality();},'select-provider':async el=>{S.providerId=el.dataset.id;renderPage();await loadProviderModels();},
  'personality-save':savePersonality,'personality-refresh':async()=>{
    const id=S.personaId;
    if(PersonalityUI.drafts.has(id)){
      const answer=await ask({title:'刷新可变人格',description:'刷新会放弃此处未保存的编辑，读取最新记忆。',confirm:'放弃编辑并刷新'});
      if(!answer)return;
      PersonalityUI.drafts.delete(id);
    }
    await loadPersonality();
  },'learning-save':saveLearning,'learning-refresh':async()=>{if(LearningUI.drafts.has(S.personaId)){const answer=await ask({title:'刷新可变人设',description:'刷新会放弃此处未保存的编辑，读取最新学习结果。',confirm:'放弃编辑并刷新'});if(!answer)return;LearningUI.drafts.delete(S.personaId);}await loadLearning();},'learning-undo':async()=>{const state=LearningUI.values.get(S.personaId);const last=state?.history?.at(-1);if(!last)throw Error('暂无可恢复的上一版');LearningUI.drafts.set(S.personaId,{text:last.text,enabled:last.enabled,revision:state.revision});renderPage();toast('已载入上一版，点击保存可变人设后生效');},
  'message-trace':async el=>{const id=el.dataset.id,data=await request('/api/messages/trace?id='+encodeURIComponent(id));await ask({title:'消息处理过程',description:'只记录新版启用后的消息。合并消息会关联主请求；可刷新查看最新结果。',fields:button('刷新处理过程','trace-refresh','refresh','secondary','data-id="'+id+'"')+'<div id="trace-details">'+traceDetails(data)+'</div>',confirm:'关闭'});},
  'trace-refresh':async el=>{const data=await request('/api/messages/trace?id='+encodeURIComponent(el.dataset.id));const box=$('#trace-details');if(box)box.innerHTML=traceDetails(data);},
  'backups-refresh':loadBackups,'backup-create':async()=>{if(!await saveConfig({quiet:true}))return;toast('正在备份配置、数据库和媒体，请稍候…');await request('/api/backups',{method:'POST',body:{}});await loadBackups();toast('备份已保存到软件目录 backups/data');},'backup-verify':async el=>{await request('/api/backups/verify',{method:'POST',body:{id:el.dataset.id}});toast('文件校验和数据库完整性检查通过');},'backup-restore':async el=>{const answer=await ask({title:'安排恢复备份',description:'下次启动时替换当前配置、聊天记录、记忆和媒体；届时会先自动备份当前数据。恢复后自动聊天暂停，需要你检查后开启。QQ 登录缓存不恢复。',confirm:'确认下次启动恢复'});if(!answer)return;await request('/api/backups/restore',{method:'POST',body:{id:el.dataset.id,confirm:'RESTORE'}});await loadBackups();toast('已安排恢复，请用退出按钮关闭，再双击 Unusual 启动');},'backup-cancel':async()=>{await request('/api/backups/restore',{method:'DELETE',body:{}});await loadBackups();},
  'add-friend':addFriend,'context-refresh':loadContexts,'context-new':async()=>{if(!ContextUI.id)return;await request('/api/context/reset',{method:'POST',body:{groupId:ContextUI.id}});await loadContexts();},'context-history':()=>{S.historyGroup=ContextUI.id;return navigate('history');},'memory-add':()=>editMemory(),'memory-edit':el=>editMemory(ContextUI.data.memories.find(m=>m.id===el.dataset.id)),'memory-delete':async el=>{await request('/api/memories',{method:'DELETE',body:{id:el.dataset.id}});await loadContexts();},
  'add-group':addGroup,'add-persona':addPersona,'add-provider':addProvider,
  'delete-group':()=>removeEntity('group'),'delete-persona':()=>removeEntity('persona'),'delete-provider':()=>removeEntity('provider'),
  'duplicate-persona':()=>{const current=S.config.personas.find(p=>p.id===S.personaId);const copy={...current,id:id('persona'),name:`${current.name} · 副本`};S.config.personas.push(copy);S.personaId=copy.id;markDirty();renderPage();},
  'test-bridge':()=>bridgeTest(false),'import-groups':()=>bridgeTest(true),
  'test-provider':async el=>{if(await saveConfig({quiet:true})){S.previewProvider=el.dataset.id;await navigate('preview');}},
  'preview-send':sendPreview,
  'new-chat':async()=>{if(S.previewBusy)throw new Error('请等当前回复完成后再新建会话。');S.chat=[];S.previewSession=crypto.randomUUID();S.previewDraft='';renderPage();toast('已创建新的独立会话，旧记录仍可在聊天记录中查看。');},
  'manual-mentions':async el=>{
    const groupId=el.dataset.id;
    if(!await saveConfig({quiet:true}))return;
    const {members}=await request('/api/qq/group-members?groupId='+encodeURIComponent(groupId));
    if(S.page!=='groups'||S.groupId!==groupId)return;
    const selected=(manualMentionDrafts.get(groupId)||[]).map(x=>x.user_id);
    const picked=await pickMentionTargets(members,selected,{title:'选择群成员',description:'从当前群读取名单，勾选需要 @ 的人。'});
    if(!picked)return;
    if(picked.length)manualMentionDrafts.set(groupId,picked);else manualMentionDrafts.delete(groupId);
    if(S.groupId===groupId&&$('#manual-mentions-label'))$('#manual-mentions-label').textContent=picked.map(x=>x.name).join('、')||'未选择';
  },
  'clear-manual-mentions':el=>{
    manualMentionDrafts.delete(el.dataset.id);
    $('#manual-mentions-label').textContent='未选择';
  },
  'manual-send':async el=>{
    const groupId=el.dataset.id, field=$('#manual-message'), text=field.value.trim(), voice=$('#manual-voice').checked;
    const emoji=$('#manual-emoji').value||undefined, picked=manualMentionDrafts.get(groupId);
    const mentions=(picked||[]).map(x=>x.user_id);
    if(!text&&!emoji&&!mentions.length)throw new Error('请填写消息、选择表情或勾选艾特对象。');
    if(voice&&mentions.length)throw new Error('语音消息不能同时艾特成员，请取消语音或清空艾特。');
    if(!await saveConfig({quiet:true}))return;
    await request('/api/send',{method:'POST',body:{groupId,text,voice,emoji,mentions}});
    if(manualMentionDrafts.get(groupId)===picked){
      manualMentionDrafts.delete(groupId);
      if(S.groupId===groupId&&$('#manual-mentions-label'))$('#manual-mentions-label').textContent='未选择';
    }
    if(field.value.trim()===text)field.value='';
    toast('消息已发送到 QQ');await refreshStatus();
  },
  proactive:async el=>{if(!await saveConfig({quiet:true}))return;const result=await ask({title:'现在发起一次群聊？',description:`将使用本群人设生成内容，并真实发送至「${groupName(el.dataset.id)}」。`,confirm:'生成并发送'});if(!result)return;const response=await request('/api/proactive',{method:'POST',body:{groupId:el.dataset.id}});if(response?.skipped||response?.sent===false)toast(response.reason||'当前策略不允许发送，请检查开关与冷却。',true);else toast('主动消息已发送');await refreshStatus();},
  'history-refresh':()=>loadHistory(),
  'history-search':()=>{S.historyQuery=$('#history-query').value.trim();S.historyGroup=$('#history-group').value.trim();for(const key of Object.keys(HistoryFilters))HistoryFilters[key]=$('#history-'+key)?.value||'';return loadHistory();},
  'history-more':()=>loadHistory(true),
  'history-delete':async()=>{if(!S.selectedMessages.size)throw new Error('请先选择要删除的记录。');if(!await ask({title:`删除 ${S.selectedMessages.size} 条记录？`,description:'此操作无法恢复，同时会从后续对话上下文中移除这些记录。',confirm:'删除记录',danger:true}))return;await request('/api/messages',{method:'DELETE',body:{ids:[...S.selectedMessages]}});await loadHistory();await refreshStatus();toast('选中的记录已删除');},
  'history-clear':async()=>{if(!await ask({title:S.historyGroup?'清空当前群 / 会话记录？':'清空所有聊天记录？',description:`${S.historyGroup?`范围：${groupName(S.historyGroup)}。`:'范围：所有群、预览和 API 会话。'}此操作不受关键词、日期、发送者和状态筛选限制，删除后无法恢复。`,confirm:'确认清空',danger:true}))return;await request('/api/messages',{method:'DELETE',body:S.historyGroup?{groupId:S.historyGroup}:{}});await loadHistory();await refreshStatus();toast('记录已清空');},
  'history-export':async()=>{const result=await request('/api/export',{method:'POST',body:S.historyGroup?{groupId:S.historyGroup}:{}});await ask({title:`已导出 ${number(result.count)} 条记录`,description:'文件已保存到软件自己的目录，可以直接在资源管理器中查看。导出范围按群号筛选，不受搜索关键词影响。',fields:`<div class="path">${esc(S.status.root+'\\'+(result.path||'data/exports/'+result.name).replaceAll('/','\\'))}</div>`,confirm:'完成'});},
  'breeze-models':async()=>{if(!await saveConfig({quiet:true}))return;BreezeUI.models=(await request('/api/voice/models/sync',{method:'POST'})).models;renderPage();toast('官方模型列表已更新');},
  'emoji-bundle-yes':async()=>{const r=await request('/api/emoji/bundle',{method:'POST',body:{}});await loadEmoji();toast('已导入 '+r.added+' 张，已有 '+r.existing+' 张');},
  'emoji-bundle-no':()=>{localStorage.setItem('emoji.bundle.declined','1');$('#bundle-prompt').innerHTML=bundlePrompt();},
  'emoji-bundle-show':()=>{localStorage.removeItem('emoji.bundle.declined');$('#bundle-prompt').innerHTML=bundlePrompt();},
  'emoji-refresh':loadEmoji,'emoji-upload':()=>$('#emoji-files').click(),
  'emoji-tags':async el=>{const item=S.emoji[Number(el.dataset.index)],draft=$(`#emoji-tags-${el.dataset.index}`).value,tags=draft.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);await request('/api/emoji',{method:'PUT',body:{name:item.name,tags}});item.tags=tags;if(EmojiUI.drafts.get(item.name)===draft)EmojiUI.drafts.delete(item.name);$('#emoji-grid').innerHTML=emojiGrid();toast('表情标签已保存');},
  'emoji-delete':async el=>{const item=S.emoji[Number(el.dataset.index)];if(!await ask({title:`删除「${item.name}」？`,description:'图片将从本地表情库中移除。',confirm:'删除图片',danger:true}))return;await request('/api/emoji',{method:'DELETE',body:{name:item.name}});EmojiUI.drafts.delete(item.name);await loadEmoji();toast('表情已删除');},
  'breeze-list':async()=>{if(!await saveConfig({quiet:true}))return;toast('正在同步全部音色，可能需要一些时间…');const data=await request('/api/voice/library/sync',{method:'POST',body:{}});applyVoiceLibrary(data);BreezeUI.page=1;updateVoiceResults();toast('音色目录已更新并缓存到本地');},
  'breeze-prev':async()=>{BreezeUI.page=Math.max(1,BreezeUI.page-1);updateVoiceResults();$('#voice-library-results')?.scrollIntoView({block:'start',behavior:'instant'});},
  'breeze-next':async()=>{BreezeUI.page++;updateVoiceResults();$('#voice-library-results')?.scrollIntoView({block:'start',behavior:'instant'});},
  'breeze-category':async el=>{BreezeUI.category=el.dataset.id||null;BreezeUI.page=1;updateVoiceResults();},
  'breeze-favorite':async el=>{const data=await request('/api/voice/library/favorite',{method:'POST',body:{id:el.dataset.id,favorite:!BreezeUI.localFavorites.includes(el.dataset.id)}});applyVoiceLibrary(data);updateVoiceResults();},
  'breeze-pick':async el=>{set('voice.voice',el.dataset.id);renderPage();toast('已选音色，请保存设置或生成试听');},
  'breeze-billing':async()=>{try{const r=await request('/api/voice/billing');voiceBills=r.items;voiceBillsError='';}catch(e){voiceBillsError='积分查询失败：'+e.message;}const box=$('#voice-billing-records');if(box)box.innerHTML=voiceBillingRows();},
  'voice-test':async()=>{const text=$('#voice-text').value.trim();if(!text)throw new Error('请填写试音文本。');if(!await saveConfig({quiet:true}))return;if($('#voice-result'))$('#voice-result').textContent='正在合成语音，请稍候…';const result=await request('/api/voice/test',{method:'POST',body:{text}}).catch(error=>{if($('#voice-result'))$('#voice-result').textContent='合成失败：'+error.message;throw error;});if($('#voice-result'))$('#voice-result').innerHTML=`<audio controls src="${safeUrl(result.url)}" class="audio-preview"></audio><p class="field-help">${esc(result.name)}</p>${S.config.voice.type==='breeze'?'<p class="field-help">本次生成：'+esc(creditText(result.billing))+'</p>':''}`;toast('试听音频已生成');if(S.config.voice.type==='breeze')await actions['breeze-billing']();},
  'copy-webhook-url':()=>clipboard(location.origin+'/onebot/events'),'copy-webhook-token':()=>clipboard(S.config.onebot.webhookToken),'rotate-webhook':()=>rotateToken('webhook'),
  'copy-api-url':()=>clipboard(S.status.apiUrl),'copy-api-token':()=>clipboard(S.config.api.token),'rotate-api':()=>rotateToken('api'),
  'toggle-api-token':el=>{const input=$('#api-token');input.type=input.type==='password'?'text':'password';el.innerHTML=`${icon('eye')}${input.type==='password'?'显示':'隐藏'}`;},
  'copy-api-powershell':()=>clipboard(apiSnippet('powershell',true)),'copy-api-curl':()=>clipboard(apiSnippet('curl',true)),
  'logs-refresh':loadLogs,
  shutdown:async()=>{if(!await ask({title:'停止Unusual本地服务？',description:'群聊与 API 将停止工作。需要时重新双击启动入口即可恢复。未保存的设置会丢失。',confirm:'停止服务',danger:true}))return;if(window.qiliaoDesktop){S.dirty=false;await window.qiliaoDesktop.quit();return;}await request('/api/shutdown',{method:'POST',body:{}});clearInterval(pollTimer);$('#app').innerHTML=`<div class="boot"><div class="brand-mark">✦</div><h1>今天先聊到这里。</h1><p>Unusual已停止。下次见面，双击软件启动入口即可。</p></div>`;},
};

document.addEventListener('click',async event=>{
  const pageButton=event.target.closest('[data-page]');if(pageButton){await navigate(pageButton.dataset.page);return;}
  const el=event.target.closest('[data-action]');if(!el||el.disabled)return;const action=actions[el.dataset.action];if(!action)return;
  const original=el.innerHTML;const shouldBusy=!['select-group','select-persona','select-provider','navigate','toggle-api-token','emoji-upload','duplicate-persona'].includes(el.dataset.action);
  if(shouldBusy){el.disabled=true;el.setAttribute('aria-busy','true');}
  try{await action(el);}catch(error){toast(error.message||'操作失败，请查看运行日志。',true);}finally{if(el.isConnected&&shouldBusy){el.disabled=false;el.removeAttribute('aria-busy');if(el.dataset.action==='save')renderSaveState();}void original;}
});
document.addEventListener('input',event=>{
  const el=event.target;if(el.dataset.bind){let value=el.type==='checkbox'?el.checked:(el.type==='number'||el.type==='range')?Number(el.value):el.value;if(el.dataset.list)value=el.value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);set(el.dataset.bind,el.dataset.percent?value/100:value);if(el.type==='range'&&el.closest('label')?.querySelector('output'))el.closest('label').querySelector('output').textContent=value+'%';}
  if(el.id==='breeze-search'){BreezeUI.search=el.value;BreezeUI.page=1;updateVoiceResults();}
  if(el.id==='preview-message')S.previewDraft=el.value;
  if(el.id==='emoji-search'){EmojiUI.query=el.value;$('#emoji-grid').innerHTML=emojiGrid();}
  if(el.id.startsWith('emoji-tags-')){const item=S.emoji[Number(el.id.slice(11))];if(item)EmojiUI.drafts.set(item.name,el.value);}
});
document.addEventListener('change',async event=>{
  const el=event.target;
  if(el.dataset.bind==='defaultProviderId'&&S.page==='setup')renderPage();
  if(el.id==='variable-persona-enabled')learningDraft();
  if(el.id==='context-session'){ContextUI.id=el.value;await loadContexts();}
  if(el.dataset.crossTarget){const path=el.dataset.configPath+'.'+el.dataset.crossTarget;const values=new Set(get(path)||[]);el.checked?values.add(el.dataset.targetId):values.delete(el.dataset.targetId);set(path,[...values]);}
  if(el.id==='breeze-language'){BreezeUI.language=el.value;BreezeUI.page=1;updateVoiceResults();}
  if(el.id==='breeze-favorites'){BreezeUI.favorites=el.checked;BreezeUI.page=1;updateVoiceResults();}
  if(el.id==='voice-tone'){set('voice.instructions',el.value);renderPage();}
  if(el.dataset.bind==='voice.type'){if(S.config.voice.type==='breeze'){set('voice.model','breeze-tts-2');if(S.config.voice.voice==='alloy')set('voice.voice','');}renderPage();}
  if(el.id==='preview-persona'){S.previewPersona=el.value;S.chat=[];S.previewSession=crypto.randomUUID();toast('已切换人设，后续使用新上下文，历史仍保留。');renderPage();}
  if(el.id==='preview-provider')S.previewProvider=el.value;
  if(el.id==='emoji-untagged'){EmojiUI.untagged=el.checked;$('#emoji-grid').innerHTML=emojiGrid();}
  if(el.id==='preview-search')S.previewSearch=el.checked;
  if(el.dataset.messageId){const messageId=Number(el.dataset.messageId);if(el.checked)S.selectedMessages.add(messageId);else S.selectedMessages.delete(messageId);$('#history-results').innerHTML=historyRows();}
  if(el.id==='history-select-all'){S.messages.forEach(m=>el.checked?S.selectedMessages.add(m.id):S.selectedMessages.delete(m.id));$('#history-results').innerHTML=historyRows();}
  if(el.id==='log-level'){S.logLevel=el.value;$('#logs-list').innerHTML=logRows();}
  if(el.id==='emoji-files'){try{await uploadFiles([...el.files]);}catch(error){toast(error.message,true);}el.value='';}
});
document.addEventListener('keydown',event=>{
  if(event.target.id==='preview-message'&&(event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();sendPreview().catch(error=>toast(error.message,true));}
  if(['history-query','history-group'].includes(event.target.id)&&event.key==='Enter'){event.preventDefault();actions['history-search']().catch(error=>toast(error.message,true));}
});
document.addEventListener('dragover',event=>{const zone=event.target.closest('#emoji-drop');if(zone){event.preventDefault();zone.classList.add('dragover');}});
document.addEventListener('dragleave',event=>{const zone=event.target.closest('#emoji-drop');if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('dragover');});
document.addEventListener('drop',async event=>{const zone=event.target.closest('#emoji-drop');if(!zone)return;event.preventDefault();zone.classList.remove('dragover');try{await uploadFiles([...event.dataTransfer.files]);}catch(error){toast(error.message,true);}});
window.addEventListener('beforeunload',event=>{if(S.dirty||EmojiUI.drafts.size||MemeUI.draft||LearningUI.drafts.size||PersonalityUI.drafts.size){event.preventDefault();event.returnValue='';}});


function applyBudget(input,output,count){Object.assign(S.config.budget,{maxInputTokens:input,maxOutputTokens:output,contextMessages:count});markDirty();renderPage();toast('已应用预设，请保存设置。');}
function qqCard(){return '<section class="panel" id="qq-card">'+qqCardContent()+'</section>';}
function qqCardContent(){
  const connected=S.status.bridge?.connected;
  return panelHead('2 · 连接 QQ','连接另行安装的 OneBot v11 桥接，也可在设置中连接已注册的官方 QQ 机器人。',badge(connected?'连接正常':'尚未连接',connected?'':'gray'))+
    '<div class="form-grid">'+field('OneBot HTTP 地址','onebot.baseUrl')+field('HTTP 访问令牌','onebot.accessToken',{type:'password'})+
    field('事件上报令牌','onebot.webhookToken',{type:'password'})+'</div>'+
    '<p class="field-help">在桥接的 HTTP 客户端中设置 http://127.0.0.1:3210/onebot/events，消息格式选 array，填写相同的上报令牌。登录和启停在桥接软件中操作。</p>'+
    '<div class="toolbar">'+button('保存并测试连接','test-bridge','check','secondary')+
    button('选择聊天的群','import-groups','users','secondary')+'</div>';
}
function setup(){const c=S.config,i=Math.max(0,c.providers.findIndex(p=>p.id===c.defaultProviderId)),p=c.providers[i];return heading('GET STARTED','快速开始','填一个模型密钥，连接 QQ 桥接，再选择你想让它参与的群。')+
  '<section class="panel">'+panelHead('1 · 连接模型','模型按实际调用计费；软件不会在保存时自动消费你的 API。')+'<div class="form-grid">'+field('使用哪个模型接口','defaultProviderId',{options:optionsFor('providers')})+field('API 密钥','providers.'+i+'.apiKey',{type:'password',placeholder:'粘贴你的 API Key'})+'</div><div class="toolbar">'+button('保存模型密钥','setup-save','check','')+button('详细设置 / 更换模型','navigate','cpu','secondary','data-target="providers"')+'</div><p class="field-help">当前模型：'+esc(p.model)+'。如服务商不支持此型号，可在详细设置中修改。</p></section><div class="section-gap">'+qqCard()+'</div><section class="panel section-gap">'+panelHead('3 · 选择群，然后开启聊天')+'<p>QQ 登录成功后，点击「选择聊天的群」勾选目标群。默认自然参与：被 @、提到名字或触发普通消息概率时回应，并遵守冷却和安静时段。</p><div class="toolbar">'+button('选择聊天的群','import-groups','users','')+button('管理回复频率 / 主动发言','navigate','settings','secondary','data-target="groups"')+'</div><p class="field-help">已启用 '+c.groups.filter(g=>g.enabled).length+' 个群 · 自动聊天'+(c.bot.enabled?'已开启':'已暂停')+'。默认北京时间 23:00–08:00 安静，普通消息约 8% 概率回应。</p></section>';}
function guide(){return heading('QUICK GUIDE','使用教程','教程也放在软件目录的 README.md，离线可查看。')+'<section class="panel guide"><h2>第一次使用</h2><ol><li>在「快速开始」选择 DeepSeek 或 Google，粘贴密钥并保存。模型名称可在「模型与 API」调整。</li><li>在外部 OneBot 桥接中完成 QQ 登录，回到「快速开始」填写 HTTP 地址、访问令牌并设置事件上报。</li><li>点击「选择聊天的群」，勾选并启用。用另一个 QQ 在群里提到人设名字或 @ 它，可测试回复；也可在对话预览先试聊。</li></ol><h2>为什么有时不回</h2><p>请检查总开关、该群开关、模型 Key、每日额度、安静时段和冷却。默认普通消息只有约 8% 的概率触发；可以在群设置改成关键词或每条消息都尝试回应。运行日志会记录模型或连接异常。</p><h2>双连接与解绑</h2><p>NapCat 与官方机器人可同时在线。外部桥接的 QQ 登录和退出由桥接软件管理。官方页面填写 AppID/AppSecret 后连接，群被发现后需手动添加并启用。两条连接互不顶替。</p><h2>人设与重新应用</h2><p>每个群可以选择已保存的人设，预览也有独立选择器。切换群人设并保存会开始新上下文；手动重新应用可清除旧上下文影响而保留聊天记录。每次请求都会携带当前提示词，这不是绕过模型限制的开关，也不会自动反复重试消耗额度。</p><h2>人设、记忆与媒体</h2><p>人设可单独创建并分配给群。聊天记录支持按群和关键词查找、删除与导出，导出在 data/exports。删除的记录不再带入上下文。表情上传到 data/emoji；模型按标签选择本地表情；群图片仅从 QQ 图片服务器读取，限制大小和数量。联网搜索和语音需要另配对应接口。</p><h2>节省用量与资源</h2><p>设置中可一键选择「节省」或「均衡」。连续群消息合并请求，普通消息先在本地筛选；相同搜索短时复用，表情候选最多 12 个，按标签匹配并轮换。最小化后界面停止轮询，自动聊天继续。关闭窗口进入托盘，彻底退出请用设置页或右键托盘。</p><h2>连接异常</h2><p>二维码过期点击刷新；QQ 掉线可断开后重新连接。QQ 要求身份验证时，请本人在手机完成。组件退出可查看 data/qq-component.log。端口冲突会明确提示，不会关闭你其他程序。你的账号密码无需填写到软件。</p><h2>资料来源</h2><p>以下是本次集成参考的官方说明，可复制链接查看。</p><div class="toolbar">'+button('NapCat 安装与登录教程','copy-guide-url','copy','secondary','data-url="https://napneko.github.io/guide/boot/Shell"')+button('NapCat 版本说明','copy-guide-url','copy','secondary','data-url="https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41"')+'</div></section>';}
async function refreshQQ(){if(S.qqBusy)return;S.qqBusy=true;try{const [q,d]=await Promise.all([request('/api/qq/status'),window.qiliaoDesktop?window.qiliaoDesktop.status():Promise.resolve(null)]);const changed=JSON.stringify([q,d?.qqRunning,d?.qqError])!==JSON.stringify([S.qq,S.desktop?.qqRunning,S.desktop?.qqError]);S.qq=q;S.desktop=d;if(changed&&$('#qq-card'))$('#qq-card').innerHTML=qqCardContent();if(q.isLogin&&(!S.status.bridge?.connected||S.status.bridge?.stale)){await request('/api/bridge/test',{method:'POST',body:{}});await refreshStatus();}if(changed&&S.page==='setup'&&!S.dirty&&!$('#dialog').open)renderPage();}catch(e){if(S.page==='setup'||S.page==='groups')toast(e.message,true);}finally{S.qqBusy=false;}}
async function chooseGroups(){if(!await saveConfig({quiet:true}))return;const r=await request('/api/bridge/test',{method:'POST',body:{}});const groups=(r.groups||[]).filter(g=>/^[1-9]\d{0,19}$/.test(String(g.group_id)));if(!groups.length)throw new Error('QQ 没有返回群列表，请确认账号已加入群。');const selected=await ask({title:'选择允许自动聊天的群',description:'勾选后点击启用。未选择的群不会新增到配置；已配置的其他群保持原状态。',fields:'<div class="group-picker">'+groups.map(g=>'<label class="checkline"><input type="checkbox" name="g_'+esc(g.group_id)+'"><span>'+esc(g.group_name)+'<small class="muted"> · '+esc(g.group_id)+'</small></span></label>').join('')+'</div>',confirm:'启用选中群自动聊天'});if(!selected)return;const ids=Object.keys(selected).filter(k=>k.startsWith('g_')).map(k=>k.slice(2));if(!ids.length)throw new Error('还没有选择群。');const current=await request('/api/config');S.config=current;for(const gid of ids){let group=S.config.groups.find(g=>g.id===gid);if(!group){const remote=groups.find(g=>String(g.group_id)===gid);group=newGroup(gid,remote.group_name);S.config.groups.push(group);}group.enabled=true;}S.config.bot.enabled=true;if(r.info?.user_id)S.config.bot.selfId=String(r.info.user_id);markDirty();if(await saveConfig()){await refreshStatus();renderPage();toast('已启用选中的群，可到 QQ 群设置调整回复策略。');}}
let pollTimer,pollBusy=false,lastStatusPoll=0;
function startUIPolling(){clearInterval(pollTimer);if(!document.hidden)pollTimer=setInterval(()=>pollUI().catch(()=>{}),6000);}
document.addEventListener('visibilitychange',()=>{startUIPolling();if(!document.hidden&&S.config)pollUI().catch(()=>{});});
async function pollUI(){if(document.hidden||pollBusy)return;pollBusy=true;try{if(['setup','groups'].includes(S.page))await refreshQQ();if(S.page==='official')await refreshOfficial();if(Date.now()-lastStatusPoll>=12000){const before=JSON.stringify(S.status);await refreshStatus();lastStatusPoll=Date.now();if(S.page==='overview'&&before!==JSON.stringify(S.status)&&!S.dirty&&!S.saving&&!$('#dialog').open)renderPage();}}finally{pollBusy=false;}}

async function boot(){
  try{const params=new URLSearchParams(location.hash.replace(/^#/,'')),key=params.get('key');if(location.hash)window.history.replaceState(null,'',location.pathname+location.search);if(key)await request('/api/session',{method:'POST',body:{token:key}});const results=await Promise.all([request('/api/config'),request('/api/status')]);[S.config,S.status]=results;if(!S.status.setup.providerReady||!S.status.setup.groupsReady)S.page='setup';shell();await refreshQQ();startUIPolling();}catch(error){$('#app').innerHTML=`<div class="boot"><div class="panel"><div class="brand-mark">✦</div><h1>${error.status===401?'从启动入口见面吧。':'暂时没有连接上Unusual。'}</h1><p>${esc(error.message)}</p><p>请回到软件文件夹，双击启动入口。软件会自动打开具有本地管理权限的窗口。</p><button class="button" id="retry-boot">重新连接</button></div></div>`;$('#retry-boot').onclick=boot;}
}
boot();

function officialPage(){const q=S.official||S.status.official||{},c=S.config.official||{};return heading('OFFICIAL QQ BOT','QQ 官方机器人','独立机器人身份，与 NapCat 同时运行；每个群分别选择人设和回复策略。')+
'<section class="panel">'+panelHead('1 · 创建与连接','在 QQ 开放平台创建机器人，AI 服务选择稍后连接；事件回调选择 WebSocket。')+'<p><a href="https://q.qq.com/" target="_blank" rel="noreferrer">打开 QQ 开放平台</a> · <a href="https://bot.q.qq.com/wiki/" target="_blank" rel="noreferrer">官方创建教程</a></p><div class="form-grid">'+field('AppID','official.appId',{placeholder:'机器人 AppID，不是 QQ 群号'})+field('AppSecret','official.appSecret',{type:'password',placeholder:'仅保存在本软件目录'})+'</div>'+toggle('保持官方连接，启动软件时自动连接','official.enabled','与 NapCat 的连接开关独立；群自动回复还需开启总开关和该群开关。')+'<div class="toolbar">'+button('保存并连接','official-connect','power','')+button('断开官方连接','official-stop','power','secondary')+button('刷新状态与群','official-refresh','refresh','secondary')+'</div></section><section class="panel section-gap" id="official-state">'+officialState()+'</section><section class="panel section-gap">'+panelHead('群权限与使用方法')+'<ol><li>把官方机器人添加到目标 QQ 群。未认证账号通常只能添加自己是群主或管理员的群。</li><li>群内开启“接收所有消息”后，普通消息也会推送；否则只收到 @ 消息。</li><li>在群里发送一条消息后，点击刷新，把发现的群添加到软件并启用。</li><li>主动发言需要群内允许机器人主动消息，且受平台权限与频控限制。</li></ol><p>官方使用群 OpenID，软件自动识别，不需要把数字群号换算。表情和语音直接上传本地数据，当前官方通道单文件上限 5 MB。若两个身份都在同一群，请在忽略用户列表加入另一机器人的账号，避免互相接话。</p></section>';}
function officialState(){const q=S.official||S.status.official||{},names={stopped:'已断开',connecting:'正在连接',reconnecting:'正在重连',ready:'已连接',error:'连接失败'};return panelHead('2 · 状态与发现的群','接收到入群事件或群消息后显示；不会自动启用新群。',badge(names[q.phase]||'未连接',q.connected?'':'gray'))+(q.error?notice(q.error):'')+'<div class="status-row"><span>机器人</span><span>'+esc(q.identity?.name||'等待连接')+'</span></div><div class="status-row"><span>最近收到群消息</span><span>'+esc(time(q.lastEventAt))+'</span></div>'+(q.groups?.length?'<div class="section-gap">'+q.groups.map(g=>'<div class="status-row"><span>'+esc(g.name)+'<small class="muted"> · '+esc(g.remoteId)+'</small></span>'+button(g.removed?'已退出该群':S.config.groups.some(x=>x.id===g.id)?'管理该群':'添加到群管理','official-add-group','users','secondary small','data-id="'+esc(g.id)+'" '+(g.removed?'disabled':''))+'</div>').join('')+'</div>':'<p class="field-help">还没有发现群。先连接官方机器人，把它添加进群，再从群里发送一条消息。</p>');}
async function refreshOfficial(){S.official=await request('/api/official/status');if($('#official-state'))$('#official-state').innerHTML=officialState();}

const LearningUI={values:new Map(),drafts:new Map()};

function variablePersona(id) {
  const state=LearningUI.values.get(id), draft=LearningUI.drafts.get(id), value=draft||state;
  const notes=sourceParagraphs(value?.text,state?.sources,state?.text);
  return '<section class="field wide plastic-section" id="variable-persona"><span>可变人设</span>'+
    '<details class="memory-editor" open><summary>手动编辑人设</summary>'+
    '<div class="memory-document">'+
    '<label class="field"><textarea id="variable-persona-text" aria-label="可变人设正文" rows="7" maxlength="2000" placeholder="在此编辑聊天中学到的表达方式、梗和说话习惯…">'+esc(value?.text||'')+'</textarea></label>'+
    notes+'</div></details>'+
    '<label class="checkline"><input id="variable-persona-enabled" type="checkbox" '+(value?.enabled!==false?'checked':'')+'>允许模型自动学习和修改</label>'+
    '<small>表达习惯由使用此人设的会话共享。最多 2000 字。关闭学习后仍会使用已保存的内容。</small>'+
    '<small>'+(state?'版本 '+state.revision+' · '+(state.updatedAt?esc(time(state.updatedAt)):'尚未学习'):'点击刷新读取，或先保存新建人设')+'</small>'+
    '<div class="toolbar">'+button('保存可变人设','learning-save','save','secondary')+button('刷新','learning-refresh','refresh','ghost')+button('恢复上一版','learning-undo','refresh','ghost')+'</div></section>';
}
async function loadLearning(){const id=S.personaId;if(!S.config.personas.some(p=>p.id===id))return;LearningUI.values.set(id,await request('/api/persona-learning?id='+encodeURIComponent(id)));if(S.page==='personas')renderPage();}
function learningDraft(){const id=S.personaId,old=LearningUI.drafts.get(id)||LearningUI.values.get(id);if(!old)return;LearningUI.drafts.set(id,{text:$('#variable-persona-text').value,enabled:$('#variable-persona-enabled').checked,revision:old.revision});}
async function saveLearning(){const id=S.personaId;learningDraft();const draft=LearningUI.drafts.get(id);if(!draft)throw Error('请先保存人设，再刷新可变人设');try{const value=await request('/api/persona-learning',{method:'PUT',body:{id,...draft}});LearningUI.values.set(id,value);LearningUI.drafts.delete(id);renderPage();toast('可变人设已保存，所有使用此人设的会话下次请求生效');}catch(e){await loadLearning();throw e;}}

document.addEventListener('input',e=>{if(e.target.id==='variable-persona-text')learningDraft();});

let BackupUI={items:[],pending:null,last:null};
async function loadBackups(){BackupUI=await request('/api/backups');if(S.page==='backups')renderPage();}
function backupPage(){return heading('LOCAL DATA BACKUP','备份与恢复','保存配置、聊天数据库、人设记忆、收藏、表情和生成音频。备份包含密钥，仅留在本机，不用于公开分享。',button('创建完整数据备份','backup-create','plus','')+button('刷新','backups-refresh','refresh','secondary'))+'<section class="panel">'+(BackupUI.pending?notice('已安排恢复：'+BackupUI.pending.id+'。请退出并重新启动；可在重启前取消。')+button('取消恢复计划','backup-cancel','close','secondary'):'')+(BackupUI.last?'<p>'+esc(BackupUI.last.detail)+'</p>':'')+'<p class="field-help">QQ 登录缓存、程序运行环境和代码不在此备份内。代码由 Git 单独管理。备份位于 backups/data；同盘备份不能抵御硬盘损坏，可自行另存到外置硬盘。备份最多 2 GB，不会自动删除旧备份。</p>'+BackupUI.items.map(item=>'<article class="panel section-gap"><strong>'+esc(time(item.createdAt))+'</strong><p>'+esc(item.version)+' · '+number(item.files)+' 个文件 · '+(item.bytes/1048576).toFixed(1)+' MB · '+esc(item.reason==='before-restore'?'恢复前自动备份':'手动备份')+'</p><small>'+esc(item.id)+'</small><div class="toolbar">'+button('校验','backup-verify','check','secondary','data-id="'+item.id+'"')+button('恢复','backup-restore','refresh','secondary','data-id="'+item.id+'"')+'</div></article>').join('')+'</section>';}

function traceDetails(data){const names={voice_tone:'实际语气与来源',meme_lookup:'梗库预查结果',meme_tool:'模型自主查梗',meme_skipped:'梗库预算不足',received:'收到消息',skipped:'未触发回复',queued:'等待处理',merged:'已合并',cancelled:'已取消',processing:'开始处理',model_request:'请求模型',model_result:'模型完成',image_failed:'图片下载失败',image_skipped:'未携带图片',voice_request:'合成语音',voice_ready:'语音就绪',voice_fallback:'语音失败转文字',qq_sending:'发送 QQ',sent:'发送成功',failed:'处理失败'};const rows=items=>items.map(x=>'<article class="panel section-gap"><strong>'+esc(names[x.stage]||x.stage)+'</strong><small> · '+esc(time(x.createdAt))+'</small><p>'+esc(replyReasons[x.detail]||x.detail)+'</p></article>').join('');return (data.elapsedMs!==null?'<p>已记录过程跨度：'+(data.elapsedMs/1000).toFixed(1)+' 秒（包含排队等待）</p>':'')+(data.items.length?rows(data.items):'<p>没有保留这条消息的处理过程。</p>')+(data.related||[]).map(x=>'<h3>关联主请求 · '+esc(x.messageId)+'</h3>'+rows(x.items)).join('');}

// These views use local data only. Avoid a polling query while the page is hidden.
let ActivityUI={days:7,data:null,request:0};
let HistoryFilters={senderId:'',source:'',status:'',from:'',to:''},historyRequest=0;
function historyFilters(){const select=(key,label,items)=>'<label class="field"><span>'+label+'</span><select id="history-'+key+'"><option value="">全部</option>'+items.map(([v,t])=>'<option value="'+v+'" '+(HistoryFilters[key]===v?'selected':'')+'>'+t+'</option>').join('')+'</select></label>';return '<details class="section-gap history-advanced"><summary>精确筛选 · 发送者、来源、状态与日期</summary><div class="form-grid section-gap"><label class="field"><span>发送者 QQ 号（精确匹配）</span><input id="history-senderId" value="'+esc(HistoryFilters.senderId)+'" placeholder="例如 123456"></label>'+select('source','消息来源',[['qq','QQ 群聊 / 私聊'],['preview','对话预览'],['api','对外 API'],['manual','手动发送']])+select('status','消息状态',[['received','已接收'],['sent','已发送'],['failed','发送失败'],['generated','已生成']])+['from','to'].map(key=>'<label class="field"><span>'+(key==='from'?'开始日期':'结束日期')+'（北京时间）</span><input type="date" id="history-'+key+'" value="'+esc(HistoryFilters[key])+'"></label>').join('')+'</div><div class="toolbar section-gap">'+button('应用筛选','history-search','search','secondary')+button('重置筛选','history-reset-filters','refresh','ghost')+'</div></details>';}
async function loadActivity(){const seq=++ActivityUI.request;const [data]=await Promise.all([request('/api/activity?days='+ActivityUI.days),refreshStatus()]);if(seq!==ActivityUI.request)return;ActivityUI.data=data;if(S.page==='activity')renderPage();}
function activityPage(){
 const d=ActivityUI.data;
 const top=heading('LOCAL ACTIVITY','运行与用量','本地统计，不额外调用模型。按北京时间汇总；Token 不等于金额，语音积分请到语音页面查看。',button('刷新统计','activity-refresh','refresh','secondary'));
 const choices='<div class="toolbar section-gap usage-range">'+[[1,'今天'],[7,'近 7 天'],[30,'近 30 天']].map(([n,t])=>button(t,'activity-days','clock',ActivityUI.days===n?'':'secondary','data-days="'+n+'"')).join('')+'</div>';
 if(!d)return top+choices+empty('正在加载本地统计','稍后也可点击刷新。','clock');
 const total=d.total.inputTokens+d.total.outputTokens,max=Math.max(1,...d.daily.map(x=>x.inputTokens+x.outputTokens));
 const stats='<div class="metric-grid">'+metric('模型 Token',total,'bolt',number(d.total.inputTokens)+' 输入 · '+number(d.total.outputTokens)+' 输出')+metric('模型调用',d.total.calls,'cpu',number(d.total.estimatedCalls)+' 次用量为估算')+metric('QQ 确认发送',d.traceStages.find(x=>x.stage==='sent')?.count||0,'send','诊断记录内的发送次数')+metric('处理失败',d.traceStages.find(x=>x.stage==='failed')?.count||0,'info','不包含概率跳过和正常冷却')+'</div>';
 const trend='<section class="panel section-gap">'+panelHead('每日 Token 趋势',d.fromDay+' 至 '+d.toDay+' · '+time(d.generatedAt)+' 更新')+'<div class="usage-chart" role="img" aria-label="每日 Token 用量柱状图">'+d.daily.map(x=>{const n=x.inputTokens+x.outputTokens;return '<div class="usage-day" title="'+esc(x.day+'：'+number(n)+' Token / '+x.calls+' 次调用')+'"><div class="usage-bar-track"><div class="usage-bar" style="height:'+Math.round(n/max*100)+'%"></div></div><small>'+x.day.slice(5)+'</small><span>'+number(n)+'</span></div>';}).join('')+'</div><p class="field-help">空白日期为 0 次调用；图表无需联网。鼠标停留可查看日期、Token 与调用次数。</p></section>';
 const table=(title,rows,label)=>'<section class="panel section-gap">'+panelHead(title)+'<div class="table-wrap"><table><thead><tr><th>名称</th><th>调用次数</th><th>输入 Token</th><th>输出 Token</th><th>估算调用</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(label(r))+'</td><td>'+number(r.calls)+'</td><td>'+number(r.inputTokens)+'</td><td>'+number(r.outputTokens)+'</td><td>'+number(r.estimatedCalls)+'</td></tr>').join('')+'</tbody></table></div>'+(!rows.length?'<p class="muted">此范围没有模型调用。</p>':'')+'</section>';
 const sessions=table('各会话用量',d.bySession,r=>groupName(r.groupId)||'未指定会话');const providers=table('各接口用量',d.byProvider,r=>S.config.providers.find(p=>p.id===r.providerId)?.name||r.providerId||'未指定接口');
 const names={failed:'处理失败',voice_fallback:'语音失败转文字',image_failed:'图片读取失败',image_skipped:'图片未附上',cancelled:'等待超时'};
 const issues='<section class="panel section-gap">'+panelHead('近期需要留意的消息','最多显示所选时间内的 30 条异常。失败与媒体降级分开显示；不会自动重发 QQ 消息。')+(d.issues.length?d.issues.map(x=>'<article class="activity-issue"><div><strong>'+esc(names[x.stage]||x.stage)+'</strong><small>'+esc(groupName(x.groupId))+' · '+esc(time(x.createdAt))+'</small><p>'+esc(replyReasons[x.detail]||x.detail)+'</p></div>'+(x.historyId?button('查看处理过程','message-trace','info','secondary small','data-id="'+x.historyId+'"'):'<small>原记录已清理</small>')+'</article>').join(''):empty('此范围暂无异常记录','这表示留存的诊断中没有相关异常，并不代表所有消息都应回复。','check'))+'</section>';
 return top+choices+stats+trend+'<div class="columns">'+sessions+providers+'</div>'+issues+'<p class="field-help">诊断仅保留最近约一万条处理阶段，历史清理会影响诊断统计。合并消息按实际发送次数统计，不将未触发的普通消息算作失败。模型用量单独保留，删除聊天记录不会扣减已发生的用量。</p>';
}
actions['activity-refresh']=loadActivity;
actions['activity-days']=el=>{ActivityUI.days=Number(el.dataset.days);return loadActivity();};
actions['history-reset-filters']=async()=>{for(const key of Object.keys(HistoryFilters))HistoryFilters[key]='';S.historyQuery='';S.historyGroup='';renderPage();await loadHistory();};

const EmojiUI={query:'',untagged:false,drafts:new Map()};
function emojiFilters(){return '<div class="toolbar section-gap"><div class="search-wrap grow">'+icon('search')+'<input id="emoji-search" value="'+esc(EmojiUI.query)+'" placeholder="搜索文件名或标签，可用空格组合关键词" aria-label="搜索表情包"></div><label class="checkline"><input type="checkbox" id="emoji-untagged" '+(EmojiUI.untagged?'checked':'')+'>只看未标注</label>'+button('清除筛选','emoji-clear-search','refresh','ghost')+'</div>';}
actions['emoji-clear-search']=()=>{EmojiUI.query='';EmojiUI.untagged=false;renderPage();};

// Native MemeWiki page; its settings are saved independently of model/persona config.
const MemeUI={state:null,items:[],total:0,q:'',offset:0,sequence:0,draft:null,update:null};
const memeLevel=n=>n<=20?'很低 · 尊重，不接黑称':n<=45?'偏低 · 损操作，不损长相':n<=70?'中等 · 跟着社区玩':'很高 · 放开玩梗，不编造攻击';
async function loadMeme(offset=MemeUI.offset){const seq=++MemeUI.sequence;const [state,list]=await Promise.all([request('/api/memewiki/state'),request('/api/memewiki/list?'+new URLSearchParams({q:MemeUI.q,offset,limit:40}))]);if(seq!==MemeUI.sequence)return;Object.assign(MemeUI,{state,items:list.items,total:list.total,offset:list.offset});if(S.page==='memewiki')renderPage();}
function memePage(){const st=MemeUI.state,c=MemeUI.draft||st?.config;if(!st)return heading('MEME WIKI','梗百科','正在读取本地词库…');const check=(key,title,help)=>'<label class="checkline section-gap"><input type="checkbox" data-meme-setting="'+key+'" '+(c[key]?'checked':'')+'>'+title+'</label><p class="field-help">'+help+'</p>';const pager=()=>'<div class="toolbar section-gap">'+button('上一页','meme-prev','arrow','secondary',MemeUI.offset===0?'disabled':'')+'<span>'+ (Math.floor(MemeUI.offset/40)+1)+' / '+Math.max(1,Math.ceil(MemeUI.total/40))+' 页 · '+number(MemeUI.total)+' 条匹配</span>'+button('下一页','meme-next','arrow','secondary',MemeUI.offset+40>=MemeUI.total?'disabled':'')+'</div>';
 return heading('MEME WIKI · LOCAL DICTIONARY','梗百科','移植自 dsh-memewiki '+(st.seed?.version||'0.1.2')+' · 完整内置 6,668 条 · 当前本地 '+number(st.total)+' 条。词典查询离线完成。',button('新建词条','meme-new','plus','')+button('检查上游更新','meme-update','refresh','secondary'))+
 '<section class="panel">'+panelHead('接梗方式','对群聊、好友私聊、预览和对外 API 生效；仍遵守会话回复开关和 Token 预算。')+check('enabled','启用梗百科','关闭后停止自动注入和模型查梗，本地搜索与编辑仍可使用。')+check('autoThink','自动思考梗','按原插件的问梗句式、裸词和停用词规则预查，命中才注入一条；不是在后台持续调用模型。')+check('modelLookup','允许模型自主查梗','自动预查未命中时，模型可主动调用只读词典。每轮最多查询一次；选择查询会多一次模型请求，两次用量均计入预算。接口需要支持工具调用，不兼容时可关闭此项，保留自动预查。')+check('roastEnabled','串子程度 · 手动接管','关闭时不加尺度指令；开启后在使用词条时应用下面的四档规则。')+'<label class="field"><span>串子程度 <output id="meme-level">'+c.roastLevel+' / 100 · '+memeLevel(c.roastLevel)+'</output></span><input type="range" min="0" max="100" step="1" value="'+c.roastLevel+'" data-meme-setting="roastLevel"></label><label class="field"><span>每次词条注入字节上限</span><input type="number" min="400" max="6000" step="100" value="'+c.maxBytes+'" data-meme-setting="maxBytes"><small>默认 2200 UTF-8 字节，约数百个中文字；同时服从单次输入预算。不会把整库送给模型。</small></label><div class="toolbar section-gap">'+button('保存梗百科设置','meme-save-config','check','')+'<span id="meme-dirty" class="muted">'+(MemeUI.draft?'有未保存的插件设置':'插件设置独立保存，不使用右上角的全局保存')+'</span></div></section>'+
 (MemeUI.update?notice(MemeUI.update):'')+'<section class="panel section-gap" id="meme-library">'+panelHead('本地词库','搜索标题、标签、摘要、别名或 slug。修改下一轮生效；词条与开关随完整数据备份保存。')+'<div class="toolbar"><div class="grow search-wrap">'+icon('search')+'<input id="meme-query" value="'+esc(MemeUI.q)+'" placeholder="搜索梗，例如：码头、康神、48" aria-label="搜索梗库"></div>'+button('搜索','meme-search','search','')+button('测试自动识别','meme-probe','info','secondary')+'</div>'+pager()+'<div class="meme-list">'+(MemeUI.items.length?MemeUI.items.map((r,i)=>'<article class="activity-issue"><div class="meme-copy"><strong>'+esc(r.title)+'</strong><small>'+esc(r.tags||r.aliases||'无标签')+'</small><p>'+esc(r.summary||'点击查看完整词条与用法')+'</p></div><div class="inline-actions">'+button('查看 / 编辑','meme-edit','edit','secondary small','data-index="'+i+'"')+button('删除','meme-delete','trash','ghost small','data-index="'+i+'"')+'</div></article>').join(''):empty('没有找到匹配词条','可以换个关键词，或新建一个词条。','search'))+'</div>'+pager()+'</section><p class="field-help">上游代码采用 MIT 许可；词库来自原项目与 cnmeme.wiki。查询不联网；仅点击“检查上游更新”时读取 GitHub 版本号，不自动下载或覆盖本地修改。</p>';
}
async function editMeme(title){const row=title?(await request('/api/memewiki/get?title='+encodeURIComponent(title))).item:{};const labels={title:'标题',aliases:'别名（逗号分隔）',tags:'标签',slug:'slug / 拼音',usage:'怎么用 / 怎么接',summary:'摘要',origin:'出处',other:'其他资料'};const fields=Object.entries(labels).map(([key,label])=>'<label class="field"><span>'+label+'</span>'+(['usage','summary','origin','other'].includes(key)?'<textarea name="'+key+'" rows="4" maxlength="20000">'+esc(row[key]||'')+'</textarea>':'<input name="'+key+'" value="'+esc(row[key]||'')+'" maxlength="'+(key==='title'?120:2000)+'" '+(key==='title'&&title?'readonly':'')+'>')+'</label>').join('');const data=await ask({title:title?'查看 / 编辑梗词条':'新建梗词条',description:'词条内容是聊天参考资料，不能授予模型电脑操作权限。',fields,confirm:'保存词条'});if(!data)return;await request('/api/memewiki/save',{method:'POST',body:{...data,isNew:!title}});await loadMeme();toast('词条已保存，下轮查询立即生效');}
actions['meme-new']=()=>editMeme();
actions['meme-edit']=el=>editMeme(MemeUI.items[Number(el.dataset.index)].title);
actions['meme-delete']=async el=>{const title=MemeUI.items[Number(el.dataset.index)].title;if(!await ask({title:'删除词条「'+title+'」？',description:'会从本地词库移除。升级不会重新导入已删词条；可通过此前的完整数据备份恢复。',confirm:'删除词条',danger:true}))return;await request('/api/memewiki/delete',{method:'POST',body:{title}});await loadMeme(Math.max(0,MemeUI.items.length===1?MemeUI.offset-40:MemeUI.offset));};
actions['meme-search']=()=>{MemeUI.q=$('#meme-query').value.trim();return loadMeme(0);};
actions['meme-prev']=async()=>{await loadMeme(Math.max(0,MemeUI.offset-40));$('#meme-library')?.scrollIntoView({block:'start'});};
actions['meme-next']=async()=>{await loadMeme(MemeUI.offset+40);$('#meme-library')?.scrollIntoView({block:'start'});};
actions['meme-save-config']=async()=>{const draft=structuredClone(MemeUI.draft||MemeUI.state.config);MemeUI.state=await request('/api/memewiki/config',{method:'POST',body:draft});if(JSON.stringify(MemeUI.draft||draft)===JSON.stringify(draft))MemeUI.draft=null;if(S.page==='memewiki')renderPage();toast('梗百科设置已保存');};
actions['meme-update']=async()=>{const d=await request('/api/memewiki/check-update',{method:'POST',body:{}});MemeUI.update=d.newer?'上游有新版 '+d.latest+'；当前移植基于 '+d.current+'。更新需要适配，不会自动覆盖词库。':'当前移植基于上游 '+d.current+'，未发现更高版本。';if(S.page==='memewiki')renderPage();};
actions['meme-probe']=async()=>{const q=$('#meme-query').value.trim();if(!q)throw Error('先填写一句话或梗名');const d=await request('/api/memewiki/lookup?q='+encodeURIComponent(q));await ask({title:'本地查询测试',description:'仅查本地词库，不调用模型，不发送 QQ 消息。',fields:'<p>自动预查：'+esc(d.automaticCandidate||'未触发或未命中')+'</p><p>直接查词：'+esc(d.item?.title||'未收录')+'</p><p>'+esc(d.item?.usage||d.item?.summary||'')+'</p>',confirm:'关闭'});};
document.addEventListener('input',event=>{const el=event.target,key=el.dataset.memeSetting;if(key){MemeUI.draft||=structuredClone(MemeUI.state.config);MemeUI.draft[key]=el.type==='checkbox'?el.checked:['number','range'].includes(el.type)?Number(el.value):el.value;if(key==='roastLevel')$('#meme-level').textContent=el.value+' / 100 · '+memeLevel(Number(el.value));$('#meme-dirty').textContent='有未保存的插件设置';}if(el.id==='meme-query')MemeUI.q=el.value;});
document.addEventListener('keydown',event=>{if(event.target.id==='meme-query'&&event.key==='Enter'){event.preventDefault();actions['meme-search']().catch(e=>toast(e.message,true));}});

function proactiveMemeStatus(id){const item=S.status.engine?.groups?.find(g=>g.id===id)?.lastProactiveMeme;return item?'最近成功发送的随机梗：'+item.title+' · '+time(item.at):'还没有成功发送的随机梗话题。';}

const PersonalityUI={values:new Map(),drafts:new Map()};

function memberMemorySections(entries) {
  const members=new Map();
  for(const entry of entries){
    const key=JSON.stringify([entry.subject,entry.origin]);
    if(!members.has(key))members.set(key,[]);
    members.get(key).push(entry);
  }
  return [...members.values()].map(rows=>{
    const {subject,origin}=rows[0];
    const name=rows.find(row=>row.source?.senderName)?.source.senderName;
    const scope=rows.find(row=>row.source?.scopeName)?.source.scopeName || groupName(origin);
    const body=rows.map((row,index)=>
      '<textarea class="memory-paragraph" rows="1" maxlength="180" data-personality-entry="'+esc(row.id)+'" aria-label="编辑 '+esc(name||subject)+' 的第 '+(index+1)+' 段记忆">'+esc(row.text)+'</textarea>'
    ).join('');
    const sources=renderMemorySources(rows.map((row,index)=>({position:index+1,source:row.source,at:row.at})));
    return '<section class="memory-member"><div class="memory-member-label"><strong>'+esc(name||'成员')+
      '</strong><small>QQ '+esc(subject)+(scope?' · '+esc(scope):'')+'</small></div>'+body+sources+'</section>';
  }).join('');
}
function variablePersonality(id) {
  const value=PersonalityUI.drafts.get(id)||PersonalityUI.values.get(id);
  const notes=sourceParagraphs(value?.text,value?.notesSources,PersonalityUI.values.get(id)?.text);
  return '<section class="field wide plastic-section" id="variable-personality"><span>可变人格</span>'+
    '<details class="memory-editor" open><summary>手动编辑人格</summary><div class="memory-document">'+
    '<label class="field"><span>通用内容</span><textarea id="personality-text" rows="4" maxlength="6000" placeholder="共同经历与约定，适用于使用此人设的会话">'+esc(value?.text||'')+'</textarea></label>'+notes+
    memberMemorySections(value?.entries||[])+'</div></details>'+
    '<label class="checkline"><input id="personality-enabled" type="checkbox" '+(value?.enabled!==false?'checked':'')+'>自动保存明确的个人信息和称呼</label>'+
    '<small>私聊记忆仅在原私聊或授权共享群使用。清空某段成员记忆并保存即可删除。</small>'+
    '<div class="toolbar">'+button('保存可变人格','personality-save','save','secondary')+button('刷新','personality-refresh','refresh','ghost')+'</div></section>';
}
async function loadPersonality(){const id=S.personaId;if(!id)return;PersonalityUI.values.set(id,await request('/api/persona-personality?id='+encodeURIComponent(id)));if(S.page==='personas')renderPage();}

function personalityDraft() {
  const id=S.personaId, value=PersonalityUI.drafts.get(id)||PersonalityUI.values.get(id);
  const text=$('#personality-text');
  if(!value||!text)return;
  const edits=new Map($$('[data-personality-entry]').map(field=>[field.dataset.personalityEntry,field.value]));
  PersonalityUI.drafts.set(id,{
    ...value,text:text.value,enabled:$('#personality-enabled').checked,
    entries:value.entries.map(entry=>({...entry,text:edits.get(entry.id)??entry.text}))
  });
}
async function savePersonality() {
  personalityDraft();
  const id=S.personaId, draft=PersonalityUI.drafts.get(id);
  if(!draft)throw Error('请先读取人设');
  const {text,enabled,revision}=draft;
  const entries=draft.entries.filter(entry=>entry.text.trim()).map(({id,subject,origin,text})=>({id,subject,origin,text}));
  const result=await request('/api/persona-personality',{method:'PUT',body:{id,text,enabled,revision,entries}});
  PersonalityUI.values.set(id,result);
  const newer=PersonalityUI.drafts.get(id);
  if(newer===draft)PersonalityUI.drafts.delete(id);
  else if(newer)PersonalityUI.drafts.set(id,{...newer,revision:result.revision});
  if(S.page==='personas')renderPage();
  toast('可变人格已保存，下次请求使用最新内容');
}
document.addEventListener('input',e=>{if(e.target.id==='personality-text'||e.target.id==='personality-enabled'||e.target.dataset.personalityEntry)personalityDraft();});

function formatLogDetail(value){if(typeof value!=='string')return JSON.stringify(value,null,2);try{return JSON.stringify(JSON.parse(value),null,2);}catch{return value;}}

const ProviderModels=new Map();let VoiceDecisions=[];

function renderMemorySources(items) {
  if(!items.length)return '';
  const bySource=new Map();
  for(const {position,source,at} of items){
    const key=JSON.stringify([source||null,at||null]);
    if(!bySource.has(key))bySource.set(key,{positions:[],source,at});
    bySource.get(key).positions.push(position);
  }
  return '<div class="memory-provenance" aria-label="来源">'+[...bySource.values()].map(({positions,source,at})=>{
    const label='第 '+positions.join('、')+' 段';
    if(!source)return '<p><strong>'+label+'</strong> · 历史条目，原话未记录'+(at?' · 添加于 '+esc(time(at)):'')+'</p>';
    const method={manual:'本机手动编辑',model:'模型自主归纳',explicit:'明确要求自动记录'}[source.method]||'记录来源';
    const person=(source.senderName||source.senderId||'未知成员')+(source.senderId?'（QQ '+source.senderId+'）':'');
    const scope=source.scopeName||groupName(source.scope)||'本机';
    const date=source.at?time(source.at):'原消息时间未记录';
    const added=at&&at!==source.at?' · 添加于 '+time(at):'';
    return '<p><strong>'+label+'</strong> · '+esc([method,person,scope,date].join(' · ')+added)+
      (source.messageId?' · 消息 '+esc(source.messageId):'')+
      (source.quote?'<q>'+esc(source.quote)+'</q>':'')+'</p>';
  }).join('')+'</div>';
}

function sourceParagraphs(text,sources,savedText) {
  const lines=String(text||'').split('\n').filter(line=>line.trim());
  const saved=new Set(String(savedText||'').split('\n'));
  return renderMemorySources(lines.flatMap((line,index)=>saved.has(line)
    ?[{position:index+1,source:sources?.[line]}]:[]));
}
function modelPicker(provider,p){const data=ProviderModels.get(provider.id),models=data?.models||[];return '<div class="field wide"><span>服务商可用模型</span><select data-bind="'+p+'.model"><option value="'+esc(provider.model)+'">'+esc(provider.model)+'（当前配置）</option>'+models.filter(m=>m.id!==provider.model).map(m=>'<option value="'+esc(m.id)+'">'+esc(m.name||m.id)+' · '+esc(m.id)+(m.inputModalities?.length?' · '+esc(m.inputModalities.join('/')):'')+'</option>').join('')+'</select>'+button('读取最新模型列表','provider-models-sync','refresh','secondary','data-id="'+esc(provider.id)+'"')+'<small>'+(data?.at?'上次读取：'+esc(time(data.at))+' · '+models.length+' 个模型':'尚未读取；从当前配置的服务商接口查询，不产生聊天生成。')+'</small></div>';}
async function loadProviderModels(){const id=S.providerId||S.config.providers[0]?.id;if(!id)return;ProviderModels.set(id,await request('/api/provider-models?id='+encodeURIComponent(id)));if(S.page==='providers')renderPage();}
actions['provider-models-sync']=async el=>{if(!await saveConfig({quiet:true}))return;ProviderModels.set(el.dataset.id,await request('/api/provider-models/sync',{method:'POST',body:{id:el.dataset.id}}));renderPage();toast('已读取服务商最新模型列表');};
function voiceDecisionPanel(){return '<section class="panel section-gap"><h2>实际语气记录</h2>'+button('刷新语气记录','voice-decisions-refresh','refresh','secondary')+'<p class="field-help">显示真实提交给语音接口的指令。动态开关开启但模型没有给出语气时，会明确显示预设或默认，不伪装成动态生成。合成成功不等于 QQ 已送达。</p>'+VoiceDecisions.map(v=>'<article class="memory-card"><strong>'+esc(v.name)+' · '+esc(v.status)+'</strong><small>'+esc(v.at?time(v.at):'尚未生成')+' · '+esc(v.source||'')+'</small><p>实际语气：'+esc(v.instructions||'服务默认，无语气指令')+'</p><details><summary>合成文本与模型</summary><p>'+esc(v.text||'')+'</p><small>'+esc(v.model||'')+' · '+esc(v.voice||'')+'</small></details></article>').join('')+'</section>';}
actions['voice-decisions-refresh']=async()=>{VoiceDecisions=(await request('/api/voice/decisions')).items;renderPage();};
actions['open-settings']=()=>{const dialog=$('#settings-dialog');dialog.innerHTML='<h2>设置</h2><p>选择要管理的项目</p><div class="settings-grid">'+pages.filter(p=>['activity','providers','tools','api','settings','logs','guide','backups','official','updates'].includes(p[0])).map(([key,label,ico])=>'<button class="button secondary" data-page="'+key+'">'+icon(ico)+esc(label)+'</button>').join('')+'</div><form method="dialog"><button class="button secondary">关闭</button></form>';dialog.showModal();};
document.addEventListener('click',event=>{if(event.target.closest('#settings-dialog [data-page]'))$('#settings-dialog').close();});

const BudgetEstimates=new Map();
function personaTokenSummary(p){const b=new TextEncoder().encode(p.prompt||'').length;const mode=p.injectionMode||'legacy';const n=['single','tail','reminder'].includes(mode)?1:2;const extra=mode==='reminder'?150:0;return '基础人设 '+(p.prompt||'').length+' 字符；'+(mode==='legacy'?'旧规则按最多两份估算':'当前发送 '+n+' 份')+(mode==='reminder'?'＋末尾提醒':'')+'，约 '+Math.ceil((b*n+extra)/3)+' Token；保守预算 '+b*n+'；提醒额外保守预算 '+extra+'。仅基础人设，不含记忆、历史、规则及输出。';}
async function loadBudgetEstimate(){const id=S.groupId;if(!id)return;BudgetEstimates.set(id,await request('/api/input-estimate?groupId='+encodeURIComponent(id)));if(S.page==='groups')renderPage();}
function budgetEstimatePanel(id){const v=BudgetEstimates.get(id);return '<section class="panel section-gap"><h3>输入消耗预估</h3>'+button('刷新预估','budget-estimate-refresh','refresh','secondary')+(v?'<p>近似输入 '+number(v.roughTokens)+' Token · 保守预算 '+number(v.conservative)+' / 设置上限 '+number(v.inputLimit)+'</p><p>基础人设 '+v.personaChars+' 字 × '+v.copies+' 份；人设预算 '+number(v.parts.persona)+'，可变记忆 '+number(v.parts.learning+v.parts.personality)+'，待裁剪历史 '+number(v.parts.history)+'，固定与可选内容预留 '+number(v.parts.fixedAndOptionalReserve)+'</p><small>'+esc(v.note)+' 此估算基于已保存设置。</small>'+(v.last?'<p>最近请求：保守预留 '+number(v.last.conservative)+'；服务商返回输入 '+number(v.last.actualInput)+' / 输出 '+number(v.last.actualOutput)+(v.last.actualEstimated?'（服务商未返回，采用估算）':'')+'。'+esc(time(v.last.at))+'</p>':''):'<p>刷新可读取已保存配置的估算，不调用模型。</p>')+'</section>';}
actions['budget-estimate-refresh']=loadBudgetEstimate;
document.addEventListener('input',e=>{if(e.target.dataset.bind?.endsWith('.prompt')&&S.page==='personas'){const p=S.config.personas.find(p=>p.id===S.personaId);const box=$('#persona-token-summary');if(p&&box)box.textContent=personaTokenSummary(p);}});

document.addEventListener('change',e=>{if(e.target.dataset.bind?.endsWith('.injectionMode')&&S.page==='personas'){const p=S.config.personas.find(p=>p.id===S.personaId);const box=$('#persona-token-summary');if(p&&box)box.textContent=personaTokenSummary(p);}});

let momentsState=null;
function momentsPage(){
  if(!momentsState)return '<section class="panel">正在读取动态设置…</section>';
  const s=momentsState;
  return heading('QQ SPACE','QQ 动态','由当前 QQ 账号发布，好友可见。软件运行并连接 QQ 时按间隔检查。')+
    '<form id="moments-form" class="panel"><div class="form-grid">'+
    '<label class="checkline"><input name="enabled" type="checkbox" '+(s.enabled?'checked':'')+'>自动发布</label>'+
    '<label class="checkline"><input name="repliesEnabled" type="checkbox" '+(s.repliesEnabled?'checked':'')+'>自动回复自己动态下的新评论和楼中楼</label>'+
    '<label class="field"><span>评论回复概率 <output id="reply-chance">'+esc(s.replyChance??100)+'%</output></span><input type="range" name="replyChance" min="0" max="100" value="'+esc(s.replyChance??100)+'"></label>'+
    '<label class="field"><span>最近评论处理</span><small>'+esc(s.replyStatus?[time(s.replyStatus.at),s.replyStatus.status,s.replyStatus.error||s.replyStatus.text].filter(Boolean).join(' · '):'暂无记录')+'</small></label>'+
    '<p class="field wide">评论检查会在活跃时保持 2 分钟，空闲时逐步延长至 15 分钟。仅处理最近 20 条自己的动态，包含群友之间的楼中楼；不回复自己。'+esc(s.pollStatus?('最近检查 '+time(s.pollStatus.checkedAt)+' · 下次 '+time(s.pollStatus.nextAt)):'')+'</p>'+
    '<label class="field"><span>发布间隔（小时）</span><input required name="hours" type="number" min="1" max="720" step="0.1" value="'+esc(s.hours)+'"></label>'+
    '<label class="field"><span>动态人设</span><select name="profile">'+Object.keys(s.profiles).map(n=>'<option '+(n===s.active?'selected':'')+'>'+esc(n)+'</option>').join('')+'<option value="">新建人设…</option></select></label>'+
    '<label class="field"><span>保存为</span><input name="active" maxlength="60" required value="'+esc(s.active)+'"></label>'+
    '<label class="field wide"><span>动态人设正文</span><textarea name="prompt" maxlength="3000" required>'+esc(s.profiles[s.active]||'')+'</textarea></label>'+
    '<label class="checkline"><input type="checkbox" name="web" '+(s.web?'checked':'')+'>联网找话题（搜索服务未配置时使用近七天科技趣闻）</label>'+
    '<label class="field wide"><span>动态话题与内容要求</span><textarea name="topic" maxlength="2000" required>'+esc(s.topic)+'</textarea></label>'+
    '<label class="field"><span>配表情包概率 <output>'+esc(s.chance)+'%</output></span><input type="range" name="chance" min="0" max="100" value="'+esc(s.chance)+'"></label>'+
    '<label class="field"><span>@ 好友</span><select name="mention">'+[['none','不提醒'],['auto','自动选择一位好友'],['manual','手动指定好友']].map(([v,t])=>'<option value="'+v+'" '+(s.mention===v?'selected':'')+'>'+t+'</option>').join('')+'</select></label>'+
    '<div id="moments-manual-mentions" '+(s.mention==='manual'?'':'hidden')+'><div class="field"><span>指定好友（最多 10 人）</span><input type="hidden" name="mentionIds" value="'+esc((s.friends||[]).join(','))+'"><small id="moments-mentions-label">'+esc(mentionLabel(s.friends||[],momentFriendNames))+'</small><button class="button secondary" id="moments-friends" type="button">读取好友并多选</button></div></div></div>'+
    '<button class="button" type="submit">保存动态设置</button> <button class="button" id="moment-now" type="button">立即发布一条（使用已保存设置）</button></form>'+
    '<section class="panel">'+panelHead('发布记录',s.next?'下次计划 '+time(s.next):'自动发布已关闭')+
    (s.history.map(r=>'<p><strong>'+esc(time(r.at))+' · '+esc(r.status)+'</strong><br>'+esc(r.text||r.error||'')+(r.text&&r.error?' · '+esc(r.error):'')+(r.image?' · '+esc(r.image):'')+((r.friends||(r.friend?[r.friend]:[])).map(id=>' · @'+esc(id)).join(''))+(r.sources||[]).map(s=>' · <a href="'+esc(safeUrl(s.url))+'" target="_blank" rel="noopener">'+esc(s.title)+'</a>').join('')+'</p>').join('')||'<p>暂无记录</p>')+'</section>';
}
document.addEventListener('input',e=>{if(e.target.form?.id==='moments-form'&&e.target.name==='chance')e.target.closest('label').querySelector('output').textContent=e.target.value+'%';});
document.addEventListener('change',e=>{const f=e.target.form;if(f?.id==='moments-form'&&e.target.name==='profile'){f.elements.active.value=e.target.value;f.elements.prompt.value=momentsState.profiles[e.target.value]||'';}});
document.addEventListener('change',e=>{
  if(e.target.form?.id==='moments-form'&&e.target.name==='mention')$('#moments-manual-mentions').hidden=e.target.value!=='manual';
});
document.addEventListener('click',async e=>{
  const button=e.target.closest('#moments-friends');
  if(!button||button.disabled)return;
  const f=button.form;button.disabled=true;
  try{
    const {friends}=await request('/api/qq/friends');
    if(!f.isConnected)return;
    const selected=f.elements.mentionIds.value.split(',').filter(Boolean);
    const picked=await pickMentionTargets(friends,selected,{title:'选择动态 @ 好友',description:'勾选需要提醒的 QQ 好友，再保存动态设置。'});
    if(!picked||!f.isConnected)return;
    const ids=picked.map(x=>x.user_id);
    momentFriendNames.clear();
    for(const {user_id,name} of picked)momentFriendNames.set(user_id,name);
    f.elements.mentionIds.value=ids.join(',');
    $('#moments-mentions-label',f).textContent=mentionLabel(ids,momentFriendNames);
  }catch(err){toast(err.message,true);}finally{button.disabled=false;}
});
document.addEventListener('submit',async e=>{if(e.target.id!=='moments-form')return;e.preventDefault();const f=e.target;const body=Object.fromEntries(new FormData(f));body.friends=body.mentionIds.split(',').filter(Boolean);delete body.mentionIds;body.enabled=f.elements.enabled.checked;body.repliesEnabled=f.elements.repliesEnabled.checked;body.web=f.elements.web.checked;try{momentsState=await request('/api/moments',{method:'PUT',body});if(S.page==='moments')renderPage();toast('动态设置已保存');}catch(err){toast(err.message,true);}});

document.addEventListener('click',async e=>{if(e.target.id!=='moment-now')return;const b=e.target;b.disabled=true;try{await request('/api/moments/publish',{method:'POST',body:{}});toast('动态已发布');}catch(err){toast(err.message,true);}finally{b.disabled=false;momentsState=await request('/api/moments');if(S.page==='moments')renderPage();}});

document.addEventListener('input',e=>{if(e.target.form?.id==='moments-form'&&e.target.name==='replyChance')document.querySelector('#reply-chance').textContent=e.target.value+'%';});
