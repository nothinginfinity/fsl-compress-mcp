const VERSION="0.4.2";
const V4README_FORMAT_VERSION="0.3.0";
const WORKER_NAME="afo-fsl-compress-mcp";
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,Mcp-Session-Id'};

const STOP=new Set(['the','and','for','that','with','this','from','are','was','were','have','has','not','but','you','your','can','will','all','any','its','our','out','use','via','def','self','int','str']);

function testPythonRuntime(path,content){
  const ext=(path.split('.').pop()||'').toLowerCase();
  const base=path.split('/').pop();
  if(ext==='py') return true;
  if(['requirements.txt','pyproject.toml','Pipfile'].includes(base)) return true;
  if(/^#!.*\bpython[0-9.]*\b/.test(content.slice(0,80))) return true;
  return false;
}
function testJavaScriptRuntime(path,content){
  const ext=(path.split('.').pop()||'').toLowerCase();
  const base=path.split('/').pop();
  if(['js','mjs','cjs','ts','jsx','tsx'].includes(ext)) return true;
  if(base==='package.json') return true;
  if(/\brequire\s*\(/.test(content)) return true;
  if(/\bmodule\.exports\b/.test(content)) return true;
  if(/\bexport\s+default\b/.test(content)) return true;
  if(/\bexport\s*\{/.test(content)) return true;
  return false;
}
function testCloudflareWorker(path,content){
  const base=path.split('/').pop();
  if(['wrangler.toml','wrangler.jsonc','wrangler.json'].includes(base)) return true;
  if(/fetch\s*\(\s*request\s*,\s*env/.test(content)) return true;
  if(/export\s+default\s*\{[\s\S]{0,60}?fetch/.test(content)) return true;
  if(/\benv\.[A-Z_][A-Z0-9_]*\b/.test(content)) return true;
  return false;
}

const SIGNAL_RULES=[
  {label:'Python Runtime', domain:'Runtime', type:'file', test:testPythonRuntime},
  {label:'JavaScript Runtime', domain:'Runtime', type:'file', test:testJavaScriptRuntime},
  {label:'Cloudflare Worker Environment', domain:'Runtime', type:'file', test:testCloudflareWorker},
  {label:'UI Template Strings (inline HTML/CSS)', domain:'UI', type:'keyword', signals:['div','rem','class','font','border','span','btn','label']},
  {label:'D1 / SQL Database', domain:'Database', type:'keyword', signals:['sql','select','insert','update','query','table','schema','prepare','d1']},
  {label:'KV Storage', domain:'Database', type:'keyword', signals:['kv','namespace','put','delete']},
  {label:'Request Routing / Handlers', domain:'Routing', type:'keyword', signals:['router','route','path','handler','method','url']},
  {label:'Authentication', domain:'Auth', type:'keyword', signals:['auth','token','jwt','session','login','password','oauth','cookie']},
  {label:'React Frontend', domain:'UI', type:'keyword', signals:['usestate','useeffect','react','component','props','jsx']}
];

function detectFileSignals(path,content){
  const hits=[];
  for(const rule of SIGNAL_RULES){ if(rule.type==='file' && rule.test(path,content)) hits.push(rule.label); }
  return hits;
}

function classifySignals(freqMap,fileSignalCounts){
  const results=[];
  for(const rule of SIGNAL_RULES){
    if(rule.type==='file'){
      const score=(fileSignalCounts&&fileSignalCounts[rule.label])||0;
      if(score>0) results.push({label:rule.label,domain:rule.domain,score,matched:[score+' file(s)']});
    } else {
      let score=0, matched=[];
      for(const sig of rule.signals){ if(freqMap[sig]){ score+=freqMap[sig]; matched.push(sig); } }
      if(score>0) results.push({label:rule.label,domain:rule.domain,score,matched});
    }
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

function buildLineStarts(text){
  const starts=[0];
  for(let i=0;i<text.length;i++){ if(text.charCodeAt(i)===10) starts.push(i+1); }
  return starts;
}
function offsetToLine(lineStarts,offset){
  let lo=0, hi=lineStarts.length-1, ans=0;
  while(lo<=hi){ const mid=(lo+hi)>>1; if(lineStarts[mid]<=offset){ ans=mid; lo=mid+1; } else { hi=mid-1; } }
  return ans+1;
}
function keywordsWithLines(text,n){
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
  const lineStarts=buildLineStarts(text);
  const totalLines=lineStarts.length;
  const top=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,n);
  const triples=top.map(([w,c])=>w+':'+c+':'+offsetToLine(lineStarts,firstOffset[w])).join(',');
  return {triples,totalLines};
}
function parseKwEntry(pair){
  const parts=pair.split(':');
  return {term:parts[0]||'', count:Number(parts[1]||1), line:Number(parts[2]||1)};
}

async function ghFetch(env,url,accept){
  return fetch(url,{headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:accept||'application/vnd.github+json','User-Agent':'fsl-compress-mcp'}});
}
function byteLen(s){ return new TextEncoder().encode(s).length; }

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
function utf8ToBase64(str){ return btoa(unescape(encodeURIComponent(str))); }

const TOOLS=[
{ "name":"afo-fsl-compress_status", "description":"Health check. Returns version, all binding statuses, and tool list.", "inputSchema":{"type":"object","properties":{},"required":[]} },
{ "name":"compress_repo", "description":"Cursor-aware: fetches GitHub repo tree, classifies each file (P/C/L/G/D), extracts keyword frequency+first-line per file, runs language-aware file-level signal detection (Python/JS Runtime, Cloudflare Worker Env), stores raw content in R2 keyed deterministically by repo+branch+path (idempotent re-runs), rebuilds the full dash-codex after every batch, prunes stale chunks for files no longer present once the scan completes, and indexes everything in D1. Excludes its own .v4readme output from the scan.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"},
    "path":{"type":"string"},"max_files":{"type":"number","default":20},"offset":{"type":"number","default":0}
  }}
},
{ "name":"query_compressed", "description":"Keyword/term search against the D1 chunk index for a compressed repo. Returns chunk locations and metadata, not full content.",
  "inputSchema":{"type":"object","required":["owner","repo","term"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"},"term":{"type":"string"},"limit":{"type":"number","default":20}
  }}
},
{ "name":"decompress_chunk", "description":"Selective decompression: fetches the FULL raw content of a specific chunk (by chunk_id or file_path) from R2. Use decompress_chunk_range instead when you only need a line window.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"},"chunk_id":{"type":"string"},"file_path":{"type":"string"}
  }}
},
{ "name":"decompress_chunk_range", "description":"Lazy line-window decompression: resolves chunkId (either short positional 'cN' matching .v4readme tree/matrix coordinates, or the full deterministic chunk_id) and returns ONLY the requested inclusive line range from R2 - never the full file unless full=true is explicitly passed.",
  "inputSchema":{"type":"object","required":["owner","repo","chunkId"],"properties":{
    "owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"},
    "chunkId":{"type":"string"},"lineStart":{"type":"number"},"lineEnd":{"type":"number"},"full":{"type":"boolean","default":false}
  }}
},
{ "name":"get_codex", "description":"Returns the dash-codex and global keyword frequency table for a compressed repo - the structural map without any file content.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}}}
},
{ "name":"compression_stats", "description":"Returns the latest compression job stats for a repo/branch.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}}}
},
{ "name":"list_chunks", "description":"Discovery without decompression: nested directory tree (with per-directory file_count/byte aggregates) plus a flat codex-compacted listing, read directly from the D1 manifest.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}}}
},
{ "name":"get_feature_vector", "description":"Standardized analytics block: file/byte/ratio totals, top-15 global keyword density, and language-aware heuristic signal classification (file-extension/filename/content-marker based for runtime signals; keyword-frequency based for UI/DB/Routing/Auth).",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}}}
},
{ "name":"generate_v4readme", "description":"Builds and stores the .v4readme (format v"+V4README_FORMAT_VERSION+"): <2000-byte spatial index with header+feature-vector, dash-codex mapping, hyperlinked repo tree with [cN:bBYTES] coordinates, and a domain-grouped semantic matrix using LINE-WINDOW coordinates [cN:Lstart-end] (+-5 lines around first keyword occurrence, clamped to file bounds) instead of byte offsets. File-type signals (runtime/framework) point to [cN] only, no line window. Stored in R2 at fsl/{owner}/{repo}/{branch}/.v4readme.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}}}
},
{ "name":"get_v4readme", "description":"Retrieves the previously generated .v4readme for a repo/branch from R2.",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"}}}
},
{ "name":"commit_v4readme_to_repo", "description":"Writes the most recently generated .v4readme (from R2) directly into the source repo via the GitHub contents API. Creates or updates (using current sha).",
  "inputSchema":{"type":"object","required":["owner","repo"],"properties":{"owner":{"type":"string"},"repo":{"type":"string"},"branch":{"type":"string","default":"main"},"target_path":{"type":"string","default":".v4readme"},"message":{"type":"string"}}}
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
  await db.prepare(`CREATE TABLE IF NOT EXISTS fsl_chunks (chunk_id TEXT PRIMARY KEY, repo_key TEXT, branch TEXT, file_path TEXT, chunk_type TEXT, orig_bytes INTEGER, top_keywords TEXT, r2_key TEXT, created_at TEXT, total_lines INTEGER, file_signals TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS fsl_codex (repo_key TEXT, branch TEXT, dash_code TEXT, term TEXT, PRIMARY KEY (repo_key, branch, dash_code))`).run();
  try{ await db.prepare("ALTER TABLE fsl_chunks ADD COLUMN total_lines INTEGER").run(); }catch(e){}
  try{ await db.prepare("ALTER TABLE fsl_chunks ADD COLUMN file_signals TEXT").run(); }catch(e){}
}

async function resolveChunkByShortOrFullId(env,owner,repo,branch,chunkId){
  const repoKey=owner+'/'+repo;
  const m=/^c(\d+)$/i.exec(chunkId||'');
  if(m){
    const idx=parseInt(m[1],10);
    const rows=await dbAll(env.DB,'SELECT * FROM fsl_chunks WHERE repo_key=? AND branch=? ORDER BY file_path',[repoKey,branch]);
    return rows[idx-1]||null;
  }
  const rows=await dbAll(env.DB,'SELECT * FROM fsl_chunks WHERE chunk_id=? LIMIT 1',[chunkId]);
  return rows[0]||null;
}

async function handleDecompressRangeRequest(env,p){
  const owner=p.owner, repo=p.repo, branch=p.branch||'main', chunkId=p.chunkId;
  if(!owner||!repo||!chunkId) return {status:400, body:{ok:false,error:'owner, repo, and chunkId are required'}};
  await ensureSchema(env.DB);
  const row=await resolveChunkByShortOrFullId(env,owner,repo,branch,chunkId);
  if(!row) return {status:404, body:{ok:false,error:'chunk not found for chunkId='+chunkId}};
  const obj=await env.FSL_STORE.get(row.r2_key);
  if(!obj) return {status:404, body:{ok:false,error:'blob missing in R2'}};
  const text=await obj.text();
  const allLines=text.split('\n');
  let ls=(p.lineStart!==undefined && p.lineStart!==null && p.lineStart!=='') ? parseInt(p.lineStart,10) : null;
  let le=(p.lineEnd!==undefined && p.lineEnd!==null && p.lineEnd!=='') ? parseInt(p.lineEnd,10) : null;
  const wantsFull=(p.full===true || p.full==='true');
  if(ls===null || le===null || Number.isNaN(ls) || Number.isNaN(le)){
    if(wantsFull){ ls=1; le=allLines.length; }
    else return {status:400, body:{ok:false,error:'lineStart and lineEnd are required unless full=true is explicitly set'}};
  }
  ls=Math.max(1,ls); le=Math.min(allLines.length,le);
  if(ls>le) return {status:400, body:{ok:false,error:'lineStart must be <= lineEnd'}};
  const lines=[];
  for(let n=ls;n<=le;n++) lines.push({n,text:allLines[n-1]});
  const textOut=lines.map(l=>l.text).join('\n');
  return {status:200, body:{ok:true,chunkId,path:row.file_path,lineStart:ls,lineEnd:le,text:textOut,lines}};
}

async function handle(name,args,env,ctx){
  if(name==="afo-fsl-compress_status"){
    const res={status:"ok",worker:WORKER_NAME,version:VERSION,v4readme_format:V4README_FORMAT_VERSION,generated_at:new Date().toISOString(),bindings:{},tools:TOOLS.map(t=>t.name)};
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
    let files=(tj.tree||[]).filter(f=>f.type==='blob' && (!root || f.path.startsWith(root)) && f.size<150000 && !badDir.some(d=>f.path.includes(d)) && !badExt.has((f.path.split('.').pop()||'').toLowerCase()) && f.path.split('/').pop()!=='.v4readme')
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
      const kwData=keywordsWithLines(txt,8);
      const fileSigs=detectFileSignals(file.path,txt).join(',');
      const chunkId=repoKey+'::'+branch+'::'+file.path;
      const r2Key='fsl/'+repoKey+'/'+branch+'/raw/'+file.path;
      await env.FSL_STORE.put(r2Key,txt,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});
      await dbRun(env.DB,'INSERT OR REPLACE INTO fsl_chunks (chunk_id,repo_key,branch,file_path,chunk_type,orig_bytes,top_keywords,r2_key,created_at,total_lines,file_signals) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [chunkId,repoKey,branch,file.path,ctype,txt.length,kwData.triples,r2Key,nowIso(),kwData.totalLines,fileSigs]);
      compressedCount++;
    }

    const allRows=await dbAll(env.DB,'SELECT file_path,orig_bytes,top_keywords FROM fsl_chunks WHERE repo_key=? AND branch=?',[repoKey,branch]);
    const currentPaths=new Set(files.map(f=>f.path));
    let liveRows=allRows;
    if(done){
      for(const r of allRows){
        if(!currentPaths.has(r.file_path)){
          await dbRun(env.DB,'DELETE FROM fsl_chunks WHERE repo_key=? AND branch=? AND file_path=?',[repoKey,branch,r.file_path]);
        }
      }
      liveRows=allRows.filter(r=>currentPaths.has(r.file_path));
    }
    let totalOrig=0, totalCompressed=0;
    const pathCounts={};
    for(const r of liveRows){
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
      [liveRows.length,totalOrig,totalCompressed,ratio,done?'complete':'partial',nowIso(),jobId]);

    return {ok:true,job_id:jobId,repo:repoKey,branch,sha:commit.slice(0,12),files_found:files.length,files_compressed_this_batch:compressedCount,total_chunks_indexed:liveRows.length,next_offset:next,done,orig_bytes:totalOrig,compressed_bytes:totalCompressed,ratio:Number(ratio.toFixed(2))};
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

  if(name==="decompress_chunk_range"){
    const {owner,repo,chunkId}=args;
    if(!owner) throw new Error("decompress_chunk_range: owner required");
    if(!repo) throw new Error("decompress_chunk_range: repo required");
    if(!chunkId) throw new Error("decompress_chunk_range: chunkId required");
    const result=await handleDecompressRangeRequest(env,{owner,repo,branch:args.branch||'main',chunkId,lineStart:args.lineStart,lineEnd:args.lineEnd,full:args.full});
    return result.body;
  }

  if(name==="get_codex"){
    const {owner,repo}=args;
    if(!owner) throw new Error("get_codex: owner required");
    if(!repo) throw new Error("get_codex: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    const codex=await dbAll(env.DB,'SELECT dash_code,term FROM fsl_codex WHERE repo_key=? AND branch=? ORDER BY length(dash_code)',[repoKey,branch]);
    const chunks=await dbAll(env.DB,'SELECT chunk_type,top_keywords FROM fsl_chunks WHERE repo_key=? AND branch=?',[repoKey,branch]);
    const freq={};
    for(const c of chunks){ for(const pair of (c.top_keywords||'').split(',')){ const kt=parseKwEntry(pair); if(kt.term) freq[kt.term]=(freq[kt.term]||0)+kt.count; } }
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
    const chunks=await dbAll(env.DB,'SELECT chunk_type,top_keywords,orig_bytes,file_signals FROM fsl_chunks WHERE repo_key=? AND branch=?',[repoKey,branch]);
    const freq={}, typeCounts={}, fileSignalCounts={};
    for(const c of chunks){
      typeCounts[c.chunk_type]=(typeCounts[c.chunk_type]||0)+1;
      for(const pair of (c.top_keywords||'').split(',')){ const kt=parseKwEntry(pair); if(kt.term) freq[kt.term]=(freq[kt.term]||0)+kt.count; }
      for(const lbl of (c.file_signals||'').split(',')){ if(lbl) fileSignalCounts[lbl]=(fileSignalCounts[lbl]||0)+1; }
    }
    const topKeywords=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([term,count])=>({term,count}));
    const signals=classifySignals(freq,fileSignalCounts).slice(0,8);
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
    const chunks=await dbAll(env.DB,'SELECT chunk_id,file_path,chunk_type,orig_bytes,top_keywords,total_lines,file_signals FROM fsl_chunks WHERE repo_key=? AND branch=? ORDER BY file_path',[repoKey,branch]);
    if(!chunks.length) return {ok:false,error:'no chunks found; run compress_repo first'};

    const RADIUS=5;
    const freq={}, fileSignalCounts={};
    chunks.forEach((c,ci)=>{
      for(const pair of (c.top_keywords||'').split(',')){
        const kt=parseKwEntry(pair);
        if(!kt.term) continue;
        if(!freq[kt.term]) freq[kt.term]={count:0,chunk_idx:ci+1,line:kt.line,total_lines:c.total_lines||kt.line};
        freq[kt.term].count+=kt.count;
      }
      for(const lbl of (c.file_signals||'').split(',')){ if(lbl) fileSignalCounts[lbl]=(fileSignalCounts[lbl]||0)+1; }
    });
    const flatFreq=Object.fromEntries(Object.entries(freq).map(([k,v])=>[k,v.count]));
    const signals=classifySignals(flatFreq,fileSignalCounts);

    const lines=[];
    lines.push('\u00a7V4README\u00a7'+repoKey+'@'+branch+' fmt:'+V4README_FORMAT_VERSION);
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
    const domainEntries={};
    for(const rule of SIGNAL_RULES){
      if(rule.type==='file'){
        if(fileSignalCounts[rule.label]>0){
          const idx=chunks.findIndex(c=>(c.file_signals||'').split(',').includes(rule.label));
          if(idx>=0){
            domainEntries[rule.domain]=domainEntries[rule.domain]||[];
            domainEntries[rule.domain].push({text:rule.label+'->[c'+(idx+1)+']', weight:fileSignalCounts[rule.label]});
          }
        }
      } else {
        for(const sig of rule.signals){
          if(freq[sig]){
            const f=freq[sig];
            const start=Math.max(1,f.line-RADIUS);
            const end=Math.min(f.total_lines||f.line,f.line+RADIUS);
            domainEntries[rule.domain]=domainEntries[rule.domain]||[];
            domainEntries[rule.domain].push({text:sig+'->[c'+f.chunk_idx+':L'+start+'-'+end+']', weight:f.count});
          }
        }
      }
    }
    const matrixStart=lines.length;
    for(const [domain,entries] of Object.entries(domainEntries)){
      entries.sort((a,b)=>b.weight-a.weight);
      const top=entries.slice(0,3);
      lines.push(domain+':'+top.map(e=>e.text).join(','));
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
    await env.FSL_STORE.put(r2Key,doc,{httpMetadata:{contentType:'text/plain; charset=utf-8'}});

    return {ok:true,repo:repoKey,branch,r2_key:r2Key,byte_size:byteLen(doc),truncated,format_version:V4README_FORMAT_VERSION,content:doc};
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

  if(name==="commit_v4readme_to_repo"){
    const {owner,repo}=args;
    if(!owner) throw new Error("commit_v4readme_to_repo: owner required");
    if(!repo) throw new Error("commit_v4readme_to_repo: repo required");
    const branch=args.branch||'main', repoKey=owner+'/'+repo;
    const targetPath=args.target_path||'.v4readme';
    const r2Key='fsl/'+repoKey+'/'+branch+'/.v4readme';
    const obj=await env.FSL_STORE.get(r2Key);
    if(!obj) return {ok:false,error:'.v4readme not found in R2; run generate_v4readme first'};
    const content=await obj.text();

    const getRes=await ghFetch(env,'https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+encodeURIComponent(targetPath)+'?ref='+encodeURIComponent(branch));
    let sha;
    if(getRes.ok){ const gj=await getRes.json(); sha=gj.sha; }
    else if(getRes.status!==404){ return {ok:false,error:'GitHub lookup failed: '+getRes.status}; }

    const putBody={ message: args.message||'chore: update .v4readme (FSL V4 topological index, auto-generated)', content: utf8ToBase64(content), branch };
    if(sha) putBody.sha=sha;

    const putRes=await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+encodeURIComponent(targetPath),{
      method:'PUT',
      headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,'User-Agent':'fsl-compress-mcp','Content-Type':'application/json',Accept:'application/vnd.github+json'},
      body:JSON.stringify(putBody)
    });
    const putJson=await putRes.json();
    if(!putRes.ok) return {ok:false,error:'GitHub commit failed: '+putRes.status+' '+(putJson.message||JSON.stringify(putJson))};

    return {ok:true,repo:repoKey,branch,path:targetPath,was_update:!!sha,commit_sha:putJson.commit&&putJson.commit.sha,html_url:putJson.content&&putJson.content.html_url,byte_size:byteLen(content)};
  }

  throw new Error("Unknown tool: "+name);
}

export default {
  async fetch(request,env,ctx){
    if(request.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
    const url=new URL(request.url);
    if(url.pathname==="/health") return Response.json({status:"ok",worker:WORKER_NAME,version:VERSION},{headers:CORS});

    if(url.pathname==="/api/decompress_chunk"){
      let p={};
      if(request.method==="GET"){
        const sp=url.searchParams;
        p={owner:sp.get('owner'),repo:sp.get('repo'),branch:sp.get('branch')||'main',chunkId:sp.get('chunkId'),lineStart:sp.get('lineStart'),lineEnd:sp.get('lineEnd'),full:sp.get('full')};
      } else if(request.method==="POST"){
        try{ p=await request.json(); }catch{ return Response.json({ok:false,error:'Parse error'},{status:400,headers:CORS}); }
        p.branch=p.branch||'main';
      } else {
        return new Response('Method not allowed',{status:405,headers:CORS});
      }
      const result=await handleDecompressRangeRequest(env,p);
      return Response.json(result.body,{status:result.status,headers:CORS});
    }

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
