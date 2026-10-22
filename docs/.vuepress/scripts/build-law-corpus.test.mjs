import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTICLE_RE,
  classifyHeading,
  isHistoricalVersionPage,
  isLawName,
  pageUrl,
  resolveLawName,
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

// Historical snapshots are superseded text: including them makes retrieval
// return 《法》第N条 from an obsolete version alongside the current article.
test("historical version pages are excluded from the corpus", () => {
  assert.equal(
    isHistoricalVersionPage(
      "administrative/prisons-law/versions/2026-11-01/README.md"
    ),
    true
  );
  assert.equal(
    isHistoricalVersionPage("administrative/prisons-law/README.md"),
    false
  );
  // A directory that merely contains "versions" in its name is not a snapshot.
  assert.equal(
    isHistoricalVersionPage("economic/law-versions-report/README.md"),
    false
  );
});

// A split law file titled only "修正案" is a separate statute; its articles must
// be attributed to 《X修正案》, not to the amended code.
test("resolveLawName attributes a 修正案 part to the amendment", () => {
  const docsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".."
  );
  const file = path.join(docsDir, "constitution", "05-amendment.md");
  assert.equal(resolveLawName(file, "修正案"), "中华人民共和国宪法修正案");

  const criminal = path.join(
    docsDir,
    "criminal-law",
    "criminal-law",
    "04-amendment.md"
  );
  assert.equal(resolveLawName(criminal, "修正案"), "中华人民共和国刑法修正案");
});

test("resolveLawName keeps the law name for an 附则 appendix", () => {
  const docsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".."
  );
  const file = path.join(
    docsDir,
    "criminal-law",
    "criminal-law",
    "00-supplementary.md"
  );
  assert.equal(resolveLawName(file, "附则"), "中华人民共和国刑法");
});
