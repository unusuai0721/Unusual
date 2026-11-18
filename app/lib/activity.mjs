// Local SQL aggregates only: no model calls and no copies of message content.
export function activityReport(store, requestedDays=7, now=Date.now()) {
 const days=Number(requestedDays);
 if(![1,7,30].includes(days))throw Object.assign(Error('统计范围只能是 1、7 或 30 天'),{status:400});
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 const start=new Date(Date.parse(today+'T00:00:00+08:00')-(days-1)*86400000);
 const startDay=new Date(start.getTime()+8*3600000).toISOString().slice(0,10);
 const sums='COALESCE(SUM(inputTokens),0) AS inputTokens,COALESCE(SUM(outputTokens),0) AS outputTokens,COUNT(*) AS calls,COALESCE(SUM(estimated),0) AS estimatedCalls';
 const query=(dimension)=>store.prepare('SELECT '+dimension+', '+sums+' FROM usage WHERE day>=? AND day<=? GROUP BY '+dimension+' ORDER BY SUM(inputTokens+outputTokens) DESC LIMIT 50').all(startDay,today);
 const total=store.prepare('SELECT '+sums+' FROM usage WHERE day>=? AND day<=?').get(startDay,today);
 const rows=query('day'),byDay=new Map(rows.map(r=>[r.day,r]));
 const daily=Array.from({length:days},(_,i)=>{const day=new Date(start.getTime()+8*3600000+i*86400000).toISOString().slice(0,10);return byDay.get(day)||{day,inputTokens:0,outputTokens:0,calls:0,estimatedCalls:0};});
 const from=start.toISOString(),to=new Date(now).toISOString();
 const traceStages=store.prepare('SELECT stage,COUNT(*) AS count FROM message_trace WHERE createdAt>=? AND createdAt<=? GROUP BY stage').all(from,to);
 const issues=store.prepare("SELECT t.groupId,t.messageId,t.stage,t.detail,t.createdAt,(SELECT MAX(m.id) FROM messages m WHERE m.groupId=t.groupId AND m.messageId=t.messageId AND m.role='user' AND m.source='qq') AS historyId FROM message_trace t WHERE (t.stage IN ('failed','voice_fallback','image_failed','image_skipped') OR (t.stage='cancelled' AND t.detail='queue_expired')) AND t.createdAt>=? AND t.createdAt<=? ORDER BY t.id DESC LIMIT 30").all(from,to);
 return {days,fromDay:startDay,toDay:today,generatedAt:to,total,daily,bySession:query('groupId'),byProvider:query('providerId'),byKind:query('kind'),traceStages,issues};
}
