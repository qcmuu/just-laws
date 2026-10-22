import test from "node:test";
import assert from "node:assert/strict";

import MiniSearch from "minisearch";

import {
  INDEX_OPTIONS,
  expandLegalQuery,
  queryTokenize,
  searchLaws,
  shouldInheritContext,
  userBigrams,
} from "../components/law-retrieve.js";

test("colloquial post-judgment question expands toward enforcement procedure", () => {
  const expanded = expandLegalQuery("案子审完后，原告还要做什么");
  assert.match(expanded, /申请执行/);
  assert.match(expanded, /民事诉讼法/);
  assert.match(expanded, /判决/);
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

test("userBigrams keeps the content words and drops chatter", () => {
  const bigrams = userBigrams("房东不退押金怎么办");
  // The subject matter must survive: these are what ranking keys on.
  assert.ok(bigrams.includes("押金"));
  assert.ok(bigrams.includes("房东"));
  // Interrogative filler must not: it would match nearly every statute.
  assert.equal(bigrams.includes("怎么"), false);
  assert.equal(bigrams.includes("什么"), false);
});

// --- follow-up detection ---

test("a short question on a new topic does not inherit the previous one", () => {
  // 10 characters, but a complete new subject; merging it into the previous
  // question ranked its sources against the wrong topic.
  assert.equal(shouldInheritContext("公司拖欠工资怎么维权"), false);
  assert.equal(shouldInheritContext("高空抛物谁负责"), false);
});

test("a continuation inherits the previous question's terms", () => {
  assert.equal(shouldInheritContext("那诉讼时效呢"), true);
  assert.equal(shouldInheritContext("那么离婚呢"), true);
  assert.equal(shouldInheritContext("还有呢"), true);
});

test("a short question with no content words inherits context", () => {
  assert.equal(shouldInheritContext("怎么办"), true);
  assert.equal(shouldInheritContext("为什么"), true);
});

test("a long standalone question never inherits context", () => {
  assert.equal(
    shouldInheritContext("我想问一下公司拖欠工资员工应该怎么维权"),
    false
  );
  assert.equal(shouldInheritContext(""), false);
});

// --- ranking behaviour, on a tiny fixture index ---

function fixtureIndex() {
  const docs = [
    // Two 公司法 articles sharing the characters 公/司/工/资 — the trap that
    // made the old OR-only ranking answer wage questions with company law.
    { id: 1, n: "中华人民共和国公司法", a: "第一条", c: "第一章", u: "/company/#1", t: "第一条　公司应当依法保护职工的合法权益，工资待遇依照公司章程。" },
    { id: 2, n: "中华人民共和国公司法", a: "第二条", c: "第一章", u: "/company/#2", t: "第二条　公司股东不得抽逃出资，公司的资本应当真实。" },
    { id: 3, n: "中华人民共和国劳动合同法", a: "第三十条", c: "第三章", u: "/labor/#30", t: "第三十条　用人单位应当按照劳动合同约定和国家规定，向劳动者及时足额支付劳动报酬。拖欠工资的，劳动者可以要求支付。" },
    { id: 4, n: "中华人民共和国劳动合同法", a: "第八十五条", c: "第七章", u: "/labor/#85", t: "第八十五条　用人单位拖欠劳动报酬、加班费的，由劳动行政部门责令限期支付。" },
    { id: 5, n: "中华人民共和国民法典", a: "第七百零三条", c: "租赁合同", u: "/civil/#703", t: "第七百零三条　租赁合同是出租人将租赁物交付承租人使用、收益，承租人支付租金的合同。" },
    { id: 6, n: "中华人民共和国民法典", a: "第七百一十四条", c: "租赁合同", u: "/civil/#714", t: "第七百一十四条　承租人应当妥善保管租赁物，因保管不善造成租赁物毁损、灭失的，应当承担赔偿责任。" },
  ];
  const mini = new MiniSearch(INDEX_OPTIONS);
  mini.addAll(docs);
  return mini;
}

test("searchLaws ranks the statute that contains the user's words first", () => {
  const mini = fixtureIndex();
  const hits = searchLaws(mini, "公司拖欠工资怎么维权", 6);
  assert.ok(hits.length > 0);
  assert.match(
    hits[0].n,
    /劳动合同法/,
    `expected 劳动合同法 first, got ${hits.map((h) => h.n).join(" / ")}`
  );
});

test("searchLaws caps how many articles come from one law", () => {
  const mini = fixtureIndex();
  const hits = searchLaws(mini, "公司拖欠工资怎么维权", 6);
  const counts = hits.reduce((acc, h) => {
    acc[h.n] = (acc[h.n] || 0) + 1;
    return acc;
  }, {});
  for (const [law, count] of Object.entries(counts)) {
    assert.ok(count <= 2, `${law} contributed ${count} of ${hits.length} hits`);
  }
});

test("searchLaws returns [] for empty or whitespace queries", () => {
  const mini = fixtureIndex();
  assert.deepEqual(searchLaws(mini, "", 6), []);
  assert.deepEqual(searchLaws(mini, "   ", 6), []);
  assert.deepEqual(searchLaws(null, "押金", 6), []);
});

test("searchLaws never returns more than topK", () => {
  const mini = fixtureIndex();
  const hits = searchLaws(mini, "租赁合同 公司 工资", 3);
  assert.ok(hits.length <= 3);
});

test("searchLaws handles non-positive and non-numeric topK", () => {
  const mini = fixtureIndex();
  for (const topK of [0, -1, NaN, "x", null]) {
    assert.deepEqual(searchLaws(mini, "押金", topK), [], `topK=${topK}`);
  }
});

test("searchLaws survives queries with no CJK content", () => {
  const mini = fixtureIndex();
  // No bigrams at all: coverage is 0 for every candidate, so ranking must fall
  // back to BM25 instead of dividing by zero.
  assert.doesNotThrow(() => searchLaws(mini, "GDPR 😀", 6));
  assert.deepEqual(searchLaws(mini, "😀😀", 6), []);
});

test("searchLaws still answers questions worded in statutory vocabulary", () => {
  // No expansion rule fires here; plain bigram coverage must carry it.
  const mini = fixtureIndex();
  const hits = searchLaws(mini, "承租人保管不善造成租赁物毁损", 6);
  assert.ok(hits.length > 0);
  assert.match(hits[0].n, /民法典/);
});
