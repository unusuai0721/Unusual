// QQ attachment ingestion: fixed HTTPS CDN allowlist, bounded response, no local files.
export const IMAGE_TOKENS = 1200;
export function qqImageUrl(value) {
  if(typeof value!=='string'||value.length>8192)return null;
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&(!u.port||u.port==='443')&&['multimedia.nt.qq.com.cn','gchat.qpic.cn','c2cpicdw.qpic.cn','gchat.qlogo.cn'].includes(u.hostname)?u.href:null;}catch{return null;}
}
export function imageMime(b) {
  if(b.length<12)return null;
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(b.subarray(0,6).toString()))return 'image/gif';
  if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return 'image/webp';
  return null;
}
export function checkedImage(value) {
  if(typeof value!=='string'||value.length>7*1024*1024)throw new Error('识图仅接受软件验证过的图片数据');
  const match=value.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match)throw new Error('图片数据格式不正确');
  const buf=Buffer.from(match[2],'base64');
  if(buf.length>5*1024*1024||imageMime(buf)!==match[1])throw new Error('图片超过 5 MB 或内容格式不符');
  return value;
}
export async function loadQQImage(source) {
  const url=qqImageUrl(source);if(!url)throw new Error('图片没有可用的 QQ CDN 地址，无法识别');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);timer.unref?.();let reader;
  try {
    const res=await fetch(url,{redirect:'manual',signal:controller.signal,headers:{Accept:'image/*'}});
    if(!res.ok||res.status>=300)throw new Error('图片地址过期或下载失败，请重新发送图片');
    const limit=5*1024*1024;
    if(Number(res.headers.get('content-length'))>limit)throw new Error('图片超过 5 MB，已跳过识图');
    reader=res.body?.getReader();if(!reader)throw new Error('图片内容为空');
    const chunks=[];let length=0;
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit)throw new Error('图片超过 5 MB，已跳过识图');chunks.push(Buffer.from(value));}
    const data=Buffer.concat(chunks,length),mime=imageMime(data);if(!mime)throw new Error('不是支持的图片格式');
    return 'data:'+mime+';base64,'+data.toString('base64');
  }catch(e){if(controller.signal.aborted)throw new Error('图片下载超时，请重新发送图片');if(e instanceof TypeError)throw new Error('图片下载失败，请重新发送图片');throw e;}
  finally{clearTimeout(timer);controller.abort();try{await reader?.cancel();}catch{}}
}
