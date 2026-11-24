'use strict';
const fs = require('node:fs');
const {createHash, randomUUID} = require('node:crypto');
const repository = 'unusuai0721/Unusual';
const endpoint = 'https://api.github.com/repos/' + repository + '/releases/latest';

function newer(version, installed) {
  const other = installed.split('.').map(Number);
  for (const [i, part] of version.split('.').map(Number).entries()) {
    if (part !== other[i]) return part > other[i];
  }
  return false;
}

function createUpdater({version, fetchImpl, own, dir}) {
  let state = {phase:'idle', current:version}, release, job;
  const status = () => ({...state});
  const run = fn => {
    if (job) return job;
    job = fn().catch(error => {
      state = {...state, phase:'error', error:String(error.message || error)};
      return status();
    }).finally(() => {job = null;});
    return job;
  };
  async function check() {
    return run(async () => {
      release = null;
      state = {phase:'checking', current:version};
      const r = await fetchImpl(endpoint, {credentials:'omit',cache:'no-store',headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(25000)});
      if (!r.ok) throw Error('GitHub 版本查询失败（HTTP '+r.status+'）');
      const data = await r.json();
      const latest = /^v(\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(data.tag_name)?.[1];
      if (!latest || data.draft || data.prerelease) throw Error('未找到正式版本');
      const filename = 'Unusual-'+latest+'-Windows-x64-Setup.exe';
      const url = 'https://github.com/'+repository+'/releases/download/'+data.tag_name+'/'+filename;
      const asset = data.assets?.find(a => a.name===filename && a.state==='uploaded' && a.browser_download_url===url);
      state = {current:version, latest, available:newer(latest,version), phase:'checked'};
      if (!state.available) return status();
      if (!asset || !/^sha256:[0-9a-f]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size<1 || asset.size>1024**3) throw Error('新版缺少可校验的 Windows 安装包');
      release = {url, filename, size:asset.size, hash:asset.digest.slice(7)};
      state.total = asset.size;
      return status();
    });
  }
  async function download() {
    return run(async () => {
      if (!release) throw Error('请先检查更新');
      const {url,filename,size,hash} = release;
      const folder = 'downloads/updates/';
      dir('downloads/updates');
      const dest = own(folder+filename);
      state = {...state, phase:'downloading', received:0, total:size, error:''};
      if (fs.existsSync(dest)) {
        const digest = createHash('sha256');
        for await (const chunk of fs.createReadStream(dest)) digest.update(chunk);
        if (digest.digest('hex')===hash) {
          state = {...state,phase:'done',received:size,file:dest};
          return status();
        }
        throw Error('已有同名文件但校验失败，请移走该文件后重试');
      }
      const temp = own(folder+'.'+randomUUID()+'.part');
      const controller = new AbortController();
      let file, timer;
      function touch() { clearTimeout(timer);timer=setTimeout(()=>controller.abort(),45000); }
      try {
        touch();
        const r = await fetchImpl(url,{credentials:'omit',signal:controller.signal});
        if (!r.ok || !r.body) throw Error('下载失败（HTTP '+r.status+'）');
        file = await fs.promises.open(temp,'wx');
        const digest = createHash('sha256');
        for await (const chunk of r.body) {
          touch();
          if (state.received + chunk.length > size) throw Error('下载大小与发布记录不符');
          await file.writeFile(chunk);
          digest.update(chunk);
          state.received += chunk.length;
        }
        if (state.received!==size || digest.digest('hex')!==hash) throw Error('下载文件校验失败，请重试');
        await file.close();file=null;
        await fs.promises.rename(temp,own(folder+filename));
        state = {...state,phase:'done',file:dest};
        return status();
      } finally {
        clearTimeout(timer);controller.abort();
        if(file) await file.close();
        await fs.promises.rm(temp,{force:true});
      }
    });
  }
  async function verifiedInstaller(){
    if(job||state.phase!=='done'||!release)throw Error('请先完成下载与校验');
    const file=own('downloads/updates/'+release.filename);
    const digest=createHash('sha256');
    for await(const chunk of fs.createReadStream(file))digest.update(chunk);
    if(digest.digest('hex')!==release.hash)throw Error('安装包已改变，请重新下载');
    return file;
  }
  return {check,download,status,verifiedInstaller};
}
module.exports = {createUpdater};
