import {createHash} from 'node:crypto';
export class VoiceLibrary {
 constructor(store,adapters){this.store=store;this.adapters=adapters;this.jobs=new Map();}
 key(){return 'breeze:library:'+createHash('sha256').update(this.store.config.voice.apiKey||'').digest('hex');}
 read(){return this.store.getMeta(this.key(),{voices:[],favorites:[],updatedAt:null});}
 favorite(id,on){const key=this.key(),data=this.read();if(!data.voices.some(v=>v.voice_id===id))throw new Error('音色不存在，请同步列表');const ids=new Set(data.favorites);on?ids.add(id):ids.delete(id);data.favorites=[...ids];this.store.setMeta(key,data);return data;}
 async sync(){const key=this.key();if(this.jobs.has(key))return this.jobs.get(key);const config={...this.store.config.voice};const job=(async()=>{const voices=new Map();for(let page=1;page<=200;page++){const data=await this.adapters.listBreezeVoices(config,{page,language:'all'});let added=0;for(const v of data.voices){if(v.voice_id&&!voices.has(v.voice_id)){voices.set(v.voice_id,v);added++;}}if(!data.has_more){if(this.key()!==key)throw new Error('同步期间密钥已改变，请重试');const old=this.read();const result={voices:[...voices.values()],favorites:old.favorites,updatedAt:new Date().toISOString()};this.store.setMeta(key,result);return result;}if(!added)throw new Error('音色分页未前进，保留原目录，请稍后重试');}throw new Error('音色目录超过本次同步上限，原目录已保留');})();this.jobs.set(key,job);try{return await job;}finally{this.jobs.delete(key);}}
}
