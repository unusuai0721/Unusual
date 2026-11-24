import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../app/lib/store.mjs';
import {Media} from '../app/lib/media.mjs';
import {bundleEnabled,importBundle} from '../app/lib/bundled-emoji.mjs';

test('bundled ZIP stays dormant until activation and coexists with custom pictures and tags', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unusual-emoji-'));
  const store=new Store(root),media=new Media(store);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  store.paths.ensureDir('app/resources');
  const file=store.paths.resolve('app/resources/emoji-starter.zip');
  fs.copyFileSync(new URL('../app/resources/emoji-starter.zip',import.meta.url),file);
  assert.equal(bundleEnabled(store),false);assert.deepEqual(media.listEmoji(),[]);
  const existing=store.paths.mediaPath('emoji','file_3242128.webp');
  fs.writeFileSync(existing,'user-owned');media.setTags({name:'file_3242128.webp',tags:['个人']});
  assert.equal(importBundle(store,media).added,73);
  assert.equal(media.listEmoji().length,74);
  assert.equal(fs.readFileSync(existing,'utf8'),'user-owned');
  assert.deepEqual(media.listEmoji().find(x=>x.name==='file_3242128.webp').tags,['个人']);
  assert.equal(bundleEnabled(store),true);
  assert.equal(importBundle(store,media).added,0);
});
