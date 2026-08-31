export async function onRequestPost(context){
  try{
    const b=await context.request.json();
    if(!b.session_id||!b.event)return json({ok:true,persisted:false});
    if(!context.env.MINITOOL_TRACKING)return json({ok:true,persisted:false});
    const key=`session:${String(b.session_id).slice(0,120)}`;
    const old=await context.env.MINITOOL_TRACKING.get(key,'json')||{events:{},created_at:new Date().toISOString()};
    old.events=old.events||{};
    old.events[String(b.event).slice(0,80)]=b.ts||new Date().toISOString();
    old.last_event=String(b.event).slice(0,80);
    old.last_seen=b.ts||new Date().toISOString();
    old.path=String(b.path||'').slice(0,300);
    if(b.extra&&typeof b.extra==='object')old.last_extra=b.extra;
    await context.env.MINITOOL_TRACKING.put(key,JSON.stringify(old),{expirationTtl:60*60*24*90});
    return json({ok:true,persisted:true});
  }catch(e){return json({ok:false},200)}
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
