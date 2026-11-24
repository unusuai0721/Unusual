'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),data=path.join(root,'data');
function folder(...parts){const dir=path.join(data,...parts);fs.mkdirSync(dir,{recursive:true});return dir;}
process.env.NAPCAT_QQ_DATA_DIR=folder('qq');
process.env.NAPCAT_WORKDIR=folder('napcat');
process.env.TEMP=process.env.TMP=folder('temp');
process.env.USERPROFILE=folder('bridge-profile');
process.env.APPDATA=folder('bridge-profile','Roaming');
process.env.LOCALAPPDATA=folder('bridge-profile','Local');
process.env.NAPCAT_DISABLE_TIME_SYNC='1';
process.env.NAPCAT_DISABLE_MULTI_PROCESS='1';
process.env.NAPCAT_DISABLE_PIPE='1';
const parent=Number(process.env.QILIAO_PARENT_PID);
if(parent>0)setInterval(()=>{try{process.kill(parent,0);}catch{process.exit(0);}},4000).unref();
require(path.join(root,'components/napcat-4.18.42/index.js'));
