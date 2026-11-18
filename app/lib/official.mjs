const ORIGIN='https://api.bot.qq.com';
const oid=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const problem=message=>Object.assign(new Error(message),{status:409});
export class OfficialQQ {
  constructor(store,{fetchImpl=fetch,WebSocketImpl=WebSocket,now=Date.now,onEvent=async()=>{}}={}) {
    this.store=store;this.fetch=fetchImpl;this.WS=WebSocketImpl;this.now=now;this.onEvent=onEvent;
    this.active=false;this.connected=false;this.epoch=0;this.retry=0;this.seq=null;this.session='';this.access='';this.expires=0;this.error='';this.phase='stopped';this.identity=null;this.lastEventAt=null;this.replies=new Map();this.tasks=new Set();
  }
  get config(){return this.store.configView.official;}
  status(){return {connected:this.connected,phase:this.phase,error:this.error,identity:this.identity,lastEventAt:this.lastEventAt,groups:this.groups()};}
  groups(){return this.store.getMeta('official:groups:'+this.config.appId,[]);}
  remember(d,removed=false){
    if(!oid(d.group_openid))return;
    const groups=this.groups(),id='official:'+this.config.appId+':'+d.group_openid;
    const found=groups.find(g=>g.id===id);
    if(found&&found.removed===removed)return;
    const next={id,remoteId:d.group_openid,name:String(d.group_name||'官方群 '+d.group_openid.slice(-6)).slice(0,100),removed};
    if(found)Object.assign(found,next);else groups.push(next);
    this.store.setMeta('official:groups:'+this.config.appId,groups.slice(-1000));
  }
  async json(route,{body,access='',method}={}) {
    let r;try{r=await this.fetch(ORIGIN+route,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...(access?{Authorization:'QQBot '+access}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw problem('QQ 官方接口连接失败，请检查网络后重试');}
    let n=0,chunks=[];for await(const part of r.body){n+=part.length;if(n>1024*1024)throw problem('QQ 官方响应过大');chunks.push(part);}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw problem('QQ 官方接口响应格式异常');}
    if(!r.ok||(data.code!==undefined&&Number(data.code)!==0)){if(r.status===401)this.expires=0;const code=Number(data.code)||0;const hints={40034006:'消息内容被 QQ 判定违规，未发送。请检查生成内容和人设；不会自动重试',40034005:'回复所引用的群消息已过期，请用新消息触发回复'};const e=problem('QQ 官方接口拒绝请求（HTTP '+r.status+'，代码 '+code+'）：'+(hints[code]||'请检查凭证、权限、禁言和发送频率'));e.code='official_'+code;throw e;}
    return data;
  }
  async token(){
    if(this.access&&this.expires>this.now()+45000)return this.access;
    if(this.tokenJob)return this.tokenJob;
    const epoch=this.epoch,c={...this.config};
    this.tokenJob=(async()=>{const d=await this.json('/app/getAppAccessToken',{body:{appId:c.appId,clientSecret:c.appSecret}});if(typeof d.access_token!=='string'||!d.access_token||!Number.isFinite(Number(d.expires_in))||Number(d.expires_in)<60)throw problem('QQ 官方凭证响应不完整');if(epoch!==this.epoch)throw problem('官方连接已改变，请重试');this.access=d.access_token;this.expires=this.now()+Number(d.expires_in)*1000;return this.access;})().finally(()=>{this.tokenJob=null;});
    return this.tokenJob;
  }
  async request(route,body){const epoch=this.epoch;const access=await this.token();if(epoch!==this.epoch)throw problem('官方连接已改变');return this.json(route,{body,access});}
  start(){
    if(this.active)return;this.stop();if(!this.config.enabled)return;
    this.active=true;this.error='';this.retry=0;this.launch();
  }
  stop(){this.active=false;this.connected=false;this.phase='stopped';this.epoch++;clearTimeout(this.retryTimer);this.retryTimer=null;clearTimeout(this.handshake);clearTimeout(this.refreshTimer);clearInterval(this.heartbeat);const ws=this.socket;this.socket=null;try{ws?.close();}catch{}this.session='';this.seq=null;this.access='';this.expires=0;this.identity=null;this.replies.clear();}
  launch(){const epoch=this.epoch;const job=this.connect();this.tasks.add(job);job.catch(e=>{if(this.active&&epoch===this.epoch){this.error=e.message;this.schedule();}}).finally(()=>this.tasks.delete(job));}
  async drain(){await Promise.allSettled([...this.tasks]);}
  async connect(){
    const epoch=this.epoch;this.phase='connecting';const access=await this.token();if(!this.active||epoch!==this.epoch)return;
    const gateway=await this.json('/gateway',{access});if(!this.active||epoch!==this.epoch)return;
    let u;try{u=new URL(gateway.url);}catch{throw problem('QQ 官方网关地址异常');}
    if(u.protocol!=='wss:'||u.username||u.password||!(u.hostname==='qq.com'||u.hostname.endsWith('.qq.com')))throw problem('QQ 官方网关地址不受信任');
    const ws=new this.WS(u.href);this.socket=ws;const current=()=>this.active&&epoch===this.epoch&&this.socket===ws;
    this.handshake=setTimeout(()=>{if(current()){this.error='QQ 官方连接握手超时';this.reconnect();}},25000);this.handshake.unref?.();
    ws.addEventListener('message',event=>{
      if(!current())return;
      try{if(typeof event.data!=='string'||event.data.length>1024*1024)throw problem('QQ 官方事件格式异常');const p=JSON.parse(event.data);
        if(p.op===10){const interval=Number(p.d?.heartbeat_interval);if(!Number.isFinite(interval)||interval<1000||interval>120000)throw problem('QQ 心跳周期异常');
          this.send(this.session?{op:6,d:{token:'QQBot '+access,session_id:this.session,seq:this.seq}}:{op:2,d:{token:'QQBot '+access,intents:1<<25,shard:[0,1],properties:{$os:'windows',$browser:'Unusual',$device:'Unusual'}}});
          this.acked=true;clearInterval(this.heartbeat);this.heartbeat=setInterval(()=>{if(!current())return;if(!this.acked){this.error='QQ 官方心跳超时';this.reconnect();return;}this.acked=false;this.send({op:1,d:this.seq});},interval);this.heartbeat.unref?.();
        }else if(p.op===11)this.acked=true;
        else if(p.op===1)this.send({op:1,d:this.seq});
        else if(p.op===7)this.reconnect();
        else if(p.op===9){this.session='';this.seq=null;this.reconnect();}
        else if(p.op===0){if(p.t==='READY'||p.t==='RESUMED'){clearTimeout(this.handshake);this.session=p.d?.session_id||this.session;if(p.t==='READY')this.identity={id:String(p.d?.user?.id||''),name:String(p.d?.user?.username||'官方机器人')};this.connected=true;this.phase='ready';this.error='';this.retry=0;clearTimeout(this.refreshTimer);this.refreshTimer=setTimeout(()=>this.reconnect(),Math.max(1000,this.expires-this.now()-40000));this.refreshTimer.unref?.();}
          const job=this.dispatch(p);this.tasks.add(job);job.then(()=>{if(current()&&Number.isSafeInteger(p.s))this.seq=Math.max(this.seq||0,p.s);}).catch(e=>{if(current())this.error=e.message;}).finally(()=>this.tasks.delete(job));}
      }catch(e){this.error=e.message;this.reconnect();}
    });
    ws.addEventListener('error',()=>{if(current()){this.error='QQ 官方长连接出现错误';this.reconnect();}});
    ws.addEventListener('close',event=>{if(!current())return;this.connected=false;this.socket=null;clearInterval(this.heartbeat);clearTimeout(this.handshake);clearTimeout(this.refreshTimer);
      if([4001,4002,4010,4011,4012,4013,4014,4914,4915].includes(event.code)){this.active=false;this.phase='error';this.error='QQ 官方拒绝连接（'+event.code+'），请检查机器人权限与状态后重新连接';return;}
      if([4006,4007].includes(event.code)){this.session='';this.seq=null;}this.schedule();});
  }
  send(payload){if(this.socket?.readyState===1)this.socket.send(JSON.stringify(payload));}
  reconnect(){const ws=this.socket;this.socket=null;this.connected=false;clearInterval(this.heartbeat);clearTimeout(this.handshake);clearTimeout(this.refreshTimer);try{ws?.close();}catch{}this.schedule();}
  schedule(){if(!this.active||this.retryTimer)return;this.phase='reconnecting';const delay=Math.min(60000,1000*2**Math.min(this.retry++,6));this.retryTimer=setTimeout(()=>{this.retryTimer=null;if(this.active)this.launch();},delay);this.retryTimer.unref?.();}
  async dispatch(p){
    const d=p.d||{};
    if(['GROUP_ADD_ROBOT','GROUP_DEL_ROBOT'].includes(p.t)){this.remember(d,p.t==='GROUP_DEL_ROBOT');return;}
    if(!['GROUP_AT_MESSAGE_CREATE','GROUP_MESSAGE_CREATE'].includes(p.t)||!oid(d.group_openid))return;
    this.remember(d);this.lastEventAt=new Date(this.now()).toISOString();
    const author=d.author||{},sender=String(author.member_openid||author.id||'');if(!oid(sender)||author.bot===true)return;
    const groupId='official:'+this.config.appId+':'+d.group_openid;
    const mentioned=p.t==='GROUP_AT_MESSAGE_CREATE'||!!this.identity?.id&&(d.mentions||[]).some(x=>(x.id||x.member_openid)===this.identity.id);
    const content=String(d.content||'').trim()||(d.attachments||[]).map(a=>String(a.asr_refer_text|| (String(a.content_type).startsWith('image')?'[图片]':'[附件]'))).join(' ')||(mentioned?'[群友 @ 了你]':'');
    if(!content)return;
    if(typeof d.id!=='string'||!d.id)return;
    const timestamp=Date.parse(d.timestamp);if(!Number.isFinite(timestamp)||this.now()-timestamp>300000||timestamp>this.now()+60000)return;
    const previous=this.replies.get(groupId);if(!previous||previous.id!==d.id)this.replies.set(groupId,{id:d.id,at:timestamp,seq:0});
    if(this.replies.size>1000)this.replies.delete(this.replies.keys().next().value);
    const idx=(d.message_scene?.ext||[]).find(x=>typeof x==='string'&&x.startsWith('msg_idx='))||'';
    await this.onEvent({sender:{bot:!!author.bot}}, {groupId,senderId:sender,senderName:String(author.username||sender),selfId:this.identity?.id||'',content:content.slice(0,32000),messageId:[d.id,d.msg_seq||'',idx].join(':').slice(0,512),mentioned});
  }
  canSend(group){return !!this.connected&&this.config.enabled&&group.id.startsWith('official:'+this.config.appId+':');}
  async sendGroup(group,segments,guard=()=>{}) {
    if(!this.canSend(group))throw problem('该群的官方机器人未连接，或属于另一个 AppID');
    const groupId=group.id.split(':')[2];if(!oid(groupId))throw problem('官方群标识无效');
    if(!Array.isArray(segments)||segments.length>3)throw problem('官方群消息格式异常');
    guard();const epoch=this.epoch;const check=()=>{guard();if(epoch!==this.epoch||!this.canSend(group))throw problem('官方连接已改变，本次发送已取消');};
    const text=segments.filter(s=>s.type==='text').map(s=>s.data.text).join('\n');const media=segments.filter(s=>s.type==='image'||s.type==='record');
    if(segments.some(s=>!['text','image','record'].includes(s.type))||media.length>1)throw problem('官方群每次只支持一项本地媒体');
    let payload={msg_type:0,content:text};
    if(media.length){const s=media[0],raw=s.data?.file;if(typeof raw!=='string'||raw.length>24*1024*1024||!/^base64:\/\/[A-Za-z0-9+/]+={0,2}$/.test(raw))throw problem('官方媒体只支持本地文件数据');const buffer=Buffer.from(raw.slice(9),'base64');
      const ext=s.type==='image'?(buffer.subarray(0,3).toString('hex')==='ffd8ff'?'jpg':buffer.subarray(0,3).toString()==='GIF'?'gif':buffer.subarray(8,12).toString()==='WEBP'?'webp':'png'):(buffer.subarray(0,4).toString()==='RIFF'?'wav':buffer.subarray(0,4).toString()==='OggS'?'ogg':buffer.subarray(0,4).toString()==='fLaC'?'flac':'mp3');
      if(ext==='flac')throw problem('官方语音不支持 FLAC，请改用 MP3 或 WAV');
      if(buffer.length>5*1024*1024)throw problem('官方连接当前支持最多 5 MB 的单个本地媒体，请缩小文件或缩短语音');
      check();const uploaded=await this.request('/v2/groups/'+groupId+'/files',{file_type:s.type==='image'?1:3,file_name:'unusual.'+ext,file_data:buffer.toString('base64'),srv_send_msg:false});
      if(typeof uploaded.file_info!=='string'||!uploaded.file_info)throw problem('官方媒体上传未返回 file_info');payload={msg_type:7,content:text,media:{file_info:uploaded.file_info}};
    }
    const ref=this.replies.get(group.id);if(ref&&this.now()-ref.at<280000&&ref.seq<5)Object.assign(payload,{msg_id:ref.id,msg_seq:++ref.seq});
    check();const result=await this.request('/v2/groups/'+groupId+'/messages',payload);if(typeof result.id!=='string'||!result.id)throw problem('QQ 官方未返回消息 ID，无法确认发送成功');return {message_id:result.id};
  }
}
