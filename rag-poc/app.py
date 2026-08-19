"""FastAPI chat backend for the Just Laws RAG assistant.

Endpoints:
    GET  /health    -> liveness + config introspection
    POST /api/chat  -> SSE stream of {sources, token..., done}

CORS is permissive so the static VuePress site (any origin) can call it.
A minimal demo page is served at / for standalone testing.
"""

import asyncio
import json
import threading
import time
from functools import partial

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import config
import rag
import security

app = FastAPI(title="Just Laws AI RAG", description="JustLaws AI - Advanced Hybrid Retrieval and Legal RAG PoC")

_origins = [o.strip() for o in config.CORS_ALLOW_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- simple in-process fixed-window rate limiter (per client IP) ---
# Guards the public /api/chat endpoint against abuse / runaway LLM cost. It is
# per-process; pair it with an edge limiter (nginx limit_req) for multi-instance
# deployments. See config.RATE_LIMIT_* for tunables.
_rl_lock = threading.Lock()
_rl_hits: dict[str, tuple[int, int]] = {}  # ip -> (window_start_epoch, count)


def _client_ip(request: Request) -> str:
    header = config.RATE_LIMIT_CLIENT_IP_HEADER
    raw = request.headers.get(header) if header else None
    peer = request.client.host if request.client else None
    return security.pick_client_ip(header, raw, peer)


def _rate_limited(request: Request) -> bool:
    """Return True if this client has exceeded its request budget."""
    if not config.RATE_LIMIT_ENABLED:
        return False
    now = int(time.time())
    window = config.RATE_LIMIT_WINDOW
    ip = _client_ip(request)
    with _rl_lock:
        start, count = _rl_hits.get(ip, (now, 0))
        if now - start >= window:
            start, count = now, 0
        count += 1
        _rl_hits[ip] = (start, count)
        # Opportunistically drop stale entries so the dict can't grow unbounded.
        if len(_rl_hits) > 10000:
            for k, (s, _) in list(_rl_hits.items()):
                if now - s >= window:
                    _rl_hits.pop(k, None)
    return count > config.RATE_LIMIT_REQUESTS


def _chat_authorized(request: Request) -> tuple[bool, int, str]:
    """Return (ok, status, error). Anonymous chat is local-dev only."""
    if config.CHAT_API_KEY:
        if security.api_key_ok(
            config.CHAT_API_KEY,
            request.headers.get("x-api-key", ""),
            request.headers.get("authorization", ""),
        ):
            return True, 200, ""
        return False, 401, "未授权。"
    if config.CHAT_ALLOW_ANONYMOUS:
        return True, 200, ""
    return False, 503, "服务未配置 CHAT_API_KEY，已拒绝匿名访问。"


class Query(BaseModel):
    question: str = Field(..., min_length=1, max_length=config.MAX_QUESTION_CHARS)
    category: str | None = Field(default=None, max_length=64)


@app.get("/health")
def health():
    return {
        "ok": True,
        "auth_required": bool(config.CHAT_API_KEY) or not config.CHAT_ALLOW_ANONYMOUS,
        "embedding_backend": config.EMBEDDING_BACKEND,
    }


@app.post("/api/chat")
async def chat(q: Query, request: Request):
    ok, status, err = _chat_authorized(request)
    if not ok:
        return JSONResponse(status_code=status, content={"error": err})
    if _rate_limited(request):
        return JSONResponse(
            status_code=429,
            content={"error": "请求过于频繁，请稍后再试。"},
        )
    question = (q.question or "").strip()
    if not question:
        return JSONResponse(status_code=400, content={"error": "问题不能为空。"})

    category = q.category
    hits, gen = await asyncio.to_thread(
        partial(rag.answer, question, category=category, stream=True)
    )

    def event_stream():
        yield "data: " + json.dumps({"type": "sources", "sources": hits}, ensure_ascii=False) + "\n\n"
        for chunk in gen:
            if not chunk.choices:
                continue
            piece = getattr(chunk.choices[0].delta, "content", None)
            if piece:
                yield "data: " + json.dumps({"type": "token", "text": piece}, ensure_ascii=False) + "\n\n"
        yield "data: " + json.dumps({"type": "done"}) + "\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


INDEX_HTML = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Just Laws · AI 法律问答 (PoC)</title>
<style>
  :root{--brand:#DE2910;}
  *{box-sizing:border-box}
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f7f7f8;color:#1a1a1a}
  header{background:var(--brand);color:#fff;padding:14px 20px;font-weight:600}
  header small{opacity:.85;font-weight:400}
  main{max-width:780px;margin:0 auto;padding:20px}
  .disclaimer{background:#fff6f5;border:1px solid #ffd9d4;color:#a8261b;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px}
  .examples{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
  .examples button{background:#fff;border:1px solid #ddd;border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer}
  .examples button:hover{border-color:var(--brand);color:var(--brand)}
  .inputbar{display:flex;gap:8px;margin-bottom:20px}
  .inputbar input{flex:1;padding:12px 14px;border:1px solid #ccc;border-radius:8px;font-size:15px}
  .inputbar button{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:0 20px;font-size:15px;cursor:pointer}
  .inputbar button:disabled{opacity:.5;cursor:not-allowed}
  .answer{background:#fff;border:1px solid #eee;border-radius:10px;padding:16px 18px;white-space:pre-wrap;line-height:1.7;min-height:24px}
  .sources{margin-top:14px}
  .sources h4{margin:0 0 8px;font-size:13px;color:#666}
  .src{background:#fff;border:1px solid #eee;border-left:3px solid var(--brand);border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:13px}
  .src a{color:var(--brand);text-decoration:none;font-weight:600}
  .src .ctx{color:#999;font-size:12px;margin-top:2px}
  .badge{display:inline-block;background:#eee;border-radius:10px;padding:1px 8px;font-size:11px;color:#666;margin-left:6px}
</style>
</head>
<body>
<header>Just Laws · AI 法律问答 <small>PoC — 基于现行法律文库的 RAG 检索问答</small></header>
<main>
  <div class="disclaimer">⚠️ 本工具基于已收录法律条文自动整理回答，仅供参考、不构成法律意见。重大事项请咨询执业律师。</div>
  <div class="examples" id="examples"></div>
  <div class="inputbar">
    <input id="q" placeholder="用一句话描述你的法律问题，如：租房到期房东不退押金怎么办？" />
    <button id="send">提问</button>
  </div>
  <div class="answer" id="answer">回答将显示在这里。</div>
  <div class="sources" id="sources"></div>
</main>
<script>
const EXAMPLES=["租房到期房东不退押金怎么办？","公司拖欠工资可以怎么维权？","欠钱不还的诉讼时效是多久？","未成年人能不能签合同？","离婚时夫妻共同财产怎么分割？"];
const ex=document.getElementById('examples');
EXAMPLES.forEach(t=>{const b=document.createElement('button');b.textContent=t;b.onclick=()=>{document.getElementById('q').value=t;ask();};ex.appendChild(b);});
const ansEl=document.getElementById('answer'),srcEl=document.getElementById('sources'),sendBtn=document.getElementById('send'),qEl=document.getElementById('q');
async function ask(){
  const question=qEl.value.trim();if(!question)return;
  sendBtn.disabled=true;ansEl.textContent='';srcEl.replaceChildren();
  try{
    const resp=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question})});
    if(!resp.ok){
      let msg='HTTP '+resp.status;
      try{const j=await resp.json();if(j&&j.error)msg=j.error;}catch(e){}
      ansEl.textContent='出错了：'+msg;sendBtn.disabled=false;return;
    }
    const reader=resp.body.getReader();const dec=new TextDecoder();let buf='';
    while(true){const{value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
      let idx;while((idx=buf.indexOf('\\n\\n'))>=0){const line=buf.slice(0,idx).trim();buf=buf.slice(idx+2);
        if(!line.startsWith('data:'))continue;
        let evt;try{evt=JSON.parse(line.slice(5).trim());}catch(e){continue;}
        if(evt.type==='sources'){renderSources(evt.sources);}
        else if(evt.type==='token'){ansEl.textContent+=evt.text;}
      }
    }
  }catch(e){ansEl.textContent='出错了：'+e;}
  sendBtn.disabled=false;
}
function safeHttpUrl(u){
  try{const x=new URL(u, location.origin);return (x.protocol==='http:'||x.protocol==='https:')?x.href:null;}
  catch(e){return null;}
}
function renderSources(sources){
  srcEl.replaceChildren();
  const box=document.createElement('details');
  const h=document.createElement('summary');
  h.textContent='参考来源（'+(sources||[]).length+' 条法条，展开核对原文）';
  box.appendChild(h);
  srcEl.appendChild(box);
  (sources||[]).forEach(s=>{
    const d=document.createElement('div');d.className='src';
    const a=document.createElement('a');
    const href=safeHttpUrl(s.source_url);
    if(href){a.href=href;a.target='_blank';a.rel='noopener noreferrer';}
    a.textContent='《'+(s.law_name||'')+'》'+(s.article_no||'');
    const badge=document.createElement('span');badge.className='badge';
    badge.textContent='相关度 '+(s.score==null?'':s.score);
    const ctx=document.createElement('div');ctx.className='ctx';
    ctx.textContent=s.context||'';
    d.appendChild(a);d.appendChild(badge);d.appendChild(ctx);
    box.appendChild(d);
  });
}
sendBtn.onclick=ask;qEl.addEventListener('keydown',e=>{if(e.key==='Enter')ask();});
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
def index():
    return INDEX_HTML
