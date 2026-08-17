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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, "..", "..");
const OUT_FILE = path.resolve(__dirname, "..", "public", "law-corpus.json");

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*$/;
// **第X条**　... (full-width or ascii space follows). Mirrors chunker.py.
const ARTICLE_RE =
  /^\*\*(第[\d一二三四五六七八九十百千零〇两]+条(?:之[\d一二三四五六七八九十]+)?)\*\*[\s　]*(.*)$/;

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

function* parseFile(file) {
  const rel = path.relative(DOCS_DIR, file);
  const relSlash = rel.split(path.sep).join("/");
  if (relSlash.startsWith("category/") || relSlash.startsWith("references/") || rel === "README.md")
    return;

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
      u: url,
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
    } else if (cur) {
      cur[1].push(line);
    }
  }
  const out = flush();
  if (out) yield out;
}

function main() {
  const docs = [];
  for (const file of walk(DOCS_DIR)) {
    for (const chunk of parseFile(file)) {
      chunk.id = docs.length;
      docs.push(chunk);
    }
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ version: 2, docs }));
  const laws = new Set(docs.map((d) => d.n));
  const bytes = fs.statSync(OUT_FILE).size;
  console.log(
    `[build-law-corpus] ${docs.length} 法条 / ${laws.size} 部法律 -> ` +
      `${path.relative(process.cwd(), OUT_FILE)} (${(bytes / 1048576).toFixed(2)} MB)`
  );
}

main();
