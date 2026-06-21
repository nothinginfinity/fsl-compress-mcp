const VERSION="0.1.0";
const WORKER_NAME="afo-fsl-compress-mcp";
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,Mcp-Session-Id'};
const TOOLS=[{
  "name": "afo-fsl-compress_status",
  "description": "Health check. Returns version, all binding statuses, and tool list.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
},
{
  "name": "compress_repo",
  "description": "Cursor-aware: fetches GitHub repo tree, classifies each file (P/C/L/G/D), extracts keyword frequency per file, builds a dash-codex from repeated path segments, stores raw content in R2, and indexes chunks+codex+job stats in D1.",
  "inputSchema": {
    "properties": {
      "branch": {
        "default": "main",
        "type": "string"
      },
      "max_files": {
        "default": 20,
        "type": "number"
      },
      "offset": {
        "default": 0,
        "type": "number"
      },
      "owner": {
        "type": "string"
      },
      "path": {
        "type": "string"
      },
      "repo": {
        "type": "string"
      }
    },
    "required": [
      "owner",
      "repo"
    ],
    "type": "object"
  }
},
{
  "name": "query_compressed",
  "description": "Keyword/term search against the D1 chunk index for a compressed repo. Returns chunk locations and metadata, not full content (near-zero token cost).",
  "inputSchema": {
    "properties": {
      "branch": {
        "default": "main",
        "type": "string"
      },
      "limit": {
        "default": 20,
        "type": "number"
      },
      "owner": {
        "type": "string"
      },
      "repo": {
        "type": "string"
      },
      "term": {
        "type": "string"
      }
    },
    "required": [
      "owner",
      "repo",
      "term"
    ],
    "type": "object"
  }
},
{
  "name": "decompress_chunk",
  "description": "Selective decompression: fetches the full raw content of a specific chunk (by chunk_id or file_path) from R2. This is the only operation that costs full tokens for that content.",
  "inputSchema": {
    "properties": {
      "branch": {
        "default": "main",
        "type": "string"
      },
      "chunk_id": {
        "type": "string"
      },
      "file_path": {
        "type": "string"
      },
      "owner": {
        "type": "string"
      },
      "repo": {
        "type": "string"
      }
    },
    "required": [
      "owner",
      "repo"
    ],
    "type": "object"
  }
},
{
  "name": "get_codex",
  "description": "Returns the dash-codex (repeated path segment dictionary) and global keyword frequency table for a compressed repo - the structural map without any file content.",
  "inputSchema": {
    "properties": {
      "branch": {
        "default": "main",
        "type": "string"
      },
      "owner": {
        "type": "string"
      },
      "repo": {
        "type": "string"
      }
    },
    "required": [
      "owner",
      "repo"
    ],
    "type": "object"
  }
},
{
  "name": "compression_stats",
  "description": "Returns the latest compression job stats for a repo/branch: ratio, byte counts, file counts, status.",
  "inputSchema": {
    "properties": {
      "branch": {
        "default": "main",
        "type": "string"
      },
      "owner": {
        "type": "string"
      },
      "repo": {
        "type": "string"
      }
    },
    "required": [
      "owner",
      "repo"
    ],
    "type": "object"
  }
}];
function rpc(id,r){return Response.json({jsonrpc:"2.0",id,result:r},{headers:CORS});}
function errResp(id,c,m){return Response.json({jsonrpc:"2.0",id,error:{code:c,message:m}},{headers:CORS});}
function tool(id,r){return rpc(id,{content:[{type:"text",text:JSON.stringify(r,null,2)}]});}
function genId(p){return p+"_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);}
function nowIso(){return new Date().toISOString();}
async function dbRun(db,sql,p){const s=db.prepare(sql);return p?s.bind(...p).run():s.run();}
async function dbFirst(db,sql,p){const s=db.prepare(sql);return p?s.bind(...p).first():s.first();}
async function dbAll(db,sql,p){const s=db.prepare(sql);const r=p?await s.bind(...p).all():await s.all();return r.results||[];}
async function ensureSchema(db){await db.prepare(`CREATE TABLE IF NOT EXISTS mcp_sessions (session_id TEXT PRIMARY KEY,worker_name TEXT NOT NULL,status TEXT DEFAULT 'active',parent_id TEXT,metadata TEXT,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,finished_at TEXT)`).run();await db.prepare(`CREATE TABLE IF NOT EXISTS action_execution_logs (log_id TEXT PRIMARY KEY,session_id TEXT,worker_name TEXT NOT NULL,tool_name TEXT NOT NULL,status TEXT NOT NULL,input_json TEXT,output_summary TEXT,payload_uri TEXT,error_message TEXT,duration_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,vector_id TEXT,created_at TEXT NOT NULL)`).run();await db.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (migration_id TEXT PRIMARY KEY,worker_name TEXT NOT NULL,description TEXT,applied_at TEXT NOT NULL,checksum TEXT)`).run();}
const PAYLOAD_THRESHOLD_BYTES=2048;
async function r2Put(r2,k,p){const b=typeof p==="string"?p:JSON.stringify(p,null,2);await r2.put(k,b,{httpMetadata:{contentType:"application/json"}});return "r2://"+k;}
async function r2Get(r2,k){const o=await r2.get(k);if(!o)return null;const t=await o.text();try{return JSON.parse(t);}catch{return t;}}
async function handle(name,args,env,ctx){
  if(name==="afo_fsl_compress_status"){const res={status:"ok",worker:WORKER_NAME,version:VERSION,generated_at:"2026-06-21T21:47:21.027Z",bindings:{},tools:TOOLS.map(t=>t.name)};
  try{await ensureSchema(env.DB);res.bindings.DB=true;}catch{res.bindings.DB=false;}
  res.bindings.R2=!!env.R2;
  return res;}
  await ensureSchema(env.DB);
  if (name === "compress_repo") {
    const { owner, repo } = args;
    if (!owner) throw new Error("compress_repo: owner required");
    if (!repo) throw new Error("compress_repo: repo required");
    const owner=args.owner,repo=args.repo,branch=args.branch||'main',root=args.path||'';const repoKey=owner+'/'+repo;const max=Math.max(1,Math.min(args.max_files||20,30));const offset=Math.max(0,Math.floor(args.offset||0));const jobId=genId('fsl'),ts=nowIso();const STOP=new Set(['the','and','for','that','with','this','from','are','was','were','have','has','not','but','you','your','can','will','all','any','its','our','out','use','via','def','self','int','str']);async function gh(url,accept){return fetch(url,{headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,Accept:accept||'application/vnd.github+json','User-Agent':'fsl-compress-mcp'}})}function classify(p){const ext=(p.split('.').pop()||'').toLowerCase();if(['py','js','ts','jsx','tsx','go','rs','java','c','cpp','rb','php','sh'].includes(ext))return'C';if(['json','yaml','yml','toml','ini','cfg','env'].includes(ext))return'G';if(['csv','tsv','sql'].includes(ext))return'D';if(['md','txt','rst'].includes(ext))return'P';if(p.toUpperCase().includes('LICENSE'))return'L';return'P'}function keywords(text,n){const counts={};const words=text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g)||[];for(const w of words){if(STOP.has(w))continue;counts[w]=(counts[w]||0)+1}return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,n).map(e=>e[0]+':'+e[1]).join(',')}const ref=await gh('https://api.github.com/repos/'+owner+'/'+repo+'/git/ref/heads/'+encodeURIComponent(branch));let commit='unknown';if(ref.ok){const j=await ref.json();commit=(j.object&&j.object.sha)||'unknown'}const tree=await gh('https://api.github.com/repos/'+owner+'/'+repo+'/git/trees/'+encodeURIComponent(branch)+'?recursive=1');if(!tree.ok)throw new Error('GitHub tree fetch failed '+tree.status);const tj=await tree.json();const badExt=new Set(['png','jpg','jpeg','gif','ico','woff','woff2','ttf','pdf','zip','wasm','bin','mp4','mov','lock']);const badDir=['node_modules/','.git/','.wrangler/','dist/','build/','.next/','venv/','__pycache__/'];let files=(tj.tree||[]).filter(f=>f.type==='blob'&&(!root||f.path.startsWith(root))&&f.size<150000&&!badDir.some(d=>f.path.includes(d))&&!badExt.has((f.path.split('.').pop()||'').toLowerCase())).map(f=>({path:f.path,size:f.size,sha:f.sha})).sort((a,b)=>a.path.localeCompare(b.path));const batch=files.slice(offset,offset+max);const next=offset+batch.length,done=next>=files.length;await dbRun(env.DB,'CREATE TABLE IF NOT EXISTS fsl_jobs (job_id TEXT PRIMARY KEY, repo_key TEXT, branch TEXT, sha TEXT, files_found INTEGER, files_compressed INTEGER, orig_bytes INTEGER, compressed_bytes INTEGER, ratio REAL, status TEXT, created_at TEXT, updated_at TEXT)');await dbRun(env.DB,'CREATE TABLE IF NOT EXISTS fsl_chunks (chunk_id TEXT PRIMARY KEY, repo_key TEXT, branch TEXT, file_path TEXT, chunk_type TEXT, orig_bytes INTEGER, top_keywords TEXT, r2_key TEXT, created_at TEXT)');await dbRun(env.DB,'CREATE TABLE IF NOT EXISTS fsl_codex (repo_key TEXT, branch TEXT, dash_code TEXT, term TEXT, PRIMARY KEY (repo_key, branch, dash_code))');await dbRun(env.DB,'INSERT INTO fsl_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[jobId,repoKey,branch,commit.slice(0,12),files.length,0,0,0,0,'running',ts,ts]);const pathCounts={};let origTotal=0,compressedTotal=0,compressedCount=0;for(const file of batch){const enc=file.path.split('/').map(encodeURIComponent).join('/');const raw=await fetch('https://raw.githubusercontent.com/'+owner+'/'+repo+'/'+encodeURIComponent(branch)+'/'+enc,{headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,'User-Agent':'fsl-compress-mcp'}});if(!raw.ok)continue;const txt=await raw.text();if(!txt.trim())continue;const ctype=classify(file.path);const kw=keywords(txt,8);const chunkId=jobId+'_'+compressedCount;const r2Key='fsl/'+repoKey+'/'+branch+'/'+chunkId+'.raw';await env.FSL_STORE.put(r2Key,txt);await dbRun(env.DB,'INSERT INTO fsl_chunks VALUES (?,?,?,?,?,?,?,?,?)',[chunkId,repoKey,branch,file.path,ctype,txt.length,kw,r2Key,nowIso()]);origTotal+=txt.length;compressedTotal+=kw.length+file.path.length+20;compressedCount++;for(const seg of file.path.split('/')){if(seg.length>3)pathCounts[seg]=(pathCounts[seg]||0)+1}}let dashLevel=3;for(const [term,count] of Object.entries(pathCounts).sort((a,b)=>b[1]-a[1])){if(count<2)continue;const code='-'.repeat(dashLevel);await dbRun(env.DB,'INSERT OR REPLACE INTO fsl_codex VALUES (?,?,?,?)',[repoKey,branch,code,term]);dashLevel++;if(dashLevel>20)break}const ratio=origTotal>0?(origTotal/Math.max(compressedTotal,1)):0;await dbRun(env.DB,'UPDATE fsl_jobs SET files_compressed=?,orig_bytes=?,compressed_bytes=?,ratio=?,status=?,updated_at=? WHERE job_id=?',[compressedCount,origTotal,compressedTotal,ratio,done?'complete':'partial',nowIso(),jobId]);return{ok:true,job_id:jobId,repo:repoKey,branch,sha:commit.slice(0,12),files_found:files.length,files_compressed:compressedCount,next_offset:next,done,orig_bytes:origTotal,compressed_bytes:compressedTotal,ratio:Number(ratio.toFixed(2))};
  }

  if (name === "query_compressed") {
    const { owner, repo, term } = args;
    if (!owner) throw new Error("query_compressed: owner required");
    if (!repo) throw new Error("query_compressed: repo required");
    if (!term) throw new Error("query_compressed: term required");
    const owner=args.owner,repo=args.repo,branch=args.branch||'main',repoKey=owner+'/'+repo,term=(args.term||'').toLowerCase();const limit=Math.min(args.limit||20,50);const rows=await dbAll(env.DB,'SELECT chunk_id,file_path,chunk_type,top_keywords,orig_bytes FROM fsl_chunks WHERE repo_key=? AND branch=? AND (lower(top_keywords) LIKE ? OR lower(file_path) LIKE ?) LIMIT ?',[repoKey,branch,'%'+term+'%','%'+term+'%',limit]);return{ok:true,repo:repoKey,branch,term,count:rows.length,matches:rows};
  }

  if (name === "decompress_chunk") {
    const { owner, repo } = args;
    if (!owner) throw new Error("decompress_chunk: owner required");
    if (!repo) throw new Error("decompress_chunk: repo required");
    const owner=args.owner,repo=args.repo,branch=args.branch||'main',repoKey=owner+'/'+repo;let row;if(args.chunk_id){const rows=await dbAll(env.DB,'SELECT * FROM fsl_chunks WHERE chunk_id=? LIMIT 1',[args.chunk_id]);row=rows[0]}else if(args.file_path){const rows=await dbAll(env.DB,'SELECT * FROM fsl_chunks WHERE repo_key=? AND branch=? AND file_path=? LIMIT 1',[repoKey,branch,args.file_path]);row=rows[0]}if(!row)return{ok:false,error:'chunk not found'};const obj=await env.FSL_STORE.get(row.r2_key);if(!obj)return{ok:false,error:'blob missing in R2'};const text=await obj.text();return{ok:true,chunk_id:row.chunk_id,file_path:row.file_path,chunk_type:row.chunk_type,orig_bytes:row.orig_bytes,content:text};
  }

  if (name === "get_codex") {
    const { owner, repo } = args;
    if (!owner) throw new Error("get_codex: owner required");
    if (!repo) throw new Error("get_codex: repo required");
    const owner=args.owner,repo=args.repo,branch=args.branch||'main',repoKey=owner+'/'+repo;const codex=await dbAll(env.DB,'SELECT dash_code,term FROM fsl_codex WHERE repo_key=? AND branch=? ORDER BY length(dash_code)',[repoKey,branch]);const chunks=await dbAll(env.DB,'SELECT chunk_type,top_keywords FROM fsl_chunks WHERE repo_key=? AND branch=?',[repoKey,branch]);const freq={};for(const c of chunks){for(const pair of (c.top_keywords||'').split(',')){const parts=pair.split(':');if(parts[0])freq[parts[0]]=(freq[parts[0]]||0)+Number(parts[1]||1)}}const topGlobal=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,25).map(e=>e[0]+':'+e[1]);return{ok:true,repo:repoKey,branch,codex,global_keywords:topGlobal,chunk_count:chunks.length};
  }

  if (name === "compression_stats") {
    const { owner, repo } = args;
    if (!owner) throw new Error("compression_stats: owner required");
    if (!repo) throw new Error("compression_stats: repo required");
    const owner=args.owner,repo=args.repo,branch=args.branch||'main',repoKey=owner+'/'+repo;const rows=await dbAll(env.DB,'SELECT * FROM fsl_jobs WHERE repo_key=? AND branch=? ORDER BY created_at DESC LIMIT 1',[repoKey,branch]);if(!rows.length)return{ok:false,error:'no job found for this repo/branch'};return{ok:true,job:rows[0]};
  }

  throw new Error("Unknown tool: "+name);}
export default{async fetch(request,env,ctx){if(request.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});const url=new URL(request.url);if(url.pathname==="/health")return Response.json({status:"ok",worker:WORKER_NAME,version:VERSION},{headers:CORS});if(request.method!=="POST")return new Response("not found",{status:404,headers:CORS});let body;try{body=await request.json();}catch{return errResp(null,-32700,"Parse error");}const{id,method,params}=body;if(method==="initialize")return rpc(id,{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:WORKER_NAME,version:VERSION}});if(method==="notifications/initialized")return new Response(null,{status:204,headers:CORS});if(method==="ping")return rpc(id,{});if(method==="tools/list")return rpc(id,{tools:TOOLS});if(method==="tools/call"){try{return tool(id,await handle(params?.name,params?.arguments||{},env,ctx));}catch(e){return errResp(id,-32603,"Tool error: "+e.message);}}return errResp(id,-32601,"Method not found: "+method);}};