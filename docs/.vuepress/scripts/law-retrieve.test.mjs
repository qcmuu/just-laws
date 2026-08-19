import test from "node:test";
import assert from "node:assert/strict";

import {
  expandLegalQuery,
  queryTokenize,
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
