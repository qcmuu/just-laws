#!/usr/bin/env node
/**
 * Build a static, article-level law corpus for the in-browser (client-side)
 * RAG chat widget. No backend required: the widget lazy-loads this JSON, builds
 * a lexical index in the browser, retrieves the top-k 法条 for a question, and
 * sends them to a user-supplied OpenAI-compatible LLM endpoint (BYOK).
 *
 * This is a self-contained Node port of rag-poc/chunker.py so the static site
 * (and GitHub Pages CI) can build the corpus without the Python pipeline.
 *
 * Output: docs/.vuepress/public/law-corpus.json (served at /law-corpus.json).
 * URLs are stored site-relative (e.g. "/economic/seed-law/") so they resolve
 * against whatever origin serves the site (justlaws.cn or *.github.io).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, "..", "..");
const OUT_FILE = path.resolve(__dirname, "..", "public", "law-corpus.json");
// Tiny probe the client fetches to decide whether its cached copy is stale.
const VERSION_FILE = path.resolve(
  __dirname,
  "..",
  "public",
  "law-corpus-version.json"
);
const SITEMAP_FILE = path.resolve(__dirname, "..", "public", "sitemap.xml");

// Absolute site origin (env override) + base, matching config.js's siteUrl.
const SITE_URL =
  (process.env.JUSTLAWS_SITE_URL || "https://law.aisme.eu.cc").replace(
    /\/+$/,
    ""
  ) + ((process.env.JUSTLAWS_BASE || "/") !== "/" ? process.env.JUSTLAWS_BASE : "/");

// Schema/selection-rule generation, mixed into the content hash below.
// 3: repealed / not-yet-in-force laws excluded (was 2, which included them).
const CORPUS_SCHEMA_VERSION = 3;

// The corpus `version` keys the browser's IndexedDB cache, so it must change
// whenever the content does — otherwise a client keeps serving law text that
// has since been amended (or repealed) until the 7-day cache TTL expires.
// Deriving it from the content makes that automatic: no one has to remember
// to bump a constant, which is exactly the failure mode that let repealed
// statutes stay in the cache after this very fix.
function contentVersion(docs) {
  const hash = createHash("sha256");
  hash.update(String(CORPUS_SCHEMA_VERSION));
  for (const d of docs) {
    hash.update(`${d.n}\u0000${d.a}\u0000${d.u}\u0000${d.t}\u0000${d.c || ""}\u0001`);
  }
  // Small integer so the existing localStorage version pointer stays numeric.
  return parseInt(hash.digest("hex").slice(0, 8), 16);
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*$/;
// Articles come in two formats in this repo:
//   1. `**第X条**　body`      — every law except 刑法分则
//   2. `第X条　body`          — 刑法分则 writes each 之N article (刑法修正案
//      additions) as plain text, e.g. `第一百三十三条之一　在道路上驾驶…`.
// Format 2 requires a 之N suffix and a following space so a body line that
// merely begins with a cross-reference ("第三百九十九条规定的…") is not
// mistaken for an article heading. Without this, those 51 之N articles were
// appended to the *preceding* article's text — 高空抛物 ended up inside
// 第二百九十一条 (聚众扰乱公共场所秩序) and was unreachable by its own number.
const ARTICLE_RE =
  /^\*\*(第[\d一二三四五六七八九十百千零〇两]+条(?:之[\d一二三四五六七八九十]+)?)\*\*[\s　]*(.*)$/;
const PLAIN_ARTICLE_RE =
  /^(第[\d一二三四五六七八九十百千零〇两]+条之[\d一二三四五六七八九十]+)[\s　]+(.*)$/;

function classifyHeading(title) {
  const t = title.trim();
  if (/^第[\d一二三四五六七八九十百]+编/.test(t) || t.includes("分编")) return "book";
  if (/^第[\d一二三四五六七八九十百]+章/.test(t)) return "chapter";
  if (/^第[\d一二三四五六七八九十百]+节/.test(t)) return "section";
  return null;
}

function isLawName(h1) {
  if (!h1) return false;
  if (classifyHeading(h1)) return false;
  return h1.includes("法") || h1.includes("决定") || h1.includes("条例");
}

function firstH1(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = HEADING_RE.exec(line.trim());
      if (m && m[1].length === 1) return m[2].trim();
    }
  } catch {
    return null;
  }
  return null;
}

function resolveLawName(file, fileH1) {
  if (isLawName(fileH1)) return fileH1;
  const readme = path.join(path.dirname(file), "README.md");
  if (path.resolve(readme) !== path.resolve(file)) {
    const h1 = firstH1(readme);
    if (isLawName(h1)) return h1;
  }
  const parentReadme = path.join(path.dirname(path.dirname(file)), "README.md");
  const h1 = firstH1(parentReadme);
  if (isLawName(h1)) return h1;
  return fileH1 || path.basename(path.dirname(file));
}

function pageUrl(rel) {
  const r = rel.split(path.sep).join("/");
  if (r.endsWith("README.md")) {
    const d = r.slice(0, -"README.md".length);
    return ("/" + d).replace(/\/+$/, "") + "/";
  }
  return "/" + r.slice(0, -3) + ".html";
}

function* walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === "node_modules" || name === ".vuepress") continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (name.endsWith(".md")) yield full;
  }
}

// Laws whose text must not be offered as current law. A law "leaf" directory
// carries a versions.json describing its timeline; a version is current only
// while effectiveFrom <= today < effectiveTo. Directories under /versions/ hold
// historical (repealed) or future (not yet in force) text.
//
// Why this matters: the corpus feeds an assistant that answers legal questions.
// Retrieving 环境保护法's 2015 text today would have the model cite a statute
// repealed by 生态环境法典 — confidently wrong, which is worse than no answer.
// Today's date in China Standard Time (UTC+8), as YYYY-MM-DD.
//
// The statutes take effect on Chinese calendar dates, so the comparison must
// use Asia/Shanghai rather than UTC: a UTC date lags by 8 hours, and a build
// run between midnight and 08:00 CST would still consider yesterday "today",
// serving the outgoing text on the day the new version takes effect.
function todayInChina() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function loadVersionTimelines() {
  const today = todayInChina();
  const repealedDirs = new Set();
  const timelines = new Map(); // lawDir (site-relative) -> version[]
  for (const dir of walkDirs(DOCS_DIR)) {
    const file = path.join(dir, "versions.json");
    if (!fs.existsSync(file)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const relDir = path.relative(DOCS_DIR, dir).split(path.sep).join("/");
    timelines.set(relDir, meta);
    if (meta.repealedBy) repealedDirs.add(relDir);
  }
  return { today, repealedDirs, timelines };
}

function* walkDirs(dir) {
  yield dir;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".vuepress") continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) yield* walkDirs(full);
  }
}

// The version entry that is in force today, or null when the directory is a
// repealed law. `entry` is relative to the law dir ("README.md" or
// "versions/YYYY-MM-DD/README.md").
function currentVersionOf(meta, today) {
  if (!meta || meta.repealedBy) return null;
  const versions = Array.isArray(meta.versions) ? meta.versions : [];
  return (
    versions.find(
      (v) =>
        v.effectiveFrom <= today && (!v.effectiveTo || today < v.effectiveTo)
    ) || null
  );
}

// Which law directory (site-relative, no trailing slash) owns this markdown
// file, and whether that file is the version currently in force.
function versionStatus(relSlash, timelines, repealedDirs, today) {
  // Inside <lawDir>/versions/<date>/... — always historical or future text.
  const verMatch = relSlash.match(/^(.*)\/versions\/[^/]+\//);
  if (verMatch) {
    const lawDir = verMatch[1];
    const meta = timelines.get(lawDir);
    if (repealedDirs.has(lawDir)) return { keep: false, reason: "repealed" };
    const cur = currentVersionOf(meta, today);
    const entry = cur && cur.entry ? cur.entry : "";
    if (!entry) return { keep: false, reason: "not-current" };
    // Keep the in-force version's entry and any sibling files that version
    // splits its text across (民法典-style multi-file laws).
    const entryDir = path.posix.dirname(`${lawDir}/${entry}`);
    if (path.posix.dirname(relSlash) !== entryDir) {
      return { keep: false, reason: "not-current" };
    }
    return { keep: true, lawDir };
  }
  const lawDir = path.posix.dirname(relSlash);
  const meta = timelines.get(lawDir);
  if (meta) {
    if (repealedDirs.has(lawDir)) return { keep: false, reason: "repealed" };
    const cur = currentVersionOf(meta, today);
    if (!cur) return { keep: false, reason: "not-current" };
    // A law split across several files (民法典, 生态环境法典) keeps its text in
    // sibling files next to the entry — those belong to the same version.
    // Only the entry itself is version-gated, so a root README.md stops being
    // current once a later version in versions/<date>/ takes effect.
    const entryDir = cur.entry ? path.posix.dirname(`${lawDir}/${cur.entry}`) : lawDir;
    if (lawDir !== entryDir) return { keep: false, reason: "not-current" };
    if (cur.entry && relSlash === `${lawDir}/${cur.entry}`) {
      return { keep: true, lawDir };
    }
  }
  return { keep: true, lawDir };
}

function* parseFile(file, ctx) {
  const rel = path.relative(DOCS_DIR, file);
  const relSlash = rel.split(path.sep).join("/");
  if (
    relSlash.startsWith("category/") ||
    relSlash.startsWith("references/") ||
    relSlash.startsWith("settings/") ||
    rel === "README.md"
  )
    return;

  // Skip repealed laws and versions that are not in force yet.
  const status = versionStatus(
    relSlash,
    ctx.timelines,
    ctx.repealedDirs,
    ctx.today
  );
  if (!status.keep) return;

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let fileH1 = null;
  for (const ln of lines) {
    const m = HEADING_RE.exec(ln.trim());
    if (m && m[1].length === 1) {
      fileH1 = m[2].trim();
      break;
    }
  }

  const lawName = resolveLawName(file, fileH1);
  const url = pageUrl(rel);

  let book = "";
  let chapter = "";
  let section = "";
  let cur = null; // [article_no, [body lines]]

  const flush = () => {
    if (!cur) return null;
    const [articleNo, bodyLines] = cur;
    const text = bodyLines.join("\n").trim();
    // Short keys to shrink the JSON payload (repeated 13k+ times). Only the
    // fields the client actually uses are emitted: n=law_name, a=article_no,
    // c=chapter, u=url, t=text. The unused `category`/`context` fields are
    // dropped. The corpus version is bumped so a stale schema is never mixed.
    const chunk = {
      n: lawName,
      a: articleNo,
      u: `${url}#${articleNo}`,
      t: text ? `${articleNo}　${text}` : articleNo,
    };
    if (chapter) chunk.c = chapter;
    return chunk;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const hm = HEADING_RE.exec(line.trim());
    if (hm) {
      const out = flush();
      if (out) yield out;
      cur = null;
      const kind = classifyHeading(hm[2]);
      const title = hm[2].trim();
      if (kind === "book") {
        book = title;
        chapter = "";
        section = "";
      } else if (kind === "chapter") {
        chapter = title;
        section = "";
      } else if (kind === "section") {
        section = title;
      }
      continue;
    }
    const am = ARTICLE_RE.exec(line.trim());
    if (am) {
      const out = flush();
      if (out) yield out;
      cur = [am[1], am[2] ? [am[2]] : []];
    } else {
      const pm = PLAIN_ARTICLE_RE.exec(line.trim());
      if (pm) {
        const out = flush();
        if (out) yield out;
        cur = [pm[1], pm[2] ? [pm[2]] : []];
      } else if (cur) {
        cur[1].push(line);
      }
    }
  }
  const out = flush();
  if (out) yield out;
}

export {
  ARTICLE_RE,
  HEADING_RE,
  PLAIN_ARTICLE_RE,
  classifyHeading,
  contentVersion,
  currentVersionOf,
  isLawName,
  pageUrl,
  versionStatus,
};

function encodeLocPath(pagePath) {
  // Percent-encode each path segment (spaces / CJK) for valid sitemap <loc>.
  return pagePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

// Pages that should not be advertised to crawlers: repealed / not-yet-in-force
// law versions (they must not rank as current law), the per-device settings
// page (it has no content without the user's own key), and the 404 page.
const SITEMAP_EXCLUDE = [/\/versions\//, /^\/settings\//, /^\/404\.html$/];

function buildSitemap() {
  const urls = [];
  let skipped = 0;
  for (const file of walk(DOCS_DIR)) {
    const rel = path.relative(DOCS_DIR, file);
    const url = pageUrl(rel);
    if (SITEMAP_EXCLUDE.some((re) => re.test(url))) {
      skipped++;
      continue;
    }
    urls.push(encodeLocPath(url));
  }
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url><loc>${u === "/" ? SITE_URL : SITE_URL + u.slice(1)}</loc></url>`
      )
      .join("\n") +
    "\n</urlset>\n";
  fs.writeFileSync(SITEMAP_FILE, xml);
  console.log(
    `[build-law-corpus] sitemap: ${urls.length} URLs (${skipped} excluded) -> ` +
      `${path.relative(process.cwd(), SITEMAP_FILE)}`
  );
}

function main() {
  const { today, repealedDirs, timelines } = loadVersionTimelines();
  const ctx = { today, repealedDirs, timelines };
  const docs = [];
  for (const file of walk(DOCS_DIR)) {
    for (const chunk of parseFile(file, ctx)) {
      chunk.id = docs.length;
      docs.push(chunk);
    }
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  // `version` is derived from the content, so any change to a law's text —
  // an amendment, a repeal, a fixed 条号 — changes the key and invalidates
  // every client's cached copy on its next visit.
  const version = contentVersion(docs);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ version, docs }));
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version }));
  const laws = new Set(docs.map((d) => d.n));
  const bytes = fs.statSync(OUT_FILE).size;
  console.log(
    `[build-law-corpus] ${docs.length} 法条 / ${laws.size} 部法律 -> ` +
      `${path.relative(process.cwd(), OUT_FILE)} (${(bytes / 1048576).toFixed(2)} MB, version ${version})`
  );
  buildSitemap();
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const arg = fs.realpathSync(entry);
    return self.toLowerCase() === arg.toLowerCase();
  } catch {
    // Exact match only: a fuzzy match would also fire for this file's tests
    // (build-law-corpus.test.mjs) and run main() during them.
    return path.basename(entry).toLowerCase() === "build-law-corpus.mjs";
  }
}

if (isDirectRun()) main();

