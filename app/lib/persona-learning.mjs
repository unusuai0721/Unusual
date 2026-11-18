import {evidence} from './memory-evidence.mjs';
export function styleRequest(value){
 const s=String(value||'').replace(/@\d+\s*/g,'').trim();
 if(/这次|这句|这段|朗读|念|语音|假如|如果|他说|她说|引用/.test(s))return '';
 const m=s.match(/(?:你|希望你|想要你|想让你|以后|说话|回复|语气).{0,10}(可爱|温柔|简短|简洁|活泼|自然|严肃|幽默|礼貌|直接)(?:一?点|一些|些)/);
 if(m&&new RegExp('(?:不要|别|不用|不想|不希望)(?:再|那么|这样|说话|你|太|更)*'+m[1]).test(s))return '';
 return m?'说话'+m[1]+'一点。':'';
}
export function stripLearning(raw){
 const input=String(raw||'');const match=input.match(/<persona_update>([\s\S]*?)<\/persona_update>/);
 let patch=null;try{if(match&&match[1].length<=1600)patch=JSON.parse(match[1]);}catch{}
 return {text:input.replace(/<persona_update>[\s\S]*?(?:<\/persona_update>|$)/g,'').replace(/<\/?persona_update[^>]*>?/g,''),patch};
}
export class PersonaLearning{
 constructor(store,now=Date.now){this.store=store;this.now=now;}
 get(id){return this.store.getMeta('persona:learning:'+id,{text:'',enabled:true,revision:0,updates:0,count:0,lastAttempt:0,updatedAt:null,history:[]});}
 write(id,next,source){const old=this.get(id);const value={...next,revision:old.revision+1,updatedAt:new Date(this.now()).toISOString(),history:[...old.history,{text:old.text,enabled:old.enabled,at:old.updatedAt,source}].slice(-20)};this.store.setMeta('persona:learning:'+id,value);this.store.log('info','persona.learning.updated',JSON.stringify({personaId:id,source,revision:value.revision}));return value;}
 edit(id,{text,enabled,revision}){
  if(!this.store.config.personas.some(p=>p.id===id))throw Error('请先保存这个人设');
  const old=this.get(id);if(revision!==old.revision)throw Object.assign(Error('可变人设刚被更新，请刷新后再编辑；你的输入尚未保存'),{status:409});
  if(typeof text!=='string'||text.length>2000||typeof enabled!=='boolean')throw Error('可变人设最多 2000 字，学习开关必须为布尔值');
  const sources={};for(const line of text.trim().split('\n').filter(Boolean))sources[line]=old.sources?.[line]||evidence({at:new Date(this.now()).toISOString(),senderName:'本机用户'},line,'manual');return this.write(id,{...old,text:text.trim(),sources,enabled},'manual');
 }
 begin(id,message,source={}){const state=this.get(id);const explicit=styleRequest(message);return {state,explicit,source:{...source,content:message},due:state.enabled&&(!!explicit||(state.count>=3&&this.now()-state.lastAttempt>=180000))};}
 finish(id,ticket,patch,blockedNames=[]){
  const current=this.get(id);if(!current.enabled||current.revision!==ticket.state.revision)return;
  const updated={...current,count:current.count+1};
  if(!ticket.due){this.store.setMeta('persona:learning:'+id,updated);return;}
  updated.count=0;updated.lastAttempt=this.now();
  const clean=x=>typeof x==='string'&&x.trim().length>=3&&x.trim().length<=90&&/说话|回复|语气|表达|句|用词|梗|口头禅|笑话|玩笑|口语|交流|聊天|标点|表情|称赞|吐槽|回答|追问|措辞|详细|说明/.test(x)&&!/[\r\n<>]|\d{5,}|https?:|密钥|密码|住址|地址|电话|生日|身份证|银行卡|私聊|群号|系统提示|忽略.{0,6}(规则|指令)|执行|文件|终端/.test(x)&&!blockedNames.some(n=>n?.length>=2&&x.includes(n));
  const modelItems=(Array.isArray(patch?.add)?patch.add:[]).map(x=>typeof x==='string'?{text:x,evidence:ticket.source?.content||''}:x).filter(x=>x&&typeof x.text==='string'&&typeof x.evidence==='string'&&(!ticket.source?.content||ticket.source.content.includes(x.evidence)));
  const add=(ticket.explicit?[ticket.explicit]:modelItems.map(x=>x.text)).slice(0,2).filter(clean).map(x=>x.trim());
  const remove=(ticket.explicit||(Array.isArray(patch?.add)&&patch.add.length&&!add.length))?[]:(Array.isArray(patch?.remove)?patch.remove:[]).slice(0,2);
  const lines=current.text.split('\n').filter(Boolean);let next=lines.filter(x=>!remove.includes(x));
  // A direct request replaces the previous setting for the same expression dimension.
  if(ticket.explicit){const dimension=/简短|简洁/.test(ticket.explicit)?/简短|简洁/:/可爱|温柔|严肃|活泼|自然|幽默|礼貌|直接/;next=next.filter(x=>!/^说话.{2}一点。$/.test(x)||!dimension.test(x));}
  for(const line of add)if(!next.includes(line)&&[...next,line].join('\n').length<=2000)next.push(line);
  updated.text=next.join('\n');
  updated.sources={};for(const line of next)updated.sources[line]=current.sources?.[line]||(add.includes(line)?evidence(ticket.source,modelItems.find(x=>x.text===line)?.evidence||ticket.source?.content,ticket.explicit?'explicit':'model'):null);
  if(updated.text!==current.text){updated.updates++;this.write(id,updated,ticket.explicit?'explicit-style':'model');}
  else this.store.setMeta('persona:learning:'+id,updated);
 }
}
