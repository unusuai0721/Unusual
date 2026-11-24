'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {pipeline}=require('node:stream/promises');
const {Readable,Transform}=require('node:stream');
const FULL='77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed';
const CORE='6cf1e5a802ae40420a94474766992e153001092a69828ff87d5eca476375e5da';
const URL='https://github.com/XingYunStar/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip';
const REL='components/napcat-4.18.42';
const MAX=160*1024*1024;
async function digest(file){
  const hash=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
async function read(handle,position,size){
  const data=Buffer.alloc(size);
  if((await handle.read(data,0,size,position)).bytesRead!==size)throw Error('ZIP 数据不完整');
  return data;
}
// Inputs are digest-pinned release files. Read the ZIP directory once and
// stream one file at a time, including the large QQ native module.
async function extract(file,stage,skip=new Set()){
  const h=await fs.promises.open(file,'r');
  try{
    const {size}=await h.stat(), len=Math.min(65557,size), tail=await read(h,size-len,len);
    const end=tail.lastIndexOf(Buffer.from('504b0506','hex'));
    if(end<0||end+22>len)throw Error('ZIP 目录无效');
    const count=tail.readUInt16LE(end+10), bytes=tail.readUInt32LE(end+12);
    if(count>5000||bytes>4*1024*1024)throw Error('ZIP 目录过大');
    const cd=await read(h,tail.readUInt32LE(end+16),bytes);
    let offset=0,total=0;
    for(let i=0;i<count;i++){
      if(cd.readUInt32LE(offset)!==0x02014b50)throw Error('ZIP 文件目录损坏');
      const method=cd.readUInt16LE(offset+10),packed=cd.readUInt32LE(offset+20),original=cd.readUInt32LE(offset+24);
      const local=cd.readUInt32LE(offset+42),nameSize=cd.readUInt16LE(offset+28);
      const name=cd.toString('utf8',offset+46,offset+46+nameSize);
      offset+=46+nameSize+cd.readUInt16LE(offset+30)+cd.readUInt16LE(offset+32);
      if(name.endsWith('/')||skip.has(name))continue;
      if(name.split('/').some(p=>!p||p==='.'||p==='..'||/[\\:\0]/.test(p)))throw Error('ZIP 路径无效');
      total+=original;
      if(total>700*1024*1024||![0,8].includes(method))throw Error('ZIP 格式不支持');
      const dest=path.join(stage,...name.split('/'));
      const header=await read(h,local,30);
      if(header.readUInt32LE(0)!==0x04034b50)throw Error('ZIP 文件头损坏');
      const start=local+30+header.readUInt16LE(26)+header.readUInt16LE(28);
      await fs.promises.mkdir(path.dirname(dest),{recursive:true});
      const input=packed?fs.createReadStream(file,{start,end:start+packed-1}):Readable.from([]);
      await pipeline(input,...(method===8?[zlib.createInflateRaw()]:[]),fs.createWriteStream(dest,{flags:'wx'}));
      if((await fs.promises.stat(dest)).size!==original)throw Error('解压校验失败');
    }
  }finally{await h.close();}
}
function createComponent({own,dir,fetchImpl}){
  let busy=false,progress='',controller;
  function installed(){return fs.existsSync(own(REL+'/.installed'))&&fs.existsSync(own(REL+'/node.exe'));}
  async function install(selected){
    if(busy)throw Error('组件正在导入');
    if(typeof selected!=='string'||!path.isAbsolute(selected)||path.extname(selected).toLowerCase()!=='.zip')throw Error('请选择 NapCat 组件 ZIP');
    const stat=await fs.promises.stat(selected);
    if(!stat.isFile()||stat.size>MAX)throw Error('文件不是支持的 NapCat 组件 ZIP');
    busy=true;progress='正在校验组件';
    let work;
    try{
      dir('components');work=await fs.promises.mkdtemp(own('components/.napcat-import-'));
      const input=path.join(work,'input.zip'),full=path.join(work,'runtime.zip'),stage=path.join(work,'ready');
      await fs.promises.copyFile(selected,input,fs.constants.COPYFILE_EXCL);
      const hash=await digest(input);
      if(hash!==CORE&&hash!==FULL)throw Error('组件校验不匹配，请下载 Unusual 发布页上的 NapCat v4.18.42 组件 ZIP');
      if(installed())return;
      await fs.promises.mkdir(stage);
      if(hash===CORE){
        progress='正在准备 NapCat';await extract(input,stage);
        progress='正在下载 Windows 运行文件';
        controller=new AbortController();
        let timer;
        const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(),45000);};
        try{
          touch();
          const response=await fetchImpl(URL,{credentials:'omit',signal:controller.signal});
          if(!response.ok||!response.body)throw Error('无法下载 Windows 运行文件（HTTP '+response.status+'）');
          let n=0;
          const limit=new Transform({transform(chunk,_enc,done){
            n+=chunk.length;touch();progress='下载运行文件 · '+Math.round(n/1048576)+' MB';
            done(n>MAX?Error('文件大小异常'):null,chunk);
          }});
          await pipeline(Readable.fromWeb(response.body),limit,fs.createWriteStream(full,{flags:'wx'}));
        }finally{clearTimeout(timer);controller.abort();controller=null;}
        if(await digest(full)!==FULL)throw Error('Windows 运行文件校验失败');
        progress='正在安装运行文件';
        await extract(full,stage,new Set(['napcat/napcat.mjs','napcat/package.json','napcat/config/napcat.json']));
      }else{progress='正在离线导入组件';await extract(input,stage);}
      await fs.promises.writeFile(path.join(stage,'.installed'),FULL,{flag:'wx'});
      await fs.promises.rename(stage,own(REL));
    }finally{
      try{if(work)await fs.promises.rm(work,{recursive:true,force:true});}finally{progress='';busy=false;}
    }
  }
  return {install,installed,status:()=>({installed:installed(),progress}),cancel:()=>controller?.abort()};
}
module.exports={createComponent,REL};
