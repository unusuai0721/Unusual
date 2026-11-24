import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import update from '../app/lib/release-update.cjs';

function fixture(t,{version='0.9.12',bad=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unusual-update-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const name='Unusual-1.0.0-Windows-x64-Setup.exe';
  const bytes=Buffer.from('release asset');
  const asset={name,state:'uploaded',browser_download_url:'https://github.com/unusuai0721/Unusual/releases/download/v1.0.0/'+name,
    size:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
  let requests=0;
  const client=update.createUpdater({version,own:p=>path.join(root,p),dir:p=>fs.mkdirSync(path.join(root,p),{recursive:true}),fetchImpl:async url=>{
    if(url.startsWith('https://api.github.com/'))return Response.json({tag_name:'v1.0.0',assets:[asset]});
    assert.equal(url,asset.browser_download_url);requests++;
    return new Response(bad?Buffer.alloc(bytes.length):bytes);
  }});
  return {client,root,asset,requests:()=>requests};
}
test('updates stream to disk, validate, share concurrent downloads and reuse verified installer',async t=>{
  const f=fixture(t);assert.equal((await f.client.check()).available,true);
  const [a,b]=await Promise.all([f.client.download(),f.client.download()]);
  assert.deepEqual(a,b);assert.equal(a.phase,'done');assert.equal(fs.readFileSync(a.file,'utf8'),'release asset');
  await f.client.download();assert.equal(f.requests(),1);
});
test('failed checksum leaves no package or partial file',async t=>{
  const f=fixture(t,{bad:true});await f.client.check();
  assert.equal((await f.client.download()).phase,'error');
  assert.deepEqual(fs.readdirSync(path.join(f.root,'downloads/updates')),[]);
});
test('local newer version does not offer an older package and mismatched release asset is rejected',async t=>{
  const newer=fixture(t,{version:'1.10.0'});assert.equal((await newer.client.check()).available,false);
  assert.equal((await newer.client.download()).phase,'error');assert.equal(newer.requests(),0);
  const invalid=fixture(t);invalid.asset.browser_download_url='https://example.com/a';
  assert.equal((await invalid.client.check()).phase,'error');assert.equal(invalid.requests(),0);
});

test('install requires verified downloaded bytes and refuses subsequent file modifications',async t=>{
  const f=fixture(t);await assert.rejects(f.client.verifiedInstaller());
  await f.client.check();const result=await f.client.download();
  assert.equal(await f.client.verifiedInstaller(),result.file);
  fs.writeFileSync(result.file,'changed');await assert.rejects(f.client.verifiedInstaller(),/已改变/);
});
