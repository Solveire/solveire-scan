export async function onRequestPost(context){
  try{
    const body=await context.request.json();
    const required=['name','company','phone','email'];
    for(const key of required){if(!String(body[key]||'').trim())return json({error:`${key} ontbreekt`},400)}
    if(!context.env.DISCORD_WEBHOOK_URL)return json({error:'Discord koppeling ontbreekt.'},500);
    const a=body.answers||{};
    const fields=[
      ['Naam',body.name],['Bedrijf',body.company],['Telefoon',body.phone],['E-mail',body.email],
      ['Advies',body.recommendation||'Mini Tool'],['Knelpunt',a.q1?.label||'—'],['Tijdverlies',a.q2?.label||'—'],
      ['Doel',a.q3?.label||'—'],['Voor wie',a.q4?.label||'—'],['Uitkomst',a.q5?.label||'—'],['Prijs','€199']
    ].map(([name,value])=>({name,value:String(value).slice(0,1024),inline:false}));
    const payload={
      username:'Solveire Mini Tool',
      embeds:[{
        title:'🔥 Nieuwe Mini Tool-aanvraag',
        description:'Nieuwe maatwerkplek via de Mini Tool scan.',
        color:11922223,
        fields,
        footer:{text:'Opvolging: binnen 24 uur'},
        timestamp:new Date().toISOString()
      }]
    };
    const r=await fetch(context.env.DISCORD_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok)return json({error:'Discord melding kon niet worden verstuurd.'},502);
    if(context.env.MINITOOL_TRACKING&&body.session_id){
      const key=`session:${body.session_id}`;
      const old=await context.env.MINITOOL_TRACKING.get(key,'json')||{};
      old.form_completed=true;old.completed_at=new Date().toISOString();old.recommendation=body.recommendation||null;
      await context.env.MINITOOL_TRACKING.put(key,JSON.stringify(old),{expirationTtl:60*60*24*90});
    }
    return json({ok:true});
  }catch(e){return json({error:e.message||'Aanvraag kon niet worden verwerkt.'},500)}
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
