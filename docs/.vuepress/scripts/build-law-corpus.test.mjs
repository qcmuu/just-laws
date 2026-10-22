import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTICLE_RE,
  PLAIN_ARTICLE_RE,
  classifyHeading,
  contentVersion,
  currentVersionOf,
  isLawName,
  pageUrl,
  versionStatus,
} from "./build-law-corpus.mjs";

test("ARTICLE_RE captures 条号 and remainder", () => {
  const m = ARTICLE_RE.exec("**第一条**　为了保护民事主体的合法权益");
  assert.ok(m);
  assert.equal(m[1], "第一条");
  assert.match(m[2], /保护民事主体/);
});

test("ARTICLE_RE accepts 之N suffix", () => {
  const m = ARTICLE_RE.exec("**第二百三十三条之一**　前款规定");
  assert.ok(m);
  assert.equal(m[1], "第二百三十三条之一");
});

test("PLAIN_ARTICLE_RE captures 刑法分则's un-bolded 之N articles", () => {
  // 刑法分则 writes 刑法修正案 additions as plain text. Missing these merged
  // 51 articles into the preceding one, e.g. 高空抛物 (291-2) disappeared into
  // 第二百九十一条 (聚众扰乱公共场所秩序).
  const m = PLAIN_ARTICLE_RE.exec(
    "第二百九十一条之二　从建筑物或者其他高空抛掷物品，情节严重的，处一年以下有期徒刑"
  );
  assert.ok(m);
  assert.equal(m[1], "第二百九十一条之二");
  assert.match(m[2], /高空抛掷物品/);
});

test("PLAIN_ARTICLE_RE ignores body lines that cite an article", () => {
  // A sentence starting with a cross-reference must not become an article.
  assert.equal(PLAIN_ARTICLE_RE.exec("第三百九十九条规定的犯罪，依照本法处罚。"), null);
  assert.equal(PLAIN_ARTICLE_RE.exec("第一百三十三条规定的行为"), null);
});

test("pageUrl maps README.md to a directory URL", () => {
  assert.equal(pageUrl("economic/seed-law/README.md"), "/economic/seed-law/");
});

test("pageUrl maps a split book file to .html", () => {
  assert.equal(
    pageUrl("civil-and-commercial/civil-code/01-general-principles.md"),
    "/civil-and-commercial/civil-code/01-general-principles.html"
  );
});

test("classifyHeading recognizes 编/章/节", () => {
  assert.equal(classifyHeading("第一编　总则"), "book");
  assert.equal(classifyHeading("第二章　自然人"), "chapter");
  assert.equal(classifyHeading("第一节　民事权利能力和民事行为能力"), "section");
  assert.equal(classifyHeading("中华人民共和国民法典"), null);
});

test("isLawName rejects structural headings", () => {
  assert.equal(isLawName("第一编　总则"), false);
  assert.equal(isLawName("中华人民共和国民法典"), true);
  assert.equal(isLawName("全国人民代表大会常务委员会关于…的决定"), true);
});

// --- version gating: the corpus must only offer law text that is in force ---

const TODAY = "2026-10-21";

test("currentVersionOf picks the version in force today", () => {
  const meta = {
    versions: [
      { id: "old", effectiveFrom: "2013-01-01", effectiveTo: "2026-11-01", entry: "README.md" },
      { id: "new", effectiveFrom: "2026-11-01", effectiveTo: null, entry: "versions/2026-11-01/README.md" },
    ],
  };
  assert.equal(currentVersionOf(meta, TODAY).id, "old");
  assert.equal(currentVersionOf(meta, "2026-11-01").id, "new");
});

test("currentVersionOf returns null for a repealed law", () => {
  const meta = {
    repealedBy: { title: "中华人民共和国生态环境法典" },
    versions: [
      { id: "2014", effectiveFrom: "2015-01-01", effectiveTo: "2026-08-15", entry: "versions/2015-01-01/README.md" },
    ],
  };
  assert.equal(currentVersionOf(meta, TODAY), null);
});

test("versionStatus drops repealed law directories and their version folders", () => {
  const timelines = new Map([
    ["administrative/environment-protection", {
      repealedBy: { title: "中华人民共和国生态环境法典" },
      versions: [{ id: "2014", effectiveFrom: "2015-01-01", effectiveTo: "2026-08-15", entry: "versions/2015-01-01/README.md" }],
    }],
  ]);
  const repealed = new Set(["administrative/environment-protection"]);
  const status = versionStatus(
    "administrative/environment-protection/versions/2015-01-01/README.md",
    timelines,
    repealed,
    TODAY
  );
  assert.equal(status.keep, false);
  assert.equal(status.reason, "repealed");
});

test("versionStatus keeps the in-force entry and drops the not-yet-in-force one", () => {
  // Prisons law: 2012 text in force until 2026-11-01; 2026 revision after that.
  const timelines = new Map([
    ["administrative/prisons-law", {
      versions: [
        { id: "2012", effectiveFrom: "2013-01-01", effectiveTo: "2026-11-01", entry: "README.md" },
        { id: "2026", effectiveFrom: "2026-11-01", effectiveTo: null, entry: "versions/2026-11-01/README.md" },
      ],
    }],
  ]);
  const repealed = new Set();
  assert.equal(
    versionStatus("administrative/prisons-law/README.md", timelines, repealed, TODAY).keep,
    true
  );
  assert.equal(
    versionStatus("administrative/prisons-law/versions/2026-11-01/README.md", timelines, repealed, TODAY).keep,
    false
  );
  // After the revision takes effect the roles swap.
  assert.equal(
    versionStatus("administrative/prisons-law/README.md", timelines, repealed, "2026-11-01").keep,
    false
  );
  assert.equal(
    versionStatus("administrative/prisons-law/versions/2026-11-01/README.md", timelines, repealed, "2026-11-01").keep,
    true
  );
});

test("versionStatus keeps sibling files of a multi-file law", () => {
  // 生态环境法典 is one law split across 5 编 files next to README.md. Gating
  // the version must not drop the 编 files as "not the entry".
  const timelines = new Map([
    ["ecological-environment/ecological-environment-code", {
      versions: [{ id: "code", effectiveFrom: "2026-08-15", effectiveTo: null, entry: "README.md" }],
    }],
  ]);
  const repealed = new Set();
  for (const f of ["README.md", "01-general-principles.md", "05-legal-liability-and-supplementary.md"]) {
    const status = versionStatus(
      `ecological-environment/ecological-environment-code/${f}`,
      timelines,
      repealed,
      TODAY
    );
    assert.equal(status.keep, true, `${f} should be kept`);
  }
});

// --- content version: cache invalidation must be automatic ---

test("contentVersion is stable for identical content", () => {
  const docs = [
    { n: "中华人民共和国劳动法", a: "第一条", u: "/social/labor-law/#第一条", t: "第一条　为了…", c: "第一章　总则" },
  ];
  assert.equal(contentVersion(docs), contentVersion([{ ...docs[0] }]));
});

test("contentVersion changes when any article text changes", () => {
  const base = [
    { n: "中华人民共和国劳动法", a: "第一条", u: "/social/labor-law/#第一条", t: "第一条　为了…" },
  ];
  const amended = [{ ...base[0], t: "第一条　为了（修正）…" }];
  assert.notEqual(contentVersion(base), contentVersion(amended));
});

test("contentVersion changes when a law is removed", () => {
  const a = { n: "甲法", a: "第一条", u: "/a/#第一条", t: "第一条　甲" };
  const b = { n: "乙法", a: "第一条", u: "/b/#第一条", t: "第一条　乙" };
  assert.notEqual(contentVersion([a, b]), contentVersion([a]));
});

test("contentVersion does not collide across field boundaries", () => {
  // A naive join("\u0000") would merge these into the same string.
  const x = { n: "甲", a: "乙", u: "/u/", t: "丙" };
  const y = { n: "甲乙", a: "", u: "/u/", t: "丙" };
  assert.notEqual(contentVersion([x]), contentVersion([y]));
});

test("versionStatus keeps ordinary law files", () => {
  const status = versionStatus(
    "economic/seed-law/README.md",
    new Map(),
    new Set(),
    TODAY
  );
  assert.equal(status.keep, true);
});
