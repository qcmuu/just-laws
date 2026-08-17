import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTICLE_RE,
  classifyHeading,
  isLawName,
  pageUrl,
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
