import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import MiniSearch from "minisearch";

import {
  expandLegalQuery,
  queryTokenize,
  cjkTokenize,
  searchLaws,
  executionIntentTerms,
  appealIntentTerms,
} from "../components/law-retrieve.js";
import {
  createRequestGeneration,
  applyIfCurrent,
} from "../components/law-chat-request.js";

test("post-judgment next-step expands to civil execution, not from 原告 alone", () => {
  const expanded = expandLegalQuery("案子审完后，原告还要做什么");
  assert.match(expanded, /申请执行/);
  assert.match(expanded, /民事诉讼法/);
  assert.match(expanded, /判决/);
  assert.equal(expanded.includes("强制执行"), false);
});

test("role word or 怎么办 alone does not expand to execution", () => {
  assert.equal(executionIntentTerms("原告还要做什么"), "");
  assert.equal(executionIntentTerms("租房到期房东不退押金怎么办"), "");
  assert.doesNotMatch(
    expandLegalQuery("租房到期房东不退押金怎么办"),
    /申请执行|强制执行|执行程序/,
  );
  assert.doesNotMatch(expandLegalQuery("原告去哪立案"), /申请执行|强制执行/);
});

test("losing plaintiff expands to appeal, not execution", () => {
  const expanded = expandLegalQuery("原告败诉了怎么办");
  assert.match(expanded, /上诉/);
  assert.match(expanded, /民事诉讼法/);
  assert.doesNotMatch(expanded, /申请执行|强制执行/);
  assert.equal(appealIntentTerms("原告败诉了怎么办"), "上诉 第二审 民事诉讼法");
  assert.equal(executionIntentTerms("原告败诉了怎么办"), "");
});

test("won + nonperformance is combination execution intent", () => {
  assert.match(expandLegalQuery("胜诉了对方不给钱怎么办"), /申请执行/);
  assert.doesNotMatch(expandLegalQuery("我胜诉了"), /申请执行/);
});

test("query tokenizer keeps legal bigrams and drops chatter unigrams", () => {
  const tokens = queryTokenize("案子审完后原告还要做什么");
  assert.ok(tokens.includes("原告"));
  assert.ok(tokens.includes("案子"));
  assert.equal(tokens.includes("后"), false);
  assert.equal(tokens.includes("要"), false);
  assert.equal(tokens.includes("做"), false);
});

test("empty query stays empty", () => {
  assert.equal(expandLegalQuery("   "), "");
  assert.deepEqual(queryTokenize(""), []);
});

test("new chat then immediate ask: stale request cannot unlock loading", async () => {
  const gate = createRequestGeneration();
  const ui = { loading: false, controller: null, sources: null };

  const runAsk = async (delayMs, hits) => {
    const id = gate.next();
    ui.loading = true;
    ui.controller = { id };
    await new Promise((r) => setTimeout(r, delayMs));
    applyIfCurrent(gate, id, () => {
      ui.sources = hits;
    });
    applyIfCurrent(gate, id, () => {
      ui.loading = false;
      ui.controller = null;
    });
    return id;
  };

  const first = runAsk(20, "old-hits");
  // 新对话 invalidates generation, then a new question starts immediately.
  gate.next();
  ui.loading = false;
  ui.controller = null;
  const second = runAsk(5, "new-hits");
  const [id1, id2] = await Promise.all([first, second]);

  assert.equal(gate.isLive(id1), false);
  assert.equal(gate.isLive(id2), true);
  assert.equal(ui.sources, "new-hits");
  assert.equal(ui.loading, false);
  assert.equal(ui.controller, null);
});

test("stale finally cannot null the live AbortController", async () => {
  const gate = createRequestGeneration();
  const ui = { loading: true, controller: "live" };
  const staleId = gate.next();
  gate.next(); // newChat
  const liveId = gate.next();
  ui.controller = "ask-2";
  ui.loading = true;

  applyIfCurrent(gate, staleId, () => {
    ui.loading = false;
    ui.controller = null;
  });
  assert.equal(ui.loading, true);
  assert.equal(ui.controller, "ask-2");
  assert.equal(gate.isLive(liveId), true);
});

const CORPUS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public/law-corpus.json",
);

test(
  "real corpus Top-K: deposit / post-judgment / losing-plaintiff",
  { timeout: 120000 },
  async (t) => {
    if (!fs.existsSync(CORPUS_PATH)) {
      t.skip("law-corpus.json is not built");
      return;
    }
    const data = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"));
    assert.ok(data.docs && data.docs.length > 10000, "corpus too small");
    const mini = new MiniSearch({
      fields: ["t", "n", "c"],
      storeFields: ["n", "a", "c", "u", "t"],
      tokenize: cjkTokenize,
    });
    mini.addAll(data.docs);

    const names = (q, k = 6) => searchLaws(mini, q, k).map((h) => h.n);
    const noneAdminForce = (hits) =>
      hits.every((n) => !String(n).includes("行政强制法"));

    const deposit = names("租房到期房东不退押金怎么办");
    assert.equal(deposit.filter((n) => n.includes("行政强制法")).length, 0);
    assert.ok(
      deposit.some((n) => n.includes("民法典")),
      `expected 民法典 in ${deposit.join(" | ")}`,
    );

    const postJudgment = names("案子审完后原告还要做什么");
    assert.ok(noneAdminForce(postJudgment), postJudgment.join(" | "));
    assert.ok(
      postJudgment.some((n) => n.includes("民事诉讼法")),
      postJudgment.join(" | "),
    );

    const lost = names("原告败诉了怎么办");
    assert.ok(noneAdminForce(lost), lost.join(" | "));
    const lostHits = searchLaws(mini, "原告败诉了怎么办", 6);
    assert.equal(
      lostHits.filter((h) => /执行的申请和移送/.test(h.c || "")).length,
      0,
    );
  },
);
