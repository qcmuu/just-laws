// Tiny IndexedDB wrapper for caching the law corpus on the client.
//
// Why: law-corpus.json is ~13MB raw / ~2.6MB gzip. On a slow link (GitHub Pages
// from mainland China) re-downloading it every time the chat widget opens is
// the single biggest source of "卡". We cache the parsed corpus in IndexedDB
// keyed by its `version` field, so a second open skips the network entirely.
// Building the MiniSearch index still runs in-page (~15s, with a progress bar),
// but the network round-trip — the part that feels frozen on a bad connection
// — is gone.
//
// Freshness: the corpus `version` only bumps when its schema changes, so a
// content-only re-build would otherwise serve stale law text forever. Each
// cached entry therefore also records a savedAt timestamp and is treated as a
// miss after CACHE_TTL_MS (7 days; law texts are updated rarely), which bounds
// staleness and still covers the common "browse again soon" case.
//
// IndexedDB stores structured clones of the parsed object (no serialization
// overhead). We keep the raw response text too so a cache hit can skip even
// JSON.parse on the fast path is NOT done — we store the parsed object and
// read it back directly.

const DB_NAME = "jl-law-corpus";
const STORE = "corpus";
const DB_VERSION = 1;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

function txGet(db, key) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readonly");
    const r = t.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// Read the cached corpus for a given version. Returns null on miss / error /
// expiry (callers fall back to a network fetch). Never throws — caching is a
// best-effort optimization, not a correctness path.
export async function getCachedCorpus(version) {
  try {
    const db = await openDB();
    const entry = await txGet(db, version);
    db.close();
    if (!entry || entry.version !== version) return null;
    if (Date.now() - (entry.savedAt || 0) > CACHE_TTL_MS) return null;
    return entry.corpus;
  } catch (e) {
    return null;
  }
}

// Persist the corpus under its version key. Best-effort; a failure just means
// the next open re-downloads. We also prune any older-version entries so the
// cache does not grow unbounded across corpus updates.
export async function setCachedCorpus(version, corpus) {
  try {
    const db = await openDB();
    // Prune older versions first (best-effort, ignore errors).
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const allKeys = await new Promise((res) => {
        const kr = store.getAllKeys();
        kr.onsuccess = () => res(kr.result);
        kr.onerror = () => res([]);
      });
      for (const k of allKeys) {
        if (k !== version) store.delete(k);
      }
    } catch (e) {
      /* ignore prune errors */
    }
    await txPut(db, version, { version, savedAt: Date.now(), corpus });
    db.close();
  } catch (e) {
    /* ignore — cache is best-effort */
  }
}
