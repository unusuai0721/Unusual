import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const input=process.argv[2];
if(!input)throw Error('用法：node scripts/import-memes.mjs <memes.db>');
const columns=['title','slug','tags','usage','origin','other','summary','aliases'];
const db=new DatabaseSync(input,{readOnly:true,allowExtension:false});
try {
  const rows=db.prepare('SELECT '+columns.join(',')+' FROM memes ORDER BY title LIMIT 6669').all();
  if(rows.length!==6668||rows.some(row=>columns.some(key=>row[key]!==null&&typeof row[key]!=='string'))){
    throw Error('仅支持 dsh-memewiki 0.1.2 的 6668 条格式');
  }
  const folder=fileURLToPath(new URL('../app/resources/',import.meta.url));
  fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(fileURLToPath(new URL('../app/resources/memewiki.json.gz',import.meta.url)),gzipSync(JSON.stringify({version:'0.1.2',rows})),{flag:'wx'});
  console.log('已准备 '+rows.length+' 条本地词条。下次启动会导入。');
}finally{db.close();}
