import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';

const digest='496dcd97b4193e6c2aaee9ffacfff4b9ec45a67f43d524ce4fd9efed85bdb16b';
const key='emoji.bundle.'+digest;
export function bundleAvailable(store){return fs.existsSync(store.paths.resolve('app/resources/emoji-starter.zip'));}
export function bundleEnabled(store){return store.getMeta(key,false)===true;}

// Only the fixed, checksummed release archive is accepted. Its local headers
// contain the sizes (no data descriptors) and every entry is a deflated WebP.
function images(store){
  const file=store.paths.resolve('app/resources/emoji-starter.zip');
  if(fs.statSync(file).size!==2744321)throw Error('自带表情包大小异常');
  const zip=fs.readFileSync(file);
  if(createHash('sha256').update(zip).digest('hex')!==digest)throw Error('自带表情包校验失败');
  let offset=0;
  const result=new Map();
  while(zip.readUInt32LE(offset)===0x04034b50){
    const nameStart=offset+30, nameEnd=nameStart+zip.readUInt16LE(offset+26);
    const start=nameEnd+zip.readUInt16LE(offset+28), end=start+zip.readUInt32LE(offset+18);
    const name=/^data\/emoji\/(file_\d+\.webp)$/.exec(zip.toString('utf8',nameStart,nameEnd))?.[1];
    if(!name||result.has(name)||zip.readUInt16LE(offset+8)!==8)throw Error('表情目录异常');
    const image=inflateRawSync(zip.subarray(start,end),{maxOutputLength:5*1024*1024});
    if(image.toString('ascii',8,12)!=='WEBP'||image.length!==zip.readUInt32LE(offset+22))throw Error('图片损坏');
    result.set(name,image);offset=end;
  }
  if(result.size!==73)throw Error('自带表情包不完整');
  return result;
}

export function importBundle(store,media){
  if(bundleEnabled(store))return {added:0,existing:73};
  let added=0,existing=0;
  const created=[];
  try{
    for(const [original,bytes] of images(store)){
      const stem=path.parse(original).name;
      for(let i=0;;i++){
        const name=i===0?original:stem+'-builtin-'+i+'.webp';
        const target=store.paths.mediaPath('emoji',name);
        if(fs.existsSync(target)){
          if(fs.statSync(target).isFile()&&fs.statSync(target).size===bytes.length&&fs.readFileSync(target).equals(bytes)){existing++;break;}
          continue;
        }
        const tmp=store.paths.resolve('data/emoji/.'+randomUUID()+'.tmp');
        try{
          fs.writeFileSync(tmp,bytes,{flag:'wx'});
          try{fs.copyFileSync(tmp,target,fs.constants.COPYFILE_EXCL);}catch(e){if(e.code==='EEXIST'){i--;continue;}throw e;}
          created.push(target);added++;
        }finally{fs.rmSync(tmp,{force:true});}
        break;
      }
    }
    store.setMeta(key,true);
    media.emojiCache=null;
    return {added,existing};
  }catch(error){for(const file of created)fs.rmSync(file,{force:true});throw error;}
}
