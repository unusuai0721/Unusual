import { searchWeb } from './adapters.mjs';

export async function momentSources(config, query, now=Date.now()){
  if(config?.enabled && (config.type==='searxng'||config.apiKey)){
    const date=new Date(now).toISOString().slice(0,10);
    const results=await searchWeb(config,date+' 最近一周 有趣新闻 '+query);
    return results.slice(0,3);
  }
  const url=new URL('https://hn.algolia.com/api/v1/search');
  url.searchParams.set('tags','story');
  url.searchParams.set('numericFilters','created_at_i>'+Math.floor(now/1000-7*86400)+',points>30');
  url.searchParams.set('hitsPerPage','20');
  const response=await fetch(url,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('科技新闻搜索失败 '+response.status);
  const {hits}=await response.json();
  const articles=hits.filter(h=>h.title&&/^https?:\/\//.test(h.url)&&h.created_at_i>now/1000-7*86400);
  const offset=Math.floor(Math.random()*Math.max(1,articles.length-2));
  return articles.slice(offset,offset+3).map(h=>({title:h.title,url:h.url,content:'近期在 Hacker News 讨论，提交时间 '+h.created_at}));
}
