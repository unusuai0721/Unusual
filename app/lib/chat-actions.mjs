// Deterministic chat requests and scoped output markers, not general model tools.
export function voiceRequest(value) {
 const s=String(value||'').replace(/@\d+\s*/g,'').trim();
 const negative=/(?:别|不要|不用|不想).{0,6}(?:语音|声音)/.test(s);
 const previous=/^(?:语音|语音版|用语音再说一遍|用语音再发一遍)[啊呀吧哦！!。？?]*$/.test(s);
 const requested=!negative&&(previous||/(?:发|用|来|说|读|转|听).{0,12}语音|语音.{0,12}(?:发|说|读|回复|回答)|(?:听听|听一下|听你).{0,8}(?:声音|说话)/.test(s));
 if(!requested)return {requested:false,negative,text:'',tone:''};
 const tone=s.match(/(?:用|以)([^，。！？\n]{1,30}?)(?:的语气|的声音)/)?.[1]||'';
 let text='';
 const quoted=[...s.matchAll(/[“「『"]([^”」』"\n]{1,32000})[”」』"]/g)].at(-1);
 if(quoted)text=quoted[1];
 else {const colon=s.match(/(?:语音.{0,12}(?:说|读|念|发送|内容)|(?:发|读|说|念).{0,12}语音|语音)\s*[:：]\s*([\s\S]+)/);if(colon)text=colon[1].trim();
 else {const phrase=s.match(/(?:发|说|读|念)(?:一?[句段个])?\s*(.{1,160}?)的语音(?:[啊呀吧哦来！!。]*)$/);if(phrase)text=phrase[1].trim();}}
 if(!text){const spoken=s.match(/语音(?:说|读|念)(?:一下|一遍|一句)?\s*(.+)$/);if(spoken&&!/^(?:出来|一下|一遍|这句|这段|这条|上面这句)(?:吧|啊|呀|哦)?[。！!]*$/.test(spoken[1].trim()))text=spoken[1].trim();}
 return {requested:true,negative:false,text,tone,previous};
}
export function emojiRequest(text){return /(?:发|来|给|用).{0,10}表情|表情包.{0,8}(?:发|来)/.test(text)&&!/(?:别|不要|不用).{0,8}表情/.test(text);}
export function interactionScope(rows,selfId){
 const messages=new Set(),members=new Set();
 for(const r of rows){if(r.source!=='qq')continue;if(/^-?\d{1,20}$/.test(String(r.messageId)))messages.add(String(r.messageId));if(r.role==='user'&&/^[1-9]\d{0,19}$/.test(String(r.senderId))&&String(r.senderId)!==String(selfId))members.add(String(r.senderId));}
 return {messages,members};
}
export function extractInteractions(raw,scope,group){
 let replyTo,mention,poke;
 const text=String(raw||'').replace(/\[(引用|艾特|戳)[:：]([^\]\r\n]*)\]/g,(_,kind,id)=>{
   if(kind==='引用'&&group.quoteReply!==false&&scope.messages.has(id))replyTo??=id;
   if(kind==='艾特'&&group.allowMention!==false&&scope.members.has(id))mention??=id;
   if(kind==='戳'&&group.allowPoke===true&&scope.members.has(id))poke??=id;
   return '';
 });
 return {text,replyTo,mention,poke};
}
