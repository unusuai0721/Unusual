import {randomUUID} from 'node:crypto';
export const isPrivate=id=>/^private:[1-9]\d{0,19}$/.test(String(id));
export class Memories {
 constructor(store){this.store=store;}
 all(){return this.store.getMeta('conversation:memories',[]);}
 list(scope){return this.all().filter(m=>m.scope===scope||m.origin===scope);}
 active(scope){return this.all().filter(m=>m.scope===scope&&this.authorized(m));}
 authorized(m){if(m.scope===m.origin)return true;const source=this.store.config.groups.find(g=>g.id===m.origin);return !!source?.enabled&&(source.sharedTargets||[]).includes(m.scope);}
 save({id,scope,origin=scope,text,author=''}){
  const groups=this.store.config.groups;if(!groups.some(g=>g.id===scope)||!groups.some(g=>g.id===origin))throw Error('记忆会话不存在');
  if(typeof text!=='string'||!text.trim()||text.length>600)throw Error('记忆需为 1～600 字');
  if(scope!==origin&&!this.authorized({scope,origin}))throw Error('该私聊尚未授权向目标会话共享记忆');
  const all=this.all();const old=id?all.find(m=>m.id===id):all.find(m=>m.scope===scope&&m.origin===origin&&m.text===text.trim());
  if(id&&!old)throw Error('记忆不存在');if(!old&&all.length>=500)throw Error('记忆已达 500 条，请先整理');
  const item={id:old?.id||randomUUID(),scope,origin,text:text.trim(),author:String(author).slice(0,40),createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  this.store.setMeta('conversation:memories',[...all.filter(m=>m.id!==item.id),item]);this.bump();return item;
 }
 remove(id){const all=this.all();if(!all.some(m=>m.id===id))throw Error('记忆不存在');this.store.setMeta('conversation:memories',all.filter(m=>m.id!==id));this.bump();return {ok:true};}
 bump(){this.store.setMeta('conversation:memoryRevision',this.store.getMeta('conversation:memoryRevision',0)+1);}
}
export function resolveTarget(name,groups,ids){
 const clean=String(name).trim().replace(/(?:这个|那个)?群(?:里)?$/,'').replace(/^群(?:号)?\s*/,'').replace(/群$/,'');
 const generic=['群里','群里面','群聊','群'].includes(String(name).trim());
 const normalized=value=>String(value||'').replace(/(?:这个|那个)?群(?:里)?$/,'').split(/[、，,]/).map(x=>x.trim().toLowerCase()).sort().join('、');
 const matches=groups.filter(g=>g.enabled&&g.channel!=='official'&&!isPrivate(g.id)&&(ids||[]).includes(g.id)&&(generic||g.id===clean||g.name===name.trim()||g.name===clean||normalized(g.name)===normalized(clean)||g.name?.replace(/群$/,'')===clean));
 if(matches.length!==1)throw Error('目标群未授权、不存在或名字有歧义，请用群号指定');return matches[0];
}
export function privateCommand(text){
 const s=String(text||'').trim().replace(/^(?:你|你能不能|你可以)(?:帮我)?/,'').replace(/帮我去/,'去').replace(/(?:里面|里边)/g,'里');
 if(/^(?:群里|群里面).{1,40}(?:是|很).{1,100}$/.test(s))return {kind:'memory',target:'__defaultShared',text:s};
 if(/(?:查|看|列|哪些).{0,12}群|有哪些群/.test(s))return {kind:'targets'};
 let m=s.match(/^(?:那)?(?:你)?(?:去|到)\s*(.+?)(?:这个群|那个群|群里|群)?(?:说话|说句话|发句话)[吧啊。！!]*$/);if(m&&!/艾特|@|叫/.test(m[1]))return {kind:'relay',target:m[1].trim(),text:'',generate:true};
 m=s.match(/^(?:那)?(?:你)?(?:去|到)\s*(.+?)(?:这个群|那个群|群里|群)\s*(?:说|发|转达)\s*[:：]\s*([\s\S]+)$/);if(m)return {kind:'relay',target:m[1].trim(),text:m[2].trim()};
 m=s.match(/^记住(?:群(?:号)?\s*([^：:]+))?\s*[:：]\s*([\s\S]+)$/);if(m)return {kind:'memory',target:m[1]?.trim()||'',text:m[2].trim()};
 m=s.match(/^(?:请|帮我|请帮我)?(?:去|到)\s*(.+?)\s*(?:@|艾特|叫)\s*([^\s：:]+?)\s*(?:跟他|跟她|和他|和她)?(?:说|发|转达)(?:一句|句话)?\s*[:：]\s*([\s\S]+)$/);
 if(m)return {kind:'relay',target:m[1].trim(),member:m[2].trim().replace(/[，,]$/,''),text:m[3].trim()};
 m=s.match(/^(?:请|帮我|请帮我)?(?:去|到)\s*(.+?)\s*(?:@|艾特|叫)\s*([^\s：:]+?)\s*(?:跟他|跟她|和他|和她)?说句话[吧啊。！!]*$/);if(m)return {kind:'relay',target:m[1].trim(),member:m[2].trim().replace(/[，,]$/,''),text:'',generate:true};
 m=s.match(/^(?:请|帮我|请帮我)?(?:去|到)\s*(.+?)\s*(?:@|艾特)\s*([^\s：:，,@]+)[，,]?\s*(?:跟他|跟她|和他|和她)?(?:说|发|转达)(?:一句|句话)?\s*[：:,，]?\s*(.+)$/);
 if(m)return {kind:'relay',target:m[1].trim(),member:m[2].trim().replace(/[，,]$/,''),text:m[3].trim()};
 m=s.match(/^(?:请)?(?:去|到)\s*(.+?)\s*(?:@|艾特)\s*([^\s，,。！？!?]+)[。！!]*$/);if(m)return {kind:'relay_pending',target:m[1].trim(),member:m[2].trim(),text:''};
 return null;
}
