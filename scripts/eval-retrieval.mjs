#!/usr/bin/env node
/**
 * Retrieval quality harness for the in-browser law search.
 *
 * Builds the same MiniSearch index the browser does, runs three query sets, and
 * reports how often an expected statute appears in the top-K actually sent to
 * the model. Run it after touching `law-retrieve.js` (tokenizer, ranking,
 * EXPANDERS) or the corpus builder.
 *
 * The three sets exist to keep the measurement honest:
 *   dev   — the queries used while shaping the ranking and EXPANDERS.
 *           Optimising against this one is how the first version ended up at
 *           68% on unseen questions while looking perfect here.
 *   hold  — written later, never used for tuning.
 *   test  — written last; treat a drop here as a regression.
 *
 * Usage: node scripts/eval-retrieval.mjs [--json]
 * Requires: npm run build:corpus
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import MiniSearch from "minisearch";

import { INDEX_OPTIONS, searchLaws } from "../docs/.vuepress/components/law-retrieve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CORPUS = path.join(ROOT, "docs/.vuepress/public/law-corpus.json");
const SETS_FILE = path.join(__dirname, "eval-queries.json");

const TOP_K = 6; // must match LawChatWidget's TOP_K

const sets = JSON.parse(fs.readFileSync(SETS_FILE, "utf8"));

if (!fs.existsSync(CORPUS)) {
  console.error("Missing law-corpus.json — run `npm run build:corpus` first.");
  process.exit(1);
}
const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
const mini = new MiniSearch(INDEX_OPTIONS);
mini.addAll(corpus.docs);

const results = {};
for (const [split, cases] of Object.entries(sets)) {
  const rows = cases.map(({ query, expect: expected }) => {
    const laws = searchLaws(mini, query, TOP_K).map((h) => h.n);
    const ok = laws.some((name) => expected.some((e) => name.includes(e)));
    return { query, expected, laws, ok };
  });
  results[split] = {
    total: rows.length,
    pass: rows.filter((r) => r.ok).length,
    rows,
  };
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const [split, r] of Object.entries(results)) {
    const pct = ((r.pass / r.total) * 100).toFixed(0);
    console.log(`${split.padEnd(5)} ${r.pass}/${r.total} = ${pct}%`);
    for (const row of r.rows.filter((x) => !x.ok)) {
      console.log(`  MISS ${row.query}`);
      console.log(`       expected ${row.expected.join(" | ")}`);
      console.log(`       got      ${row.laws.join(" / ") || "(none)"}`);
    }
  }
  const all = Object.values(results);
  const pass = all.reduce((s, r) => s + r.pass, 0);
  const total = all.reduce((s, r) => s + r.total, 0);
  console.log(`\noverall ${pass}/${total} = ${((pass / total) * 100).toFixed(0)}%`);
}
