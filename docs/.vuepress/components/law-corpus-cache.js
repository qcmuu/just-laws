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
// Freshness: the corpus `version` is a hash of its content (see
// build-law-corpus.mjs), so it changes whenever a law is amended, repealed, or
// re-parsed. To notice that without re-downloading ~12 MB, the site publishes
// a tiny `law-corpus-version.json` next to the corpus; callers compare it with
// the cached version before deciding to hit the network. A cache entry older
// than CACHE_TTL_MS (7 days) is dropped regardless, so a site that stops
// publishing the probe file cannot pin stale law text forever.
//
// IndexedDB stores structured clones of the parsed object (no serialization
// overhead) — we store the parsed object and read it back directly.

const DB_NAME = "jl-law-corpus";
const STORE = "corpus";
const DB_VERSION = 1;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// When the version probe cannot be reached (offline, 404, blocked), a cached
// corpus this old is not trusted: that is the only remaining guard against
// serving repealed law text indefinitely if the probe file ever goes missing.
const UNVERIFIED_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

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

// Ask the server which corpus version is current. The file is a few bytes, so
// this is cheap enough to run on every open; on any failure we return null and
// the caller falls back to its cache.
export async function fetchCorpusVersion(versionUrl) {
  try {
    const resp = await fetch(versionUrl, { cache: "no-cache" });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.version === "number" ? data.version : null;
  } catch (e) {
    return null;
  }
}

// Read the cached corpus for a given version. Returns null on miss / error /
// expiry (callers fall back to a network fetch). Never throws — caching is a
// best-effort optimization, not a correctness path.
//
// `verified` says whether the caller managed to confirm this version is still
// the one the server publishes. Unverified entries expire much sooner, so a
// broken/missing probe file cannot keep repealed text alive for a week.
export async function getCachedCorpus(version, { verified = true } = {}) {
  try {
    const db = await openDB();
    const entry = await txGet(db, version);
    db.close();
    if (!entry || entry.version !== version) return null;
    const age = Date.now() - (entry.savedAt || 0);
    const ttl = verified ? CACHE_TTL_MS : UNVERIFIED_TTL_MS;
    if (age > ttl) return null;
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
