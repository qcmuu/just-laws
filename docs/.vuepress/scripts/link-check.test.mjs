// Guards against shipping internal links that 404.
//
// VuePress does not validate navbar/sidebar/link targets, and the default
// theme writes category pages as `category/foo.html`, so a hand-written link to
// `/category/foo` silently becomes a dead end. This test walks the built site
// and fails if any internal href has no corresponding output file.
//
// It needs `docs:build` output, so it is a separate script (`npm run
// test:links`) rather than part of `npm test`, which must stay fast and
// dependency-free for CI before a build exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve(import.meta.dirname, "..", "dist");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function toUrlPath(file) {
  return "/" + path.relative(DIST, file).split(path.sep).join("/");
}

test("every internal link resolves to a built file", (t) => {
  if (!fs.existsSync(DIST)) {
    t.skip("dist/ not built — run `npm run docs:build` first");
    return;
  }

  const files = walk(DIST);
  const fileSet = new Set(files.map(toUrlPath));
  const served = (href) => {
    const clean = href.split("#")[0].split("?")[0];
    if (!clean) return true;
    if (fileSet.has(clean)) return true;
    if (fileSet.has(clean.endsWith("/") ? clean + "index.html" : clean + "/index.html")) return true;
    return fileSet.has(clean + ".html");
  };

  const broken = new Map();
  for (const file of files) {
    if (!file.endsWith(".html")) continue;
    const html = fs.readFileSync(file, "utf8");
    for (const m of html.matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      if (!href.startsWith("/") || href.startsWith("//")) continue;
      if (!served(href) && !broken.has(href)) broken.set(href, toUrlPath(file));
    }
  }

  const report = [...broken.entries()]
    .map(([href, page]) => `${href}  (linked from ${page})`)
    .join("\n");
  assert.equal(broken.size, 0, `broken internal links:\n${report}`);
});
