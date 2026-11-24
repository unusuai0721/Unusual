'use strict';
const {app,BrowserWindow,ipcMain,Menu,Tray,nativeImage,dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),net=require('node:net');
const ROOT=fs.realpathSync(path.resolve(__dirname,'..'));
function own(rel){const dest=path.resolve(ROOT,rel);if(!dest.startsWith(ROOT+path.sep))throw new Error('目录越界');let cur=ROOT;for(const piece of path.relative(ROOT,dest).split(path.sep)){cur=path.join(cur,piece);try{const s=fs.lstatSync(cur);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw new Error('软件目录不能包含链接：'+piece);}catch(e){if(e.code!=='ENOENT')throw e;}}return dest;}
function dir(rel){const p=own(rel);fs.mkdirSync(p,{recursive:true});return p;}
app.setName('Unusual');app.setAppUserModelId('Unusual.Portable');
app.setPath('userData',dir('data/desktop'));
app.setPath('sessionData',dir('data/desktop/session'));
app.setPath('crashDumps',dir('data/desktop/crashes'));
app.setAppLogsPath(dir('data/desktop/logs'));
app.commandLine.appendSwitch('disk-cache-size','33554432');
process.env.TEMP=process.env.TMP=dir('data/temp');
let logSecrets=[];
let win,tray,backend,qq,quitting=false,closing=false,backendCookie='',qqStarting=false,qqError='',serverReady=false;
const PORT=process.env.QILIAO_DESKTOP_TEST==='1'&&process.env.QILIAO_UI_ONLY==='1'?4210:3210;
const ORIGIN='http://127.0.0.1:'+PORT;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function log(file,chunk){try{chunk=chunk.toString();for(const secret of logSecrets)if(secret)chunk=chunk.split(secret).join('[hidden]');chunk=chunk.replace(/二维码解码URL:[^\r\n]*/g,'二维码解码URL: [hidden]');const p=own('data/'+file);if(fs.existsSync(p)&&fs.statSync(p).size>2*1024*1024){const old=own('data/'+file+'.previous');fs.copyFileSync(p,old);fs.writeFileSync(p,'');}fs.appendFileSync(p,chunk);}catch{}}
function child(exe,args,cwd,logName){const proc=spawn(own(exe),args,{cwd:own(cwd),windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',QILIAO_PARENT_PID:String(process.pid)}});proc.stdout.on('data',x=>log(logName,x));proc.stderr.on('data',x=>log(logName,x));proc.on('error',e=>log(logName,e.message+'\n'));return proc;}
async function vacant(port){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(new Error('本机端口 '+port+' 已被占用。请退出旧版Unusual或占用它的程序后重试。')));s.listen(port,'127.0.0.1',()=>s.close(resolve));});}
async function api(route,body,timeout=10000){const r=await fetch(ORIGIN+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:backendCookie},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout),redirect:'error'});if(!r.ok)throw new Error('本机服务操作失败：'+r.status);return r;}
async function startBackend(){await vacant(PORT);backend=child('runtime/node.exe',['--permission','--allow-fs-read='+ROOT,'--allow-fs-write='+ROOT,own('app/server.mjs')],'app','server.log');backend.once('exit',(code)=>{serverReady=false;if(!quitting){log('desktop.log','Backend exited '+code+'\n');dialog.showErrorBox('Unusual服务已停止','请退出后重新打开Unusual。详情见 data/server.log。');}});for(let i=0;i<100;i++){if(backend.exitCode!==null)throw new Error('本机服务启动失败，请查看 data/server.log');try{const h=await fetch(ORIGIN+'/health',{signal:AbortSignal.timeout(500)}).then(r=>r.json());const s=JSON.parse(fs.readFileSync(own('data/runtime.json'),'utf8'));if(h.app==='qiliao'&&h.pid===backend.pid&&s.pid===backend.pid){const r=await fetch(ORIGIN+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:s.adminToken})});backendCookie=r.headers.get('set-cookie').split(';')[0];serverReady=true;return s.url;}}catch{}await sleep(200);}throw new Error('启动超时，请查看 data/server.log');}
async function startQQ(){throw new Error('请在外部 OneBot 桥接软件中登录 QQ。');}
async function stopQQ(persist=false){if(qq&&qq.exitCode===null&&qq.signalCode===null){const exited=new Promise(r=>qq.once('exit',r));qq.kill();await Promise.race([exited,sleep(5000)]);if(qq.exitCode===null&&qq.signalCode===null)throw new Error('QQ 组件尚未退出，请稍后重试解绑');}qq=null;if(serverReady)await api('/api/qq/stopped',{persist});return {ok:true};}
let qqOperation=Promise.resolve();
function qqAction(fn){const job=qqOperation.catch(()=>{}).then(fn);qqOperation=job;return job;}
async function unbindQQ(){await stopQQ(true);const r=await api('/api/qq/unbind',{confirm:'UNBIND'},60000);return r.json();}
function trusted(event){if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||new URL(event.senderFrame.url).origin!==ORIGIN)throw new Error('无效窗口');}
const updater=require('../app/lib/release-update.cjs').createUpdater({version:require('../package.json').version,own,dir,fetchImpl:(url,opts)=>require('electron').net.fetch(url,opts)});
function setupIPC(){
  let installing=false;
  async function applyUpdate(){
    if(installing)return;
    if(fs.existsSync(own('.git')))throw Error('源码目录请通过 Git 更新。');
    installing=true;
    try{
      const file=await updater.verifiedInstaller();
      const installer=spawn(file,['--apply-update',ROOT,String(process.pid)],{cwd:ROOT,detached:true,stdio:'ignore',windowsHide:true});
      await new Promise((resolve,reject)=>{installer.once('spawn',resolve);installer.once('error',reject);});
      installer.unref();app.quit();
    }catch(e){installing=false;throw e;}
  }
  const updateActions={apply:applyUpdate,check:updater.check,download:updater.download,status:updater.status,folder:async()=>{const file=updater.status().file;if(file&&fs.existsSync(file))require('electron').shell.showItemInFolder(file);}};
  for(const [action,fn] of Object.entries(updateActions))ipcMain.handle('update:'+action,event=>{trusted(event);return fn();});
for(const [name,fn] of Object.entries({'qq:start':()=>qqAction(startQQ),'qq:stop':()=>qqAction(()=>stopQQ(true)),'qq:unbind':()=>qqAction(unbindQQ),'desktop:status':()=>({desktop:true,qqRunning:!!qq&&qq.exitCode===null,qqStarting,qqError,backendReady:serverReady,version:app.getVersion(),memoryMB:Math.round(app.getAppMetrics().reduce((sum,p)=>sum+p.memory.workingSetSize,0)/1024)}),'desktop:quit':()=>{app.quit();return {ok:true};}}))ipcMain.handle(name,(event)=>{trusted(event);return fn();});}
function show(){if(!win||win.isDestroyed()||quitting)return;win.show();if(win.isMinimized())win.restore();win.focus();}
async function createWindow(url){win=new BrowserWindow({title:'Unusual',icon:own('desktop/icon.ico'),width:1280,height:860,minWidth:950,minHeight:660,show:false,backgroundColor:'#f7f8f5',autoHideMenuBar:true,webPreferences:{preload:own('desktop/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:true,spellcheck:false}});Menu.setApplicationMenu(null);win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));win.webContents.session.setPermissionCheckHandler(()=>false);win.webContents.session.on('will-download',event=>event.preventDefault());win.webContents.setWindowOpenHandler(({url})=>{try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password)require('electron').shell.openExternal(u.href);}catch{}return {action:'deny'};});win.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin!==ORIGIN)e.preventDefault();});win.webContents.on('will-attach-webview',event=>event.preventDefault());win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});win.once('ready-to-show',show);win.webContents.on('render-process-gone',()=>{if(!quitting)dialog.showErrorBox('Unusual窗口异常','请通过托盘退出，再重新打开。聊天数据仍保存在软件目录。');});await win.loadURL(url);
tray=new Tray(nativeImage.createFromPath(own('desktop/icon.ico')));tray.setToolTip('Unusual · 双击打开，右键退出');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开Unusual',click:show},{label:'退出（停止 QQ 和自动聊天）',click:()=>app.quit()}]));tray.on('double-click',show);
}

async function shutdown(){if(closing)return;closing=true;quitting=true;if(win&&!win.isDestroyed())win.destroy();await qqOperation.catch(()=>{});await stopQQ();if(serverReady){try{await api('/api/shutdown',{});}catch{}}if(backend&&backend.exitCode===null){await Promise.race([new Promise(r=>backend.once('exit',r)),sleep(90000)]);if(backend.exitCode===null)backend.kill();}tray?.destroy();app.exit(0);}
if(!app.requestSingleInstanceLock())app.quit();else if(process.argv.includes('--quit'))app.quit();else{app.on('second-instance',(_event,args)=>{if(args.includes('--quit'))app.quit();else if(win)show();});app.on('window-all-closed',()=>{});app.on('before-quit',e=>{if(!closing){e.preventDefault();shutdown();}});app.whenReady().then(async()=>{setupIPC();const url=await startBackend();await createWindow(url);}).catch(async e=>{if(quitting)return;log('desktop.log',e.stack+'\n');dialog.showErrorBox('Unusual启动失败',e.message);await shutdown();});}
