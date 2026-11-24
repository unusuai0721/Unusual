import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { token } from './config.mjs';

// Only these fixed local NapCat operations are reachable; no general proxy.
export class NapCat {
  constructor(store, { fetchImpl = fetch, now = Date.now, basePort=3210 } = {}) {
    this.basePort=basePort; this.apiUrl="http://127.0.0.1:"+(basePort+2); this.store = store; this.fetch = fetchImpl; this.now = now;
    this.credential = ''; this.expires = 0; this.cache = null; this.pending = null; this.synced = '';
  }
  managed() {
    try { return JSON.parse(fs.readFileSync(this.store.paths.resolve('data/napcat-managed.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  desiredConfig() {
    const o = this.store.config.onebot;
    return { network: {
      httpServers: [{ name:'qiliao',enable:true,port:this.basePort+2,host:'127.0.0.1',enableCors:false,enableWebsocket:false,messagePostFormat:'array',token:o.accessToken,debug:false }],
      httpClients: [{ name:'qiliao-events',enable:true,url:'http://127.0.0.1:'+this.basePort+'/onebot/events',messagePostFormat:'array',reportSelfMessage:false,token:o.webhookToken,debug:false }],
      httpSseServers:[],websocketServers:[],websocketClients:[],plugins:[]
    }, musicSignUrl:'',enableLocalFile2Url:false,parseMultMsg:false,imageDownloadProxy:'' };
  }
  prepare() {
    const p = this.store.paths;
    for (const dir of ['data/napcat/config','data/napcat/cache','data/napcat/logs','data/napcat/plugins','data/qq','data/bridge-profile','data/temp']) p.ensureDir(dir);
    const current = this.managed(), config = this.store.config;
    if (!current || config.onebot.baseUrl !== this.apiUrl || !config.onebot.accessToken) config.onebot.accessToken = token();
    config.onebot.baseUrl = this.apiUrl;
    this.store.saveConfig(config);
    let web = {};
    try { web = JSON.parse(fs.readFileSync(p.resolve('data/napcat/config/webui.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const webToken = current?.webToken || token();
    p.writeJson('data/napcat/config/webui.json', { ...web, host:'127.0.0.1',port:this.basePort+1,token:webToken,loginRate:20,autoLoginAccount:web.autoLoginAccount || '',disableWebUI:false,accessControlMode:'whitelist',ipWhitelist:['127.0.0.1','::1'],enableXForwardedFor:false,enable2FA:false });
    p.writeJson('data/napcat/config/onebot11.json', this.desiredConfig());
    p.writeJson('data/napcat-managed.json', { version:1,enabled:true,webToken });
    this.expires = 0; this.invalidate(); return { ok:true };
  }
  async unbind({isRunning}={}) {
    const probe=()=>new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port:this.basePort+1});socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',e=>{socket.destroy();if(e.code==='ECONNREFUSED')resolve(false);else reject(new Error('无法确认 QQ 进程状态，请先彻底退出后重试'));});socket.once('timeout',()=>{socket.destroy();reject(new Error('QQ 组件状态检测超时'));});});
    if(await (isRunning||probe)())throw new Error('请先断开 QQ，再解绑登录状态');
    this.unbinding=true;
    try {
      if(this.pending)await this.pending;
      const p=this.store.paths;
      const targets=['data/qq','data/bridge-profile','data/napcat'];
      const validate=rel=>{const abs=p.resolve(rel);if(!fs.existsSync(abs))return;if(fs.lstatSync(abs).isDirectory())for(const name of fs.readdirSync(abs))validate(path.join(rel,name));};
      for(const rel of targets)validate(rel);
      const c=this.store.config;c.bot.selfId='';for(const g of c.groups)if(g.channel!=='official')g.enabled=false;this.store.saveConfig(c);
      const m=this.managed();if(m)p.writeJson('data/napcat-managed.json',{...m,enabled:false});
      for(const rel of targets)fs.rmSync(p.resolve(rel),{recursive:true,force:true});
      this.credential='';this.expires=0;this.savedUin='';this.invalidate();
      this.store.log('info','qq.unbound','本软件的 QQ 登录状态已清除，NapCat 群已暂停；历史记录和人设保留');
      return {ok:true,historyPreserved:true};
    } finally {this.unbinding=false;}
  }
  setAutoStart(enabled) { const m=this.managed();if(m)this.store.paths.writeJson('data/napcat-managed.json',{...m,enabled:!!enabled}); }
  invalidate() { this.cache = null; this.synced = ''; }
  async raw(route, payload, credential = '') {
    const response = await this.fetch('http://127.0.0.1:'+(this.basePort+1)+'/api/' + route, {
      method:'POST',headers:{'Content-Type':'application/json',...(credential ? {Authorization:'Bearer ' + credential} : {})},
      body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(5000)
    });
    if (!response.ok) { this.expires = 0; throw new Error('QQ 组件暂未就绪（HTTP ' + response.status + '）'); }
    let size=0; const parts=[];
    for await (const chunk of response.body) { size+=chunk.length; if(size>1024*1024)throw new Error('QQ 组件响应过大'); parts.push(chunk); }
    let result; try { result=JSON.parse(Buffer.concat(parts).toString()); } catch { throw new Error('QQ 组件返回格式异常'); }
    if(result.code !== 0) { this.expires=0; throw new Error('QQ 组件未完成该操作，请稍后重试或重新连接'); }
    return result.data;
  }
  async call(route, payload = {}) {
    if (!['QQLogin/CheckLoginStatus','QQLogin/RefreshQRcode','QQLogin/GetQQLoginInfo','QQLogin/SetQuickLoginQQ','OB11Config/SetConfig'].includes(route)) throw new Error('不支持此 QQ 操作');
    const managed = this.managed(); if(!managed) throw new Error('请先点击连接 QQ');
    if(this.now() >= this.expires) {
      const hash=createHash('sha256').update(managed.webToken + '.napcat').digest('hex');
      const auth=await this.raw('auth/login',{hash});
      if(typeof auth?.Credential !== 'string')throw new Error('QQ 组件认证失败');
      this.credential=auth.Credential; this.expires=this.now()+50*60000;
    }
    return this.raw(route,payload,this.credential);
  }
  status() {
    if(this.unbinding)return Promise.resolve({available:false,isLogin:false,phase:'stopped'});
    if(this.pending)return this.pending;
    if(this.cache && this.now()-this.cache.at<3000)return Promise.resolve(this.cache.data);
    this.pending=this.readStatus().then(data=>{this.cache={at:this.now(),data};return data;}).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async readStatus() {
    const managed=this.managed();
    if(!managed||!managed.enabled)return {installed:true,available:false,isLogin:false,phase:'stopped'};
    try {
      const s=await this.call('QQLogin/CheckLoginStatus');
      let info=null, setupError='';
      if(s.isLogin) {
        info=await this.call('QQLogin/GetQQLoginInfo');
        const desired=this.desiredConfig(), fingerprint=JSON.stringify(desired);
        if(this.synced!==fingerprint && this.store.config.onebot.baseUrl===this.apiUrl) {
          try { await this.call('OB11Config/SetConfig',{config:JSON.stringify(desired)}); this.synced=fingerprint; }
          catch { setupError='QQ 已登录，自动连线尚未完成，请稍后刷新。'; }
        }
        const uin=String(info?.uin || info?.user_id || '');
        if(/^[1-9]\d{4,19}$/.test(uin)) {
          const c=this.store.config;
          if(c.bot.selfId!==uin){c.bot.selfId=uin;this.store.saveConfig(c);}
          if(this.savedUin!==uin){await this.call('QQLogin/SetQuickLoginQQ',{uin});this.savedUin=uin;}
        }
      } else this.synced='';
      const qr=this.store.paths.resolve('data/napcat/cache/qrcode.png');
      const stat=fs.existsSync(qr)?fs.statSync(qr):null;
      return {available:true,isLogin:!!s.isLogin,isOffline:!!s.isOffline,phase:s.loginPhase||'waiting',scanned:!!s.qrLoginAccepted,qrVersion:stat?.mtimeMs || 0,hasQr:!s.isLogin&&!!stat,info:info?{uin:info.uin||info.user_id||'',nickname:info.nick||info.nickname||''}:null,error:setupError || (s.loginError?'QQ 登录未完成，请在手机上检查提示或刷新二维码。':'')};
    } catch { return {available:false,isLogin:false,phase:'starting',error:'QQ 组件尚未连接。首次启动通常需要十几秒；若持续未连接，请查看组件状态后重试。'}; }
  }
  async refreshQr() { await this.call('QQLogin/RefreshQRcode');this.cache=null;return {ok:true}; }
  qrImage() {
    const file=this.store.paths.resolve('data/napcat/cache/qrcode.png');
    if(fs.statSync(file).size>1024*1024)throw new Error('二维码文件异常');
    const buffer=fs.readFileSync(file);
    if(buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('二维码格式异常');
    return buffer;
  }
}
