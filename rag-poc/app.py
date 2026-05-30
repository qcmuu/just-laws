"""Minimal FastAPI chat UI for the Just Laws RAG PoC."""

import json

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

import config
import rag

app = FastAPI(title="Just Laws RAG PoC")


class Query(BaseModel):
    question: str
    category: str | None = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "llm_model": config.LLM_MODEL,
        "llm_base_url": config.LLM_BASE_URL,
        "embedding_backend": config.EMBEDDING_BACKEND,
    }


@app.post("/api/chat")
def chat(q: Query):
    hits, gen = rag.answer(q.question, category=q.category, stream=True)

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
  sendBtn.disabled=true;ansEl.textContent='';srcEl.innerHTML='';
  try{
    const resp=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question})});
    const reader=resp.body.getReader();const dec=new TextDecoder();let buf='';
    while(true){const{value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
      let idx;while((idx=buf.indexOf('\\n\\n'))>=0){const line=buf.slice(0,idx).trim();buf=buf.slice(idx+2);
        if(!line.startsWith('data:'))continue;const evt=JSON.parse(line.slice(5).trim());
        if(evt.type==='sources'){renderSources(evt.sources);}
        else if(evt.type==='token'){ansEl.textContent+=evt.text;}
      }
    }
  }catch(e){ansEl.textContent='出错了：'+e;}
  sendBtn.disabled=false;
}
function renderSources(sources){
  srcEl.innerHTML='<h4>参考来源（'+sources.length+' 条法条，点击核对原文）</h4>';
  sources.forEach((s,i)=>{const d=document.createElement('div');d.className='src';
    d.innerHTML='<a href="'+s.source_url+'" target="_blank">《'+s.law_name+'》'+s.article_no+'</a><span class="badge">相关度 '+s.score+'</span><div class="ctx">'+s.context+'</div>';
    srcEl.appendChild(d);});
}
sendBtn.onclick=ask;qEl.addEventListener('keydown',e=>{if(e.key==='Enter')ask();});
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
def index():
    return INDEX_HTML
