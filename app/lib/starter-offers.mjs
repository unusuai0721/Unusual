import fs from 'node:fs';
import {bundleAvailable, bundleEnabled, importBundle} from './bundled-emoji.mjs';

const personaFile='app/resources/starter-personas.json';
const offerKeys=['personas','emoji'];
const key=(kind,choice)=>'starter-offers:'+kind+':'+choice;

export function starterOffers(store){
  return {
    personas: {
      available:fs.existsSync(store.paths.resolve(personaFile)),
      imported:store.getMeta(key('personas','imported'),false)===true,
      never:store.getMeta(key('personas','never'),false)===true,
    },
    emoji: {
      available:bundleAvailable(store),
      imported:bundleEnabled(store),
      never:store.getMeta(key('emoji','never'),false)===true,
    },
  };
}

export function chooseStarterOffer(store,media,kind,choice){
  if(!offerKeys.includes(kind)||!['import','never'].includes(choice))
    throw Object.assign(new Error('无效的导入选项'),{status:400});
  const state=starterOffers(store)[kind];
  if(!state.available)throw Object.assign(new Error('未找到随包资源'),{status:404});
  if(choice==='never'){
    store.setMeta(key(kind,'never'),true);
    return {};
  }
  if(kind==='emoji')return importBundle(store,media);
  if(state.imported)return {added:0};
  const cards=JSON.parse(fs.readFileSync(store.paths.resolve(personaFile),'utf8'));
  const config=store.config;
  const added=cards.filter(card=>!config.personas.some(existing=>existing.id===card.id));
  if(added.length){
    config.personas.push(...added);
    store.saveConfig(config);
  }
  store.setMeta(key(kind,'imported'),true);
  return {added:added.length};
}
