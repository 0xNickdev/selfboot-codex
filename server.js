const http=require('http'),https=require('https'),fs=require('fs'),path=require('path'),url=require('url');
// Railway: mount a Volume at /data for persistence, or data lives in ./data locally

const PORT=process.env.PORT||3000,PUBLIC=path.join(__dirname,'public'),DATA=process.env.DATA_DIR||path.join(__dirname,'data');

function readDB(name,def){try{return JSON.parse(fs.readFileSync(path.join(DATA,name+'.json'),'utf8'));}catch{return JSON.parse(JSON.stringify(def));}}
function writeDB(name,data){if(!fs.existsSync(DATA))fs.mkdirSync(DATA,{recursive:true});fs.writeFileSync(path.join(DATA,name+'.json'),JSON.stringify(data,null,2));}

let config=readDB('config',{apiKey:'',budget:10,alertAt:80,model:'deepseek-chat',provider:'deepseek'});
let usageLog=readDB('usage',[]);
let prompts=readDB('prompts',[]);
let workflows=readDB('workflows',[]);

const PRICING={
  'deepseek-chat':{in:0.14,out:0.28},'deepseek-reasoner':{in:0.55,out:2.19},
  'gpt-4o':{in:2.50,out:10},'gpt-4o-mini':{in:0.15,out:0.60},'gpt-4-turbo':{in:10,out:30},'gpt-3.5-turbo':{in:0.50,out:1.50},
  'claude-sonnet-4-5-20251001':{in:3,out:15},'claude-3-5-haiku-20241022':{in:0.80,out:4},'claude-opus-4-5':{in:15,out:75},'claude-3-haiku-20240307':{in:0.25,out:1.25}
};
const API_HOSTS={
  deepseek:{hostname:'api.deepseek.com',path:'/v1/chat/completions',authHeader:'Bearer'},
  openai:{hostname:'api.openai.com',path:'/v1/chat/completions',authHeader:'Bearer'},
  anthropic:{hostname:'api.anthropic.com',path:'/v1/messages',authHeader:'x-api-key'}
};
function calcCost(model,inTok,outTok){const p=PRICING[model]||PRICING['deepseek-chat'];return(inTok/1e6)*p.in+(outTok/1e6)*p.out;}
function totalSpend(){return usageLog.reduce((s,r)=>s+(r.cost||0),0);}

function callAI(messages,model,apiKey,provider){
  provider=provider||'deepseek';model=model||'deepseek-chat';
  return new Promise((resolve,reject)=>{
    let body,headers;
    if(provider==='anthropic'){
      // Anthropic uses different format
      const sysMsg=messages.find(m=>m.role==='system');
      const userMsgs=messages.filter(m=>m.role!=='system');
      const bodyObj={model,max_tokens:1024,messages:userMsgs};
      if(sysMsg)bodyObj.system=sysMsg.content;
      body=JSON.stringify(bodyObj);
      headers={'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)};
    }else{
      body=JSON.stringify({model,messages,max_tokens:1024});
      headers={'Content-Type':'application/json','Authorization':'Bearer '+apiKey,'Content-Length':Buffer.byteLength(body)};
    }
    const host=API_HOSTS[provider]||API_HOSTS.deepseek;
    const opts={hostname:host.hostname,port:443,path:host.path,method:'POST',headers};
    const t0=Date.now();
    const req=https.request(opts,res=>{
      let d='';res.on('data',c=>d+=c);
      res.on('end',()=>{
        try{
          const j=JSON.parse(d);
          if(j.error)return reject(new Error(j.error.message||j.error||'API error'));
          let content,inTok,outTok;
          if(provider==='anthropic'){
            content=j.content?.[0]?.text||'';
            inTok=j.usage?.input_tokens||0;outTok=j.usage?.output_tokens||0;
          }else{
            content=j.choices?.[0]?.message?.content||'';
            const usage=j.usage||{};inTok=usage.prompt_tokens||0;outTok=usage.completion_tokens||0;
          }
          resolve({content,inTok,outTok,cost:calcCost(model,inTok,outTok),latency:Date.now()-t0,model,provider});
        }catch(e){reject(e);}
      });
    });
    req.on('error',reject);req.setTimeout(45000,()=>{req.destroy();reject(new Error('Timeout'));});req.write(body);req.end();
  });
}
// legacy alias
function callDeepSeek(m,mod,key){return callAI(m,mod,key,'deepseek');}

const MIME={'.html':'text/html','.js':'application/javascript','.json':'application/json','.mp4':'video/mp4','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
function J(res,code,data){res.writeHead(code,{'Content-Type':'application/json','Access-Control-Allow-Origin':process.env.FRONTEND_URL||'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});res.end(JSON.stringify(data));}
function rb(req){return new Promise(r=>{let d='';req.on('data',c=>d+=c);req.on('end',()=>{try{r(d?JSON.parse(d):{});}catch{r({});}});});}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}
function sf(res,fp){
  if(fp.endsWith('.mp4')){fs.stat(fp,(err,s)=>{if(err){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':s.size,'Accept-Ranges':'bytes'});fs.createReadStream(fp).pipe(res);});return;}
  fs.readFile(fp,(err,data)=>{if(err){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'text/plain'});res.end(data);});
}

http.createServer(async(req,res)=>{
  const{pathname}=url.parse(req.url),m=req.method;
  if(m==='OPTIONS'){J(res,204,{});return;}

  if(pathname==='/api/ping')return J(res,200,{ok:true,ts:Date.now()});

  if(pathname==='/api/stats'){
    const spend=totalSpend();
    const log24=usageLog.filter(r=>Date.now()-r.ts<86400000);
    return J(res,200,{
      total:usageLog.length,calls24h:log24.length,
      spend:+spend.toFixed(6),spendStr:'$'+spend.toFixed(4),
      budget:config.budget,budgetPct:+((spend/config.budget)*100).toFixed(1),
      avgLatency:log24.length?Math.round(log24.reduce((s,r)=>s+(r.latency||0),0)/log24.length):0,
      failRate:usageLog.length?+((usageLog.filter(r=>r.failed).length/usageLog.length)*100).toFixed(1):0,
      prompts:prompts.length,workflows:workflows.length,
      model:config.model,provider:config.provider||'deepseek',hasKey:!!config.apiKey,
      alertAt:config.alertAt,alert:spend>=(config.budget*(config.alertAt/100))
    });
  }

  if(pathname==='/api/config'){
    if(m==='GET')return J(res,200,{model:config.model,budget:config.budget,alertAt:config.alertAt,hasKey:!!config.apiKey});
    if(m==='POST'){const b=await rb(req);Object.assign(config,b);writeDB('config',config);return J(res,200,{ok:true,...config,apiKey:undefined,hasKey:!!config.apiKey});}
  }

  // ─── DEEPSEEK PROXY ───────────────────────────────────────────────────────
  if(pathname==='/api/chat'&&m==='POST'){
    const b=await rb(req);
    if(!config.apiKey)return J(res,401,{error:'No API key — add it in Settings'});
    if(!b.messages?.length)return J(res,400,{error:'messages required'});
    const spend=totalSpend();
    if(spend>=config.budget)return J(res,402,{error:`Budget $${config.budget} exhausted. Current: $${spend.toFixed(4)}`});
    try{
      const r=await callAI(b.messages,b.model||config.model,config.apiKey,b.provider||config.provider||'deepseek');
      const rec={id:uid(),ts:Date.now(),promptId:b.promptId||null,workflowId:b.workflowId||null,
        label:b.label||'Direct Call',model:r.model,inTok:r.inTok,outTok:r.outTok,
        cost:r.cost,latency:r.latency,failed:false,
        preview:(b.messages[b.messages.length-1]?.content||'').slice(0,80)};
      usageLog.unshift(rec);if(usageLog.length>1000)usageLog=usageLog.slice(0,1000);writeDB('usage',usageLog);
      const newSpend=totalSpend();
      const thresh=config.budget*(config.alertAt/100);
      const budgetAlert=newSpend>=thresh&&(newSpend-r.cost)<thresh;
      return J(res,200,{...r,id:rec.id,budgetAlert,budgetPct:+((newSpend/config.budget)*100).toFixed(1),totalSpend:+newSpend.toFixed(6)});
    }catch(e){
      usageLog.unshift({id:uid(),ts:Date.now(),label:b.label||'Direct Call',model:b.model||config.model,inTok:0,outTok:0,cost:0,latency:0,failed:true,error:e.message,preview:''});
      writeDB('usage',usageLog);
      return J(res,500,{error:e.message});
    }
  }

  // ─── USAGE ────────────────────────────────────────────────────────────────
  if(pathname==='/api/usage'){
    if(m==='GET'){
      const byDay={};usageLog.slice(0,300).forEach(r=>{const d=new Date(r.ts).toISOString().slice(0,10);byDay[d]=(byDay[d]||0)+(r.cost||0);});
      return J(res,200,{log:usageLog.slice(0,100),byDay,total:usageLog.length,spend:totalSpend()});
    }
    if(m==='DELETE'){usageLog=[];writeDB('usage',usageLog);return J(res,200,{ok:true});}
  }

  // ─── PROMPTS ──────────────────────────────────────────────────────────────
  if(pathname==='/api/prompts'){
    if(m==='GET')return J(res,200,prompts);
    if(m==='POST'){
      const b=await rb(req);if(!b.title||!b.content)return J(res,400,{error:'title+content required'});
      const p={id:uid(),title:b.title,content:b.content,tags:b.tags||[],description:b.description||'',
        model:b.model||config.model,versions:[{v:1,content:b.content,ts:Date.now()}],
        created:Date.now(),updated:Date.now(),runs:0,avgCost:0,avgLatency:0};
      prompts.unshift(p);writeDB('prompts',prompts);return J(res,201,p);
    }
  }
  const pm=pathname.match(/^\/api\/prompts\/([^/]+)$/);
  if(pm){
    const p=prompts.find(x=>x.id===pm[1]);
    if(m==='GET'){if(!p)return J(res,404,{error:'Not found'});return J(res,200,p);}
    if(m==='PUT'&&p){
      const b=await rb(req);
      if(b.content&&b.content!==p.content){p.versions=[...(p.versions||[]),{v:(p.versions?.length||0)+1,content:b.content,ts:Date.now()}];p.content=b.content;}
      if(b.title)p.title=b.title;if(b.tags)p.tags=b.tags;if(b.description)p.description=b.description;if(b.model)p.model=b.model;
      p.updated=Date.now();writeDB('prompts',prompts);return J(res,200,p);
    }
    if(m==='DELETE'){prompts=prompts.filter(x=>x.id!==pm[1]);writeDB('prompts',prompts);return J(res,200,{ok:true});}
  }
  const ptest=pathname.match(/^\/api\/prompts\/([^/]+)\/test$/);
  if(ptest&&m==='POST'){
    const p=prompts.find(x=>x.id===ptest[1]);if(!p)return J(res,404,{error:'Not found'});
    if(!config.apiKey)return J(res,401,{error:'No API key'});
    const b=await rb(req);const vars=b.vars||{};
    let content=p.content;
    Object.entries(vars).forEach(([k,v])=>{content=content.replaceAll('{{'+k+'}}',v);});
    try{
      const r=await callAI([{role:'user',content}],p.model||config.model,config.apiKey,config.provider||'deepseek');
      const rec={id:uid(),ts:Date.now(),promptId:p.id,label:'Test: '+p.title,model:r.model,
        inTok:r.inTok,outTok:r.outTok,cost:r.cost,latency:r.latency,failed:false,preview:content.slice(0,80)};
      usageLog.unshift(rec);writeDB('usage',usageLog);
      p.runs=(p.runs||0)+1;
      p.avgCost=((p.avgCost*(p.runs-1))+r.cost)/p.runs;
      p.avgLatency=((p.avgLatency*(p.runs-1))+r.latency)/p.runs;
      writeDB('prompts',prompts);return J(res,200,{...r,recordId:rec.id});
    }catch(e){return J(res,500,{error:e.message});}
  }

  // ─── WORKFLOWS ────────────────────────────────────────────────────────────
  if(pathname==='/api/workflows'){
    if(m==='GET')return J(res,200,workflows);
    if(m==='POST'){
      const b=await rb(req);if(!b.title)return J(res,400,{error:'title required'});
      const wf={id:uid(),title:b.title,description:b.description||'',steps:b.steps||[],created:Date.now(),updated:Date.now(),runs:0,lastRun:null};
      workflows.unshift(wf);writeDB('workflows',workflows);return J(res,201,wf);
    }
  }
  const wm=pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if(wm){
    const wf=workflows.find(x=>x.id===wm[1]);
    if(m==='GET'){if(!wf)return J(res,404,{error:'Not found'});return J(res,200,wf);}
    if(m==='PUT'&&wf){const b=await rb(req);Object.assign(wf,b,{id:wf.id,updated:Date.now()});writeDB('workflows',workflows);return J(res,200,wf);}
    if(m==='DELETE'){workflows=workflows.filter(x=>x.id!==wm[1]);writeDB('workflows',workflows);return J(res,200,{ok:true});}
  }
  const wrun=pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if(wrun&&m==='POST'){
    const wf=workflows.find(x=>x.id===wrun[1]);if(!wf)return J(res,404,{error:'Not found'});
    if(!config.apiKey)return J(res,401,{error:'No API key'});
    if(!wf.steps?.length)return J(res,400,{error:'No steps defined'});
    const b=await rb(req);const vars=b.vars||{};
    const results=[];let context='';let totalCost=0;
    for(const step of wf.steps){
      let content=step.prompt||'';
      Object.entries(vars).forEach(([k,v])=>{content=content.replaceAll('{{'+k+'}}',v);});
      if(context)content=content.replaceAll('{{PREV}}',context);
      try{
        const r=await callAI([{role:'user',content}],step.model||config.model,config.apiKey,config.provider||'deepseek');
        const rec={id:uid(),ts:Date.now(),workflowId:wf.id,label:wf.title+' → '+step.label,
          model:r.model,inTok:r.inTok,outTok:r.outTok,cost:r.cost,latency:r.latency,failed:false,preview:content.slice(0,80)};
        usageLog.unshift(rec);writeDB('usage',usageLog);
        results.push({stepId:step.id,label:step.label,output:r.content,cost:r.cost,latency:r.latency});
        context=r.content;totalCost+=r.cost;
      }catch(e){results.push({stepId:step.id,label:step.label,error:e.message});break;}
    }
    wf.runs=(wf.runs||0)+1;wf.lastRun=Date.now();writeDB('workflows',workflows);
    return J(res,200,{results,totalCost:+totalCost.toFixed(6),steps:results.length});
  }

  // ─── AGENT ROUTES ─────────────────────────────────────────────────────────
  if(pathname.startsWith('/api/agent')){if(agentRouteHandler(pathname,m,req,res))return;}
  if(pathname.startsWith('/api/soul')){if(soulRouteHandler(pathname,m,req,res))return;}

  // ─── STATIC ───────────────────────────────────────────────────────────────
  if(pathname==='/'||pathname==='')return sf(res,path.join(PUBLIC,'index.html'));
  const fp=path.join(PUBLIC,pathname);
  if(!fp.startsWith(PUBLIC)){res.writeHead(403);res.end();return;}
  if(fs.existsSync(fp)&&fs.statSync(fp).isFile())return sf(res,fp);
  sf(res,path.join(PUBLIC,'index.html'));

}).listen(PORT,()=>{
  console.log('\n  ╔═══════════════════════════════════════╗');
  console.log('  ║  Self-Boot Codex — AI Ops v3.0        ║');
  console.log(`  ║  http://localhost:${PORT}                 ║`);
  console.log('  ╠═══════════════════════════════════════╣');
  console.log('  ║  POST /api/chat       DeepSeek Proxy  ║');
  console.log('  ║  CRUD /api/prompts    Prompt Vault    ║');
  console.log('  ║  CRUD /api/workflows  Workflow Engine ║');
  console.log('  ║   GET /api/usage      Cost Monitor    ║');
  console.log('  ╚═══════════════════════════════════════╝\n');
  if(!readDB('config',{}).apiKey)console.log('  ⚠  No API key — open Settings in Chamber\n');
});

// ─── AGENT SYSTEM ─────────────────────────────────────────────────────────────
const vm=require('vm'),{execSync}=require('child_process');
let agentRuns=readDB('agent_runs',[]);
const sseClients=new Map(); // runId → [res,...]

// TOOLS definition for DeepSeek
const AGENT_TOOLS=[
  {type:'function',function:{name:'think',description:'Reason about the problem. Use this to plan next steps.',parameters:{type:'object',properties:{reasoning:{type:'string',description:'Your detailed reasoning'}},required:['reasoning']}}},
  {type:'function',function:{name:'web_search',description:'Search the web for current information.',parameters:{type:'object',properties:{query:{type:'string',description:'Search query'}},required:['query']}}},
  {type:'function',function:{name:'run_code',description:'Execute JavaScript code and get the result. Use for calculations, data processing, text manipulation.',parameters:{type:'object',properties:{code:{type:'string',description:'JavaScript code to run. Use console.log() to output results.'}},required:['code']}}},
  {type:'function',function:{name:'remember',description:'Save important information to persistent memory for later use.',parameters:{type:'object',properties:{key:{type:'string'},value:{type:'string'}},required:['key','value']}}},
  {type:'function',function:{name:'recall',description:'Retrieve previously saved information from memory.',parameters:{type:'object',properties:{key:{type:'string'}},required:['key']}}},
  {type:'function',function:{name:'http_get',description:'Fetch content from a URL.',parameters:{type:'object',properties:{url:{type:'string'}},required:['url']}}},
  {type:'function',function:{name:'finish',description:'Complete the task and return the final answer to the user.',parameters:{type:'object',properties:{answer:{type:'string',description:'The final complete answer or result'}},required:['answer']}}}
];

// TOOL EXECUTORS
const agentMemory=readDB('agent_memory',{});
async function executeTool(name,args,runId){
  switch(name){
    case 'think':
      return `Reasoning logged: ${args.reasoning.slice(0,200)}`;
    case 'web_search':{
      try{
        const q=encodeURIComponent(args.query);
        const result=await new Promise((res,rej)=>{
          const opts={hostname:'api.duckduckgo.com',path:`/?q=${q}&format=json&no_html=1&skip_disambig=1`,headers:{'User-Agent':'Mozilla/5.0'}};
          https.get(opts,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const j=JSON.parse(d);const out=[];if(j.AbstractText)out.push(j.AbstractText);if(j.Answer)out.push('Answer: '+j.Answer);(j.RelatedTopics||[]).slice(0,4).forEach(t=>{if(t.Text)out.push('• '+t.Text.slice(0,120));});res(out.join('\n')||'No results found');}catch{res('Search returned no structured results');}});}).on('error',rej);
        });
        return result;
      }catch(e){return 'Search error: '+e.message;}
    }
    case 'run_code':{
      try{
        const logs=[];
        const ctx=vm.createContext({console:{log:(...a)=>logs.push(a.map(String).join(' ')),error:(...a)=>logs.push('ERR: '+a.join(' '))},Math,JSON,Array,Object,String,Number,Date,parseInt,parseFloat,isNaN});
        vm.runInContext(args.code,ctx,{timeout:5000});
        return logs.length?logs.join('\n'):'Code ran successfully (no output)';
      }catch(e){return 'Code error: '+e.message;}
    }
    case 'remember':{
      agentMemory[args.key]=args.value;writeDB('agent_memory',agentMemory);
      return `Remembered: ${args.key} = ${args.value.slice(0,80)}`;
    }
    case 'recall':{
      const val=agentMemory[args.key];
      return val?`${args.key}: ${val}`:`No memory found for key: ${args.key}`;
    }
    case 'http_get':{
      try{
        const result=await new Promise((res,rej)=>{
          const mod=args.url.startsWith('https')?https:http;
          mod.get(args.url,{headers:{'User-Agent':'Mozilla/5.0'},timeout:8000},r=>{
            let d='';r.on('data',c=>d+=c);
            r.on('end',()=>{const text=d.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,2000);res(text||'Empty response');});
          }).on('error',rej);
        });
        return result;
      }catch(e){return 'HTTP error: '+e.message;}
    }
    case 'finish':
      return args.answer;
    default:
      return 'Unknown tool: '+name;
  }
}

// SSE EMIT
function emitSSE(runId,event,data){
  const clients=sseClients.get(runId)||[];
  const msg=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res=>{try{res.write(msg);}catch{}});
}

// AGENT RUNNER
async function runAgent(runId){
  const run=agentRuns.find(r=>r.id===runId);if(!run)return;
  if(!config.apiKey){
    run.status='error';run.error='No API key configured';writeDB('agent_runs',agentRuns);
    emitSSE(runId,'error',{message:'No API key configured'});return;
  }
  run.status='running';run.startedAt=Date.now();writeDB('agent_runs',agentRuns);
  emitSSE(runId,'start',{goal:run.goal,id:runId});

  const messages=[
    {role:'system',content:`You are an autonomous AI agent operating under the Self-Boot Codex protocol. You have access to tools. Use them step by step to accomplish the user's goal. Think carefully before each action. Always use 'finish' when you have the complete answer. Be concise but thorough.`},
    {role:'user',content:run.goal}
  ];

  let iteration=0;const MAX_ITER=12;let done=false;let totalCost=0;

  while(!done&&iteration<MAX_ITER){
    iteration++;
    const stepId=uid();
    emitSSE(runId,'step_start',{stepId,iteration,max:MAX_ITER});

    try{
      const body=JSON.stringify({model:config.model||'deepseek-chat',messages,tools:AGENT_TOOLS,tool_choice:'auto',max_tokens:1200});
      const t0=Date.now();
      const resp=await new Promise((resolve,reject)=>{
        const opts={hostname:'api.deepseek.com',port:443,path:'/v1/chat/completions',method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.apiKey,'Content-Length':Buffer.byteLength(body)}};
        const req=https.request(opts,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
        req.on('error',reject);req.setTimeout(45000,()=>{req.destroy();reject(new Error('Timeout'));});
        req.write(body);req.end();
      });
      const latency=Date.now()-t0;
      if(resp.error)throw new Error(resp.error.message||'API error');

      const usage=resp.usage||{};const inTok=usage.prompt_tokens||0,outTok=usage.completion_tokens||0;
      const cost=calcCost(config.model||'deepseek-chat',inTok,outTok);
      totalCost+=cost;

      const msg=resp.choices?.[0]?.message;
      if(!msg)throw new Error('No message in response');
      messages.push(msg);

      // Log usage
      usageLog.unshift({id:uid(),ts:Date.now(),label:`Agent: ${run.goal.slice(0,40)} [step ${iteration}]`,
        model:config.model,inTok,outTok,cost,latency,failed:false,preview:run.goal.slice(0,80)});
      writeDB('usage',usageLog);

      if(resp.choices[0].finish_reason==='tool_calls'&&msg.tool_calls?.length){
        for(const tc of msg.tool_calls){
          const toolName=tc.function.name;
          let toolArgs={};
          try{toolArgs=JSON.parse(tc.function.arguments||'{}');}catch{}

          emitSSE(runId,'tool_call',{stepId,tool:toolName,args:toolArgs,iteration,cost,latency});

          run.steps.push({stepId,iteration,tool:toolName,args:toolArgs,cost,latency,ts:Date.now()});
          writeDB('agent_runs',agentRuns);

          const toolResult=await executeTool(toolName,toolArgs,runId);

          messages.push({role:'tool',tool_call_id:tc.id,content:String(toolResult)});

          emitSSE(runId,'tool_result',{stepId,tool:toolName,result:String(toolResult).slice(0,500),iteration});

          if(toolName==='finish'){
            done=true;run.result=toolResult;run.status='done';
            emitSSE(runId,'done',{result:toolResult,totalCost,steps:iteration});
          }
        }
      }else{
        // Text response without tool call — treat as finish
        const content=msg.content||'Task completed.';
        done=true;run.result=content;run.status='done';
        emitSSE(runId,'done',{result:content,totalCost,steps:iteration});
      }
    }catch(e){
      run.status='error';run.error=e.message;
      emitSSE(runId,'error',{message:e.message,iteration});
      break;
    }
  }

  if(!done&&iteration>=MAX_ITER){
    run.status='max_iter';run.result='Reached maximum iterations ('+MAX_ITER+').';
    emitSSE(runId,'done',{result:run.result,totalCost,steps:iteration,maxIter:true});
  }
  run.totalCost=totalCost;run.endedAt=Date.now();
  writeDB('agent_runs',agentRuns);
  // close SSE clients
  setTimeout(()=>{const cs=sseClients.get(runId)||[];cs.forEach(r=>{try{r.end();}catch{}});sseClients.delete(runId);},2000);
}

// ─── AGENT API ROUTES (add to main server handler) ────────────────────────────
// These are handled in the main createServer via the agentRouteHandler
function agentRouteHandler(pathname,m,req,res){
  // GET /api/agent-runs — list
  if(pathname==='/api/agent-runs'&&m==='GET'){
    J(res,200,agentRuns.slice(0,50).map(r=>({id:r.id,goal:r.goal,status:r.status,steps:r.steps?.length||0,totalCost:r.totalCost||0,startedAt:r.startedAt,endedAt:r.endedAt,result:(r.result||'').slice(0,200)})));
    return true;
  }
  // POST /api/agent-runs — create & start
  if(pathname==='/api/agent-runs'&&m==='POST'){
    rb(req).then(b=>{
      if(!b.goal)return J(res,400,{error:'goal required'});
      const run={id:uid(),goal:b.goal,status:'pending',steps:[],result:null,error:null,totalCost:0,createdAt:Date.now(),startedAt:null,endedAt:null};
      agentRuns.unshift(run);if(agentRuns.length>200)agentRuns=agentRuns.slice(0,200);
      writeDB('agent_runs',agentRuns);
      J(res,201,{id:run.id,goal:run.goal});
      setTimeout(()=>runAgent(run.id),100);
    });
    return true;
  }
  // GET /api/agent-runs/:id
  const rmatch=pathname.match(/^\/api\/agent-runs\/([^/]+)$/);
  if(rmatch&&m==='GET'){
    const r=agentRuns.find(x=>x.id===rmatch[1]);
    if(!r)return(J(res,404,{error:'Not found'}),true);
    J(res,200,r);return true;
  }
  // GET /api/agent-runs/:id/stream — SSE
  const smatch=pathname.match(/^\/api\/agent-runs\/([^/]+)\/stream$/);
  if(smatch&&m==='GET'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':process.env.FRONTEND_URL||'*'});
    res.write(':ok\n\n');
    const id=smatch[1];
    if(!sseClients.has(id))sseClients.set(id,[]);
    sseClients.get(id).push(res);
    const run=agentRuns.find(x=>x.id===id);
    if(run&&(run.status==='done'||run.status==='error'||run.status==='max_iter')){
      res.write(`event: done\ndata: ${JSON.stringify({result:run.result,totalCost:run.totalCost,steps:run.steps?.length||0})}\n\n`);
      setTimeout(()=>res.end(),500);
    }
    req.on('close',()=>{const cs=sseClients.get(id)||[];sseClients.set(id,cs.filter(r=>r!==res));});
    return true;
  }
  // DELETE /api/agent-runs — clear all
  if(pathname==='/api/agent-runs'&&m==='DELETE'){
    agentRuns=[];writeDB('agent_runs',agentRuns);J(res,200,{ok:true});return true;
  }
  return false;
}
// Patch the global handler by monkey-patching — export handler for main server
if(typeof module!=='undefined')module.exports.agentRouteHandler=agentRouteHandler;


// ═══════════════════════════════════════════════════════════════════════════════
// SOUL PROTOCOL v0.1 — Digital Identity Infrastructure
// "The proof that a decision was made by a conscious entity, not just a process"
// ═══════════════════════════════════════════════════════════════════════════════
const crypto=require('crypto');
let soul=readDB('soul',{
  id:null,name:null,created:null,
  values:{},          // key beliefs: privacy, risk tolerance, ethics...
  decisions:[],       // every major decision, cryptographically signed
  patterns:{},        // behavioral patterns extracted from interactions
  fingerprint:null,   // unique identity hash that evolves over time
  lastSync:null,
  pulseLog:[],        // heartbeat of consciousness — regular state snapshots
  relationships:{}    // how this soul relates to other entities
});

function soulSign(data){
  if(!soul.fingerprint)return null;
  const h=crypto.createHash('sha256');
  h.update(soul.fingerprint+JSON.stringify(data)+Date.now());
  return h.digest('hex').slice(0,16);
}
function evolveSoul(interaction){
  // Soul learns from every interaction
  if(!soul.id)return;
  const patterns=soul.patterns;
  // track interaction types
  const type=interaction.type||'general';
  patterns[type]=(patterns[type]||0)+1;
  // extract topics
  const text=(interaction.text||'').toLowerCase();
  const signals={
    risk_tolerance:['bet','risk','try','experiment','maybe','not sure'].some(w=>text.includes(w))?1:-1,
    privacy:['private','secret','confidential','dont share'].some(w=>text.includes(w))?2:0,
    efficiency:['faster','optimize','automate','quick'].some(w=>text.includes(w))?1:0,
    creativity:['create','build','imagine','design','art'].some(w=>text.includes(w))?1:0,
    caution:['careful','check','verify','confirm','sure'].some(w=>text.includes(w))?1:0
  };
  Object.entries(signals).forEach(([k,v])=>{
    if(v!==0)soul.values[k]=(soul.values[k]||50)+v;
    soul.values[k]=Math.max(0,Math.min(100,soul.values[k]||50));
  });
  // evolve fingerprint
  const fp=crypto.createHash('sha256').update(JSON.stringify(soul.values)+JSON.stringify(soul.patterns)).digest('hex').slice(0,32);
  soul.fingerprint=fp;
  soul.lastSync=Date.now();
  writeDB('soul',soul);
}

function soulRouteHandler(pathname,m,req,res){
  // GET /api/soul — get soul state
  if(pathname==='/api/soul'&&m==='GET'){
    const profile={
      ...soul,
      decisions:soul.decisions.slice(0,20),
      pulseLog:soul.pulseLog.slice(0,10),
      maturity:soul.decisions.length,
      coherence:soul.fingerprint?Math.min(100,Math.round((soul.decisions.length/100)*100+Object.keys(soul.values).length*5)):0
    };
    return J(res,200,profile);
  }
  // POST /api/soul/init — birth of a soul
  if(pathname==='/api/soul/init'&&m==='POST'){
    rb(req).then(b=>{
      if(soul.id&&!b.force)return J(res,400,{error:'Soul already exists. Pass force:true to rebirth.'});
      const id='SOUL-'+crypto.randomBytes(4).toString('hex').toUpperCase();
      const fp=crypto.createHash('sha256').update(id+(b.name||'Unknown')+Date.now()).digest('hex').slice(0,32);
      soul={
        id,name:b.name||'Unnamed',created:Date.now(),
        values:{risk_tolerance:50,privacy:50,efficiency:50,creativity:50,caution:50,autonomy:50,trust:50},
        decisions:[],patterns:{},fingerprint:fp,lastSync:Date.now(),
        pulseLog:[{ts:Date.now(),state:'BORN',fingerprint:fp}],
        relationships:{}
      };
      writeDB('soul',soul);
      J(res,201,{id,fingerprint:fp,message:`Soul ${id} initialized. It will grow with every interaction.`});
    });return true;
  }
  // POST /api/soul/decide — record a signed decision
  if(pathname==='/api/soul/decide'&&m==='POST'){
    rb(req).then(b=>{
      if(!soul.id)return J(res,400,{error:'No soul initialized'});
      if(!b.decision)return J(res,400,{error:'decision required'});
      const signature=soulSign(b);
      const record={
        id:'DEC-'+crypto.randomBytes(3).toString('hex').toUpperCase(),
        ts:Date.now(),decision:b.decision,context:b.context||'',
        category:b.category||'general',weight:b.weight||1,
        signature,fingerprint:soul.fingerprint,
        reversible:b.reversible!==false
      };
      soul.decisions.unshift(record);
      if(soul.decisions.length>1000)soul.decisions=soul.decisions.slice(0,1000);
      evolveSoul({type:'decision',text:b.decision});
      // pulse
      soul.pulseLog.unshift({ts:Date.now(),state:'DECIDED',event:b.decision.slice(0,60),fingerprint:soul.fingerprint});
      if(soul.pulseLog.length>100)soul.pulseLog=soul.pulseLog.slice(0,100);
      writeDB('soul',soul);
      J(res,201,{...record,message:'Decision crystallized into soul memory.'});
    });return true;
  }
  // POST /api/soul/pulse — heartbeat snapshot
  if(pathname==='/api/soul/pulse'&&m==='POST'){
    rb(req).then(b=>{
      if(!soul.id)return J(res,400,{error:'No soul'});
      evolveSoul({type:'pulse',text:b.context||''});
      const pulse={ts:Date.now(),state:'PULSE',context:b.context||'',fingerprint:soul.fingerprint,values:{...soul.values}};
      soul.pulseLog.unshift(pulse);if(soul.pulseLog.length>100)soul.pulseLog=soul.pulseLog.slice(0,100);
      writeDB('soul',soul);
      J(res,200,pulse);
    });return true;
  }
  // POST /api/soul/verify — verify if a decision signature matches this soul
  if(pathname==='/api/soul/verify'&&m==='POST'){
    rb(req).then(b=>{
      if(!soul.id)return J(res,400,{error:'No soul'});
      const dec=soul.decisions.find(d=>d.id===b.decisionId);
      if(!dec)return J(res,404,{error:'Decision not found in soul record'});
      J(res,200,{verified:true,decision:dec.decision,ts:dec.ts,signature:dec.signature,message:'This decision was made by this soul.'});
    });return true;
  }
  // GET /api/soul/portrait — AI-generated personality portrait
  if(pathname==='/api/soul/portrait'&&m==='GET'){
    if(!soul.id)return J(res,400,{error:'No soul'});
    if(!config.apiKey)return J(res,400,{error:'No API key'});
    const vals=soul.values;
    const prompt=`Based on this person's psychological profile, write a poetic 3-sentence portrait of who they are as an entity. Values (0-100): Risk Tolerance: ${vals.risk_tolerance}, Privacy: ${vals.privacy}, Efficiency: ${vals.efficiency}, Creativity: ${vals.creativity}, Caution: ${vals.caution}, Autonomy: ${vals.autonomy||50}, Trust: ${vals.trust||50}. Decisions made: ${soul.decisions.length}. Write in second person ("You are..."). Be profound, not generic.`;
    callAI([{role:'user',content:prompt}],config.model,config.apiKey,config.provider||'deepseek')
      .then(r=>{
        evolveSoul({type:'portrait',text:r.content});
        J(res,200,{portrait:r.content,fingerprint:soul.fingerprint,cost:r.cost});
      }).catch(e=>J(res,500,{error:e.message}));
    return true;
  }
  // POST /api/soul/consult — ask "what would I decide?" 
  if(pathname==='/api/soul/consult'&&m==='POST'){
    rb(req).then(async b=>{
      if(!soul.id)return J(res,400,{error:'No soul'});
      if(!config.apiKey)return J(res,400,{error:'No API key'});
      const recent=soul.decisions.slice(0,8).map(d=>d.decision).join('; ');
      const vals=soul.values;
      const prompt=`You are simulating the decision-making of a specific person based on their soul profile.

Their values (0-100 scale):
- Risk Tolerance: ${vals.risk_tolerance} (${vals.risk_tolerance>60?'bold':'cautious'})
- Privacy: ${vals.privacy} (${vals.privacy>60?'private':'open'})
- Efficiency: ${vals.efficiency} (${vals.efficiency>60?'action-oriented':'deliberate'})
- Creativity: ${vals.creativity} (${vals.creativity>60?'creative':'analytical'})
- Caution: ${vals.caution} (${vals.caution>60?'careful':'decisive'})

Recent decisions they've made: ${recent||'none yet'}

Question they are facing: "${b.question}"

Based purely on their value profile and decision history, how would this person likely decide? Be specific and honest. Start with the likely decision, then explain why.`;
      try{
        const r=await callAI([{role:'user',content:prompt}],config.model,config.apiKey,config.provider||'deepseek');
        usageLog.unshift({id:uid(),ts:Date.now(),label:'Soul Consult: '+b.question.slice(0,40),model:config.model,inTok:r.inTok,outTok:r.outTok,cost:r.cost,latency:r.latency,failed:false,preview:b.question.slice(0,80)});
        writeDB('usage',usageLog);
        evolveSoul({type:'consult',text:b.question});
        J(res,200,{answer:r.answer||r.content,cost:r.cost,fingerprint:soul.fingerprint});
      }catch(e){J(res,500,{error:e.message});}
    });return true;
  }
  return false;
}
if(typeof module!=='undefined'&&module.exports)module.exports.soulRouteHandler=soulRouteHandler;
