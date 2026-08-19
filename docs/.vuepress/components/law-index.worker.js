// @ts-nocheck
/*
  Background worker for the Just Laws AI chat widget.

  The corpus is ~13 MB raw (24k+ 法条) and building the bigram MiniSearch
  index takes ~10-15 s of CPU. Doing that on the main thread makes the page
  janky (scroll/click stalls), especially on slow machines or when SPA
  navigation re-hydrates. This worker moves the whole
  "load (cache or network) + parse + index" pipeline off the main thread and
  answers searches here too, so the main thread only resizes a <div>.

  Caching: we reuse ./law-corpus-cache.js (same IndexedDB store as the
  main-thread fallback path), keyed by the corpus `version`. The main thread
  passes the last known cached version via the init message (it keeps that
  pointer in localStorage — unavailable inside workers); the worker reports
  the version it ended up with in the ready message so the main thread can
  persist the pointer for next time.

  Message protocol (main thread <-> worker):
    -> { type: "init", corpusUrl, cachedVersion }
    <- { type: "progress", percent }          during load / parse / index build
    <- { type: "ready", version, fromCache }  index built; searches allowed
    -> { type: "search", query, topK, requestId }
    <- { type: "results", requestId, hits }   [{ id, score, n, a, c, u, t }]
    <- { type: "error", requestId?, message }
*/

import MiniSearch from "minisearch";
import { getCachedCorpus, setCachedCorpus } from "./law-corpus-cache.js";
import { cjkTokenize, searchLaws } from "./law-retrieve.js";

// Index in 300-doc batches and yield between batches so progress messages
// actually reach the main thread (the worker thread has no UI to block, but
// without yields the messages queue up behind the synchronous loop).
const INDEX_CHUNK_DOCS = 300;

function yieldToUI() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== "undefined") {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function post(msg) {
  self.postMessage(msg);
}

// ---- Index construction ----

const FIELDS = ["t", "n", "c"];
const STORE_FIELDS = ["n", "a", "c", "u", "t"];
const SEARCH_OPTIONS = {
  tokenize: cjkTokenize,
  boost: { n: 3, c: 1.5 },
  combineWith: "OR",
};

async function buildIndex(docs) {
  const mini = new MiniSearch({
    fields: FIELDS,
    storeFields: STORE_FIELDS,
    tokenize: cjkTokenize,
    searchOptions: SEARCH_OPTIONS,
  });
  const total = docs.length;
  for (let i = 0; i < total; i += INDEX_CHUNK_DOCS) {
    mini.addAll(docs.slice(i, i + INDEX_CHUNK_DOCS));
    post({
      type: "progress",
      percent: Math.min(98, Math.round(((i + INDEX_CHUNK_DOCS) / total) * 100)),
      fromCache,
    });
    await yieldToUI();
  }
  return mini;
}

// ---- Init: cached corpus if fresh, otherwise download + parse + cache ----

let mini = null;
let fromCache = false; // set in init(); echoed on every progress message

async function init(corpusUrl, cachedVersion) {
  let data = null;
  let version = 0;
  fromCache = false;

  // 1) Try the shared IndexedDB cache (same store as the main-thread path).
  if (cachedVersion != null) {
    try {
      data = await getCachedCorpus(cachedVersion);
    } catch {
      data = null;
    }
  }
  if (data) {
    fromCache = true;
    version = cachedVersion;
    // fromCache rides along so the main thread can switch the status line to
    // the "已从本地缓存读取" variant right away, not only after `ready`.
    post({ type: "progress", percent: 40, fromCache: true });
  } else {
    // 2) Network fetch + persist for next time (best-effort).
    post({ type: "progress", percent: 5, fromCache: false });
    const resp = await fetch(corpusUrl);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    data = await resp.json();
    version = data.version || 0;
    post({ type: "progress", percent: 25, fromCache: false });
    if (version != null) {
      await setCachedCorpus(version, data); // never throws (best-effort)
    }
  }

  mini = await buildIndex(data.docs);
  post({ type: "ready", version, fromCache });
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === "init") {
      await init(msg.corpusUrl, msg.cachedVersion);
    } else if (msg.type === "search") {
      if (!mini) {
        post({
          type: "error",
          requestId: msg.requestId,
          message: "索引尚未就绪",
        });
        return;
      }
      const topK = msg.topK || 6;
      const hits = searchLaws(mini, msg.query, topK);
      post({ type: "results", requestId: msg.requestId, hits });
    }
  } catch (err) {
    post({
      type: "error",
      requestId: msg.requestId,
      message: err && err.message ? err.message : String(err),
    });
  }
};