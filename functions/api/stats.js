export async function onRequestGet(context){
  try{
    if(!context.env.MINITOOL_TRACKING)return json({error:'Tracking opslag is niet gekoppeld.'},500);
    if(context.env.STATS_TOKEN){
      const auth=context.request.headers.get('Authorization')||'';
      if(auth!==`Bearer ${context.env.STATS_TOKEN}`)return json({error:'Niet toegestaan.'},401);
    }
    const counts={page_opened:0,scan_started:0,question_1_completed:0,question_2_completed:0,question_3_completed:0,question_4_completed:0,question_5_completed:0,advice_viewed:0,offer_clicked:0,form_opened:0,form_completed:0};
    let cursor, total=0;
    do{
      const list=await context.env.MINITOOL_TRACKING.list({prefix:'session:',cursor,limit:1000});
      for(const k of list.keys){
        const s=await context.env.MINITOOL_TRACKING.get(k.name,'json');
        if(!s)continue; total++;
        const ev=s.events||{};
        for(const name of Object.keys(counts))if(ev[name]||s[name]===true)counts[name]++;
      }
      cursor=list.list_complete?undefined:list.cursor;
    }while(cursor);
    return json({sessions:total,funnel:counts,dropoff:{after_start:Math.max(0,counts.scan_started-counts.question_1_completed),after_q1:Math.max(0,counts.question_1_completed-counts.question_2_completed),after_q2:Math.max(0,counts.question_2_completed-counts.question_3_completed),after_q3:Math.max(0,counts.question_3_completed-counts.question_4_completed),after_q4:Math.max(0,counts.question_4_completed-counts.question_5_completed),after_advice:Math.max(0,counts.advice_viewed-counts.offer_clicked),after_offer:Math.max(0,counts.offer_clicked-counts.form_completed)}});
  }catch(e){return json({error:e.message||'Statistieken konden niet worden geladen.'},500)}
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
