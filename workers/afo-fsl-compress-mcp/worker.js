const VERSION="0.2.0";
const WORKER_NAME="afo-fsl-compress-mcp";
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,Mcp-Session-Id'};

const STOP=new Set(['the','and','for','that','with','this','from','are','was','were','have','has','not','but','you','your','can','will','all','any','its','our','out','use','via','def','self','int','str']);

const SIGNAL_RULES=[
  {label:'Cloudflare Worker Environment', domain:'Runtime', signals:['slug','env','const','kv','ctx','fetch','request','await']},
  {label:'UI Template Strings (inline HTML/CSS)', domain:'UI', signals:['div','rem','class','font','border','span','btn','label']},
  {label:'D1 / SQL Database', domain:'Database', signals:['sql','select','insert','update','query','table','schema','prepare','d1']},
  {label:'KV Storage', domain:'Database', signals:['kv','namespace','put','delete']},
  {label:'Request Routing / Handlers', domain:'Routing', signals:['router','route','path','handler','method','url']},
  {label:'Authentication', domain:'Auth', signals:['auth','token','jwt','session','login','password','oauth','cookie']},
  {label:'React Frontend', domain:'UI', signals:['usestate','useeffect','react','component','props','jsx']},
  {label:'Python Runtime', domain:'Runtime', signals:['def','self','import','elif']}
];

function classifySignals(freqMap){
  const results=[];
  for(const rule of SIGNAL_RULES){
    let score=0, matched=[];
    for(const sig of rule.signals){ if(freqMap[sig]){ score+=freqMap[sig]; matched.push(sig); } }
    if(score>0) results.push({label:rule.label, domain:rule.domain, score, matched});
  }
  results.sort((a,b)=>b.score-a.score);
  return results;
}

function classifyFile(p){
  const ext=(p.split('.').pop()||'').toLowerCase();
  if(['py','js','ts','jsx','tsx','go','rs','java','c','cpp','rb','php','sh'].includes(ext))return'C';
  if(['json','yaml','yml','toml','ini','cfg','env'].includes(ext))return'G';
  if(['csv','tsv','sql'].includes(ext))return'D';
  if(['md','txt','rst'].includes(ext))return'P';
  if(p.toUpperCase().includes('LICENSE'))return'L';
  return'P';
}

function keywordsWithOffsets(text,n){
  const counts={}, firstOffset={};
  const lower=text.toLowerCase();
  const re=/[a-z_][a-z0-9_]{2,}/g;
  let m;
  while((m=re.exec(lower))){
    const w=m[0];
    if(STOP.has(w))continue;
    counts[w]=(counts[w]||0)+1;
    if(firstOffset[w]===undefined) firstOffset[w]=m.index;
  }
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([w,c])=>w+':'+c+':'+firstOffset[w]).join(',');
}

async function ghFetch(env,url,accept){
  return fetch(url,{headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:accept||'application/vnd.github+json','User-Agent':'fsl-compress-mcp'}});
}

function byteLen(s){ return new TextEncoder().encode(s).length; }

function parseKwTriple(pair){
  const parts=pair.split(':');
  return {term:parts[0]||'', count:Number(parts[1]||1), offset:Number(parts[2]||0)};
}

function buildTree(rows){
  const root={_count:0,_bytes:0};
  rows.forEach((r,i)=>{
    const segs=r.file_path.split('/');
    let node=root;
    for(let d=0; d<segs.length-1; d++){
      const seg=segs[d];
      if(!node[seg]) node[seg]={_count:0,_bytes:0};
      node=node[seg];
      node._count+=1;
      node._bytes+=r.orig_bytes;
    }
    node[segs[segs.length-1]]={chunk_id:r.chunk_id, n:i+1, type:r.chunk_type, bytes:r.orig_bytes};
  });
  root._count=rows.length;
  root._bytes=rows.reduce((a,r)=>a+r.orig_bytes,0);
  return root;
}

function codexCompact(path, codexRows){
  let p=path;
  const sorted=[...codexRows].sort((a,b)=>b.term.length-a.term.length);
  for(const c of sorted){ p=p.split(c.term).join(c.dash_code); }
  return p;
}

const TOOLS=[
{
  "name":"afo-fsl-compress_status",
  "description":"Health check. Returns version, all binding statuses, and tool list.",
  "inputSchema":{"type":"object","properties":{},"required":[]}
},
{
  "name":"compress_repo",
  "description":"Cursor-aware: fetches GitHub repo tree, classifies each file (P/C/L/G/D), extracts keyword frequency+first-offset per file, stores raw content in R2 keyed deterministically by repo+branch+path (idempotent re-runs), rebuilds the full dash-codex from the complete current chunk set after every batch, and indexes everything in D1.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"},
    "path":{"type":"string"},"max_files":{"type":"number","default":20},"offset":{"type":"number","default":0}
  }}
},
{
  "name":"query_compressed",
  "description":"Keyword/term search against the D1 chunk index for a compressed repo. Returns chunk locations and metadata, not full content (near-zero token cost).",
  "inputSchema":{"type":"object","required":["owner","repo","term"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"},
    "term":{"type":"string"},"limit":{"type":"number","default":20}
  }}
},
{
  "name":"decompress_chunk",
  "description":"Selective decompression: fetches the full raw content of a specific chunk (by chunk_id or file_path) from R2. This is the only operation that costs full tokens for that content.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"},
    "chunk_id":{"type":"string"},"file_path":{"type":"string"}
  }}
},
{
  "name":"get_codex",
  "description":"Returns the dash-codex (repeated path segment dictionary) and global keyword frequency table for a compressed repo - the structural map without any file content.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}
  }}
},
{
  "name":"compression_stats",
  "description":"Returns the latest compression job stats for a repo/branch: ratio, byte counts, file counts, status.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}
  }}
},
{
  "name":"list_chunks",
  "description":"Discovery without decompression or keyword search: reads file paths, chunk ids, byte sizes, and the path-level dash-codex directly from the D1 manifest, returning a nested directory tree (with per-directory file_count/byte aggregates) plus a flat codex-compacted listing.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}
  }}
},
{
  "name":"get_feature_vector",
  "description":"Standardized single-step analytics block: file/byte/ratio totals, top-15 global keyword density, and heuristic framework/runtime/database/UI signal classification derived from keyword vectors.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}
  }}
},
{
  "name":"generate_v4readme",
  "description":"Builds and stores the .v4readme: a <2000-byte LLM-native spatial index containing a header+feature-vector, the global dash-codex mapping, a hyperlinked repo tree with [cN:bBYTES] chunk coordinates, and a domain-grouped (UI/Database/Routing/Auth) semantic lookup matrix with [cN:oOFFSET] pointers. Stored in R2 at fsl/{owner}/{repo}/{branch}/.v4readme. Greedily trims matrix then tree entries to stay under budget.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}
  }}
},
{
  "name":"get_v4readme",
  "description":"Retrieves the previously generated .v4readme for a repo/branch from R2 (run generate_v4readme first).",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}
  }}
}
];

function rpc(id,r){return Response.json({jsonrpc:"2.0",id,result:r},{headers:CORS});}
function errResp(id,c,m){return Response.json({jsonrpc:"2.0",id,error:{code:c,message:m}},{headers:CORS});}
function tool(id,r){return rpc(id,{content:[{type:"text",text:JSON.stringify(r,null,2)}]});}
function genId(p){return p+"_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);}
function nowIso(){return new Date().toISOString();}
async function dbRun(db,sql,p){const s=db.prepare(sql);return p?s.bind(...p).run():s.run();}
async function dbAll(db,sql,p){const s=db.prepare(sql);const r=p?await s.bind(...p).all():await s.all();return r.results||[];}
async function ensureSchema(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS mcp_sessions (session_id TEXT PRIMARY KEY,worker_name TEXT NOT NULL,status TEXT DEFAULT 'active',parent_id TEXT,metadata TEXT,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,finished_at TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS action_execution_logs (log_id TEXT PRIMARY KEY,session_id TEXT,worker_name TEXT NOT NULL,tool_name TEXT NOT NULL,status TEXT NOT NULL,input_json TEXT,output_summary TEXT,payload_uri TEXT,error_message TEXT,duration_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,vector_id TEXT,created_at TEXT NOT NULL)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (migration_id TEXT PRIMARY KEY,worker_name TEXT NOT NULL,description TEXT,applied_at TEXT NOT NULL,checksum TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS fsl_jobs (job_id TEXT PRIMARY KEY, repo_key TEXT, branch TEXT, sha TEXT, files_found INTEGER, files_compressed INTEGER, orig_bytes INTEGER, compressed_bytes INTEGER, ratio REAL, status TEXT, created_at TEXT, updated_at TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS fsl_chunks (chunk_id TEXT PRIMARY KEY, repo_key TEXT, branch TEXT, file_path TEXT, chunk_type TEXT, orig_bytes INTEGER, top_keywords TEXT, r2_key TEXT, created_at TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS fsl_codex (repo_key TEXT, branch TEXT, dash_code TEXT, term TEXT, PRIMARY KEY (repo_key, branch, dash_code))`).run();
}

async function handle(name,args,env,ctx){
  if(name==="afo-fsl-compress_status"){
    const res={status:"ok",worker:WORKER_NAME,version:VERSION,generated_at:new Date().toISOString(),bindings:{},tools:TOOLS.map(t=>t.name)};
    try{await ensureSchema(env.DB);res.bindings.DB=true;}catch{res.bindings.DB=false;}
    res.bindings.R2=!!env.FSL_STORE;
    return res;
  }
  await ensureSchema(env.DB);

  if(name==="compress_repo"){
    const {owner,repo}=args;
    if(!owner) throw new Error("compress_repo: owner required");
    if(!repo) throw new Error("compress_repo: repo required");
    const branch=args.branch||'main', root=args.path||'';
    const repoKey=owner+'/'+repo;
    const max=Math.max(1,Math.min(args.max_files||20,30));
    const offset=Math.max(0,Math.floor(args.offset||0));
    const jobId=genId('fsl'), ts=nowIso();

    const ref=await ghFetch(env,'https://api.github.com/repos/'+owner+'/'+repo+'/git/ref/heads/'+encodeURIComponent(branch));
    let commit='unknown';
    if(ref.ok){ const j=await ref.json(); commit=(j.object&&j.object.sha)||'unknown'; }

    const treeRes=await ghFetch(env,'https://api.github.com/repos/'+owner+'/'+repo+'/git/trees/'+encodeURIComponent(branch)+'?recursive=1');
    if(!treeRes.ok) throw new Error('GitHub tree fetch failed '+treeRes.status);
    const tj=await treeRes.json();

    const badExt=new Set(['png','jpg','jpeg','gif','ico','woff','woff2','ttf','pdf','zip','wasm','bin','mp4','mov','lock']);
    const badDir=['node_modules/','.git/','.wrangler/','dist/','build/','.next/','venv/','__pycache__/'];
    let files=(tj.tree||[]).filter(f=>f.type==='blob' && (!root || f.path.startsWith(root)) && f.size<150000 && !badDir.some(d=>f.path.includes(d)) && !badExt.has((f.path.split('.').pop()||'').toLowerCase()))
      .map(f=>({path:f.path,size:f.size,sha:f.sha})).sort((a,b)=>a.path.localeCompare(b.path));

    const batch=files.slice(offset,offset+max);
    const next=offset+batch.length, done=next>=files.length;

    await dbRun(env.DB,'INSERT INTO fsl_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[jobId,repoKey,branch,commit.slice(0,12),files.length,0,0,0,0,'running',ts,ts]);

    let compressedCount=0;
    for(const file of batch){
      const enc=file.path.split('/').map(encodeURIComponent).join('/');
      const raw=await fetch('https://raw.githubusercontent.com/'+owner+'/'+repo+'/'+encodeURIComponent(branch)+'/'+enc,{headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,'User-Agent':'fsl-compress-mcp'}});
      if(!raw.ok) continue;
      const txt=await raw.text();
      if(!txt.trim()) continue;
      const ctype=classifyFile(file.path);
      const kw=keywordsWithOffsets(txt,8);
      const chunkId=repoKey+'::'+branch+'::'+file.path;
      const r2Key='fsl/'+repoKey+'/'+branch+'/raw/'+file.path;
      await env.FSL_STORE.put(r2Key,txt);
      await dbRun(env.DB,'INSERT OR REPLACE INTO fsl_chunks VALUES (?,?,?,?,?,?,?,?,?)',[chunkId,repoKey,branch,file.path,ctype,txt.length,kw,r2Key,nowIso()]);
      compressedCount++;
    }

    const allRows=await dbAll(env.DB,'SELECT file_path,orig_bytes,top_keywords FROM fsl_chunks WHERE repo_key=? AND branch=?',[repoKey,branch]);
    let totalOrig=0, totalCompressed=0;
    const pathCounts={};
    for(const r of allRows){
      totalOrig+=r.orig_bytes;
      totalCompressed+=(r.top_keywords||'').length+r.file_path.length+20;
      for(const seg of r.file_path.split('/')){ if(seg.length>3) pathCounts[seg]=(pathCounts[seg]||0)+1; }
    }
    await dbRun(env.DB,'DELETE FROM fsl_codex WHERE repo_key=? AND branch=?',[repoKey,branch]);
    let dashLevel=3;
    for(const [term,count] of Object.entries(pathCounts).sort((a,b)=>b[1]-a[1])){
      if(count<2) continue;
      await dbRun(env.DB,'INSERT INTO fsl_codex VALUES (?,?,?,?)',[repoKey,branch,'-'.repeat(dashLevel),term]);
      dashLevel++;
      if(dashLevel>20) break;
    }

    const ratio=totalOrig>0?(totalOrig/Math.max(totalCompressed,1)):0;
    await dbRun(env.DB,'UPDATE fsl_jobs SET files_compressed=?,orig_bytes=?,compressed_bytes=?,ratio=?,status=?,updated_at=? WHERE job_id=?',
      [allRows.length,totalOrig,totalCompressed,ratio,done?'complete':'partial',nowIso(),jobId]);

    return {ok:true,job_id:jobId,repo:repoKey,branch,sha:commit.slice(0,12),files_found:files.length,files_compressed_this_batch:compressedCount,total_chunks_indexed:allRows.length,next_offset:next,done,orig_bytes:totalOrig,compressed_bytes:totalCompressed,ratio:Number(ratio.toFixed(2))};
  }

  if(name==="query_compressed"){
    const {owner,repo,term}=args;
    if(!owner) throw new Error("query_compressed: owner required");
    if(!repo) throw new Error("query_compressed: repo required");
    if(!term) throw new Error("query_compressed: term required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo, termLower=(term||'').toLowerCase();
    const limit=Math.min(args.limit||20,50);
    const rows=await dbAll(env.DB,'SELECT chunk_id,file_path,chunk_type,top_keywords,orig_bytes FROM fsl_chunks WHERE repo_key=? AND branch=? AND (lower(top_keywords) LIKE ? OR lower(file_path) LIKE ?) LIMIT ?',
      [repoKey,branch,'%'+termLower+'%','%'+termLower+'%',limit]);
    return {ok:true,repo:repoKey,branch,term:termLower,count:rows.length,matches:rows};
  }

  if(name==="decompress_chunk"){
    const {owner,repo}=args;
    if(!owner) throw new Error("decompress_chunk: owner required");
    if(!repo) throw new Error("decompress_chunk: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    let row;
    if(args.chunk_id){ const rows=await dbAll(env.DB,'SELECT * FROM fsl_chunks WHERE chunk_id=? LIMIT 1',[args.chunk_id]); row=rows[0]; }
    else if(args.file_path){ const rows=await dbAll(env.DB,'SELECT * FROM fsl_chunks WHERE repo_key=? AND branch=? AND file_path=? LIMIT 1',[repoKey,branch,args.file_path]); row=rows[0]; }
    if(!row) return {ok:false,error:'chunk not found'};
    const obj=await env.FSL_STORE.get(row.r2_key);
    if(!obj) return {ok:false,error:'blob missing in R2'};
    const text=await obj.text();
    return {ok:true,chunk_id:row.chunk_id,file_path:row.file_path,chunk_type:row.chunk_type,orig_bytes:row.orig_bytes,content:text};
  }

  if(name==="get_codex"){
    const {owner,repo}=args;
    if(!owner) throw new Error("get_codex: owner required");
    if(!repo) throw new Error("get_codex: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    const codex=await dbAll(env.DB,'SELECT dash_code,term FROM fsl_codex WHERE repo_key=? AND branch=? ORDER BY length(dash_code)',[repoKey,branch]);
    const chunks=await dbAll(env.DB,'SELECT chunk_type,top_keywords FROM fsl_chunks WHERE repo_key=? AND branch=?',[repoKey,branch]);
    const freq={};
    for(const c of chunks){ for(const pair of (c.top_keywords||'').split(',')){ const kt=parseKwTriple(pair); if(kt.term) freq[kt.term]=(freq[kt.term]||0)+kt.count; } }
    const topGlobal=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,25).map(e=>e[0]+':'+e[1]);
    return {ok:true,repo:repoKey,branch,codex,global_keywords:topGlobal,chunk_count:chunks.length};
  }

  if(name==="compression_stats"){
    const {owner,repo}=args;
    if(!owner) throw new Error("compression_stats: owner required");
    if(!repo) throw new Error("compression_stats: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    const rows=await dbAll(env.DB,'SELECT * FROM fsl_jobs WHERE repo_key=? AND branch=? ORDER BY created_at DESC LIMIT 1',[repoKey,branch]);
    if(!rows.length) return {ok:false,error:'no job found for this repo/branch'};
    return {ok:true,job:rows[0]};
  }

  if(name==="list_chunks"){
    const {owner,repo}=args;
    if(!owner) throw new Error("list_chunks: owner required");
    if(!repo) throw new Error("list_chunks: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    const codexRows=await dbAll(env.DB,'SELECT dash_code,term FROM fsl_codex WHERE repo_key=? AND branch=?',[repoKey,branch]);
    const rows=await dbAll(env.DB,'SELECT chunk_id,file_path,chunk_type,orig_bytes FROM fsl_chunks WHERE repo_key=? AND branch=? ORDER BY file_path',[repoKey,branch]);
    if(!rows.length) return {ok:false,error:'no chunks found; run compress_repo first'};
    const tree=buildTree(rows);
    const flat=rows.map((r,i)=>({n:i+1,path:r.file_path,compact:codexCompact(r.file_path,codexRows),type:r.chunk_type,bytes:r.orig_bytes,chunk_id:r.chunk_id}));
    return {ok:true,repo:repoKey,branch,total_files:rows.length,total_bytes:tree._bytes,codex_used:codexRows,tree,flat};
  }

  if(name==="get_feature_vector"){
    const {owner,repo}=args;
    if(!owner) throw new Error("get_feature_vector: owner required");
    if(!repo) throw new Error("get_feature_vector: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    const jobs=await dbAll(env.DB,'SELECT * FROM fsl_jobs WHERE repo_key=? AND branch=? ORDER BY created_at DESC LIMIT 1',[repoKey,branch]);
    if(!jobs.length) return {ok:false,error:'no compression job found; run compress_repo first'};
    const job=jobs[0];
    const chunks=await dbAll(env.DB,'SELECT chunk_type,top_keywords,orig_bytes FROM fsl_chunks WHERE repo_key=? AND branch=?',[repoKey,branch]);
    const freq={}, typeCounts={};
    for(const c of chunks){
      typeCounts[c.chunk_type]=(typeCounts[c.chunk_type]||0)+1;
      for(const pair of (c.top_keywords||'').split(',')){ const kt=parseKwTriple(pair); if(kt.term) freq[kt.term]=(freq[kt.term]||0)+kt.count; }
    }
    const topKeywords=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([term,count])=>({term,count}));
    const signals=classifySignals(freq).slice(0,8);
    return {
      ok:true, repo:repoKey, branch,
      file_count:job.files_compressed,
      raw_bytes:job.orig_bytes,
      compressed_bytes:job.compressed_bytes,
      compression_ratio:Number(Number(job.ratio).toFixed(2)),
      chunk_type_breakdown:typeCounts,
      top_keywords:topKeywords,
      detected_signals:signals
    };
  }

  if(name==="generate_v4readme"){
    const {owner,repo}=args;
    if(!owner) throw new Error("generate_v4readme: owner required");
    if(!repo) throw new Error("generate_v4readme: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    const jobs=await dbAll(env.DB,'SELECT * FROM fsl_jobs WHERE repo_key=? AND branch=? ORDER BY created_at DESC LIMIT 1',[repoKey,branch]);
    if(!jobs.length) return {ok:false,error:'no compression job found; run compress_repo first'};
    const job=jobs[0];
    const codexRows=await dbAll(env.DB,'SELECT dash_code,term FROM fsl_codex WHERE repo_key=? AND branch=? ORDER BY length(dash_code)',[repoKey,branch]);
    const chunks=await dbAll(env.DB,'SELECT chunk_id,file_path,chunk_type,orig_bytes,top_keywords FROM fsl_chunks WHERE repo_key=? AND branch=? ORDER BY file_path',[repoKey,branch]);
    if(!chunks.length) return {ok:false,error:'no chunks found; run compress_repo first'};

    const freq={};
    chunks.forEach((c,ci)=>{
      for(const pair of (c.top_keywords||'').split(',')){
        const kt=parseKwTriple(pair);
        if(!kt.term) continue;
        if(!freq[kt.term]) freq[kt.term]={count:0,chunk_idx:ci+1,offset:kt.offset,file_path:c.file_path};
        freq[kt.term].count+=kt.count;
      }
    });
    const flatFreq=Object.fromEntries(Object.entries(freq).map(([k,v])=>[k,v.count]));
    const signals=classifySignals(flatFreq);

    const lines=[];
    lines.push('\u00a7V4README\u00a7'+repoKey+'@'+branch);
    lines.push('sha:'+(job.sha||'?')+' files:'+job.files_compressed+' raw:'+job.orig_bytes+' cmp:'+job.compressed_bytes+' ratio:'+Number(job.ratio).toFixed(1)+'x');
    lines.push('signals:'+signals.slice(0,4).map(s=>s.label).join(';'));

    lines.push('-CODEX-');
    for(const c of codexRows) lines.push(c.dash_code+'='+c.term);

    lines.push('-TREE-');
    const treeStart=lines.length;
    chunks.forEach((c,ci)=>{
      lines.push(codexCompact(c.file_path,codexRows)+' [c'+(ci+1)+':b'+c.orig_bytes+']');
    });

    lines.push('-MATRIX-');
    const domains={};
    for(const rule of SIGNAL_RULES){
      for(const sig of rule.signals){
        if(freq[sig]){
          domains[rule.domain]=domains[rule.domain]||[];
          domains[rule.domain].push({term:sig,chunk:freq[sig].chunk_idx,offset:freq[sig].offset,count:freq[sig].count});
        }
      }
    }
    const matrixStart=lines.length;
    for(const [domain,terms] of Object.entries(domains)){
      terms.sort((a,b)=>b.count-a.count);
      const top=terms.slice(0,3);
      lines.push(domain+':'+top.map(t=>t.term+'->[c'+t.chunk+':o'+t.offset+']').join(','));
    }

    let truncated=false;
    let doc=lines.join('\n');
    const BUDGET=2000;
    while(byteLen(doc)>BUDGET && lines.length>treeStart+1){
      if(lines.length>matrixStart+1 && lines[lines.length-1].includes('->[')){ lines.pop(); truncated=true; }
      else if(lines.length>treeStart+1){ lines.splice(treeStart+1,1); truncated=true; }
      else break;
      doc=lines.join('\n');
    }

    const r2Key='fsl/'+repoKey+'/'+branch+'/.v4readme';
    await env.FSL_STORE.put(r2Key,doc);

    return {ok:true,repo:repoKey,branch,r2_key:r2Key,byte_size:byteLen(doc),truncated,content:doc};
  }

  if(name==="get_v4readme"){
    const {owner,repo}=args;
    if(!owner) throw new Error("get_v4readme: owner required");
    if(!repo) throw new Error("get_v4readme: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    const r2Key='fsl/'+repoKey+'/'+branch+'/.v4readme';
    const obj=await env.FSL_STORE.get(r2Key);
    if(!obj) return {ok:false,error:'.v4readme not found; run generate_v4readme first'};
    const text=await obj.text();
    return {ok:true,repo:repoKey,branch,r2_key:r2Key,byte_size:byteLen(text),content:text};
  }

  throw new Error("Unknown tool: "+name);
}

export default {
  async fetch(request,env,ctx){
    if(request.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
    const url=new URL(request.url);
    if(url.pathname==="/health") return Response.json({status:"ok",worker:WORKER_NAME,version:VERSION},{headers:CORS});
    if(request.method!=="POST") return new Response("not found",{status:404,headers:CORS});
    let body;
    try{ body=await request.json(); }catch{ return errResp(null,-32700,"Parse error"); }
    const {id,method,params}=body;
    if(method==="initialize") return rpc(id,{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:WORKER_NAME,version:VERSION}});
    if(method==="notifications/initialized") return new Response(null,{status:204,headers:CORS});
    if(method==="ping") return rpc(id,{});
    if(method==="tools/list") return rpc(id,{tools:TOOLS});
    if(method==="tools/call"){
      try{ return tool(id,await handle(params?.name,params?.arguments||{},env,ctx)); }
      catch(e){ return errResp(id,-32603,"Tool error: "+e.message); }
    }
    return errResp(id,-32601,"Method not found: "+method);
  }
};
