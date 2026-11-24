import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {AppPaths} from '../app/lib/paths.mjs';
import {NapCat} from '../app/lib/napcat.mjs';
const {createComponent}=createRequire(import.meta.url)('../app/lib/napcat-component.cjs');

test('unrecognized or partial ZIP cannot install or activate a component',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unusual-component-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const p=new AppPaths(root),input=path.join(root,'other.zip');
  fs.writeFileSync(input,'unrecognized zip');
  let calls=0;
  const c=createComponent({own:r=>p.resolve(r),dir:r=>p.ensureDir(r),fetchImpl:async()=>{calls++;throw Error('unexpected request');}});
  await assert.rejects(c.install(input),/校验不匹配/);
  assert.equal(calls,0);assert.deepEqual(c.status(),{installed:false,progress:''});
  assert.deepEqual(fs.readdirSync(path.join(root,'components')),[]);
  assert.equal(fs.existsSync(path.join(root,'data/napcat-managed.json')),false);
});

test('component callback, API and WebUI use ports belonging to the same instance',()=>{
  const n=new NapCat({get config(){return {onebot:{accessToken:'access',webhookToken:'events'}};}},{basePort:4210});
  const net=n.desiredConfig().network;
  assert.equal(n.apiUrl,'http://127.0.0.1:4212');
  assert.equal(net.httpServers[0].port,4212);
  assert.equal(net.httpClients[0].url,'http://127.0.0.1:4210/onebot/events');
  assert.equal(net.httpClients[0].token,'events');
});
