"""Parse the VuePress law Markdown corpus into article-level chunks.

Each chunk corresponds to one 法条 (`**第X条**　...`) together with its
chapter/section context and metadata needed for citation deep-links.
"""

import os
import re
import glob

import config

# A heading line: one or more '#', a space, then the title.
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*$")
# An article marker: **第X条**  (full-width or ascii space follows).
ARTICLE_RE = re.compile(r"^\*\*(第[\d一二三四五六七八九十百千零〇两]+条(?:之[\d一二三四五六七八九十]+)?)\*\*[\s　]*(.*)$")
# Chinese-numeral article number -> int (for sorting / metadata).
CN_NUM = {c: i for i, c in enumerate("零一二三四五六七八九")}


def cn_to_int(s):
    """Convert a Chinese numeral string (up to 万) to int. Best-effort."""
    s = s.replace("两", "二").replace("〇", "零")
    if not s:
        return None
    if s.isdigit():
        return int(s)
    units = {"十": 10, "百": 100, "千": 1000, "万": 10000}
    total, section, num = 0, 0, 0
    for ch in s:
        if ch in CN_NUM:
            num = CN_NUM[ch]
        elif ch in units:
            u = units[ch]
            if u == 10000:
                section = (section + num) * u
                total += section
                section = 0
            else:
                section += (num if num else 1) * u
            num = 0
        else:
            return None
    return total + section + num


def classify_heading(title):
    """Return 'book' | 'chapter' | 'section' | None for a heading title."""
    t = title.strip()
    if re.match(r"^第[\d一二三四五六七八九十百]+编", t) or "分编" in t:
        return "book"
    if re.match(r"^第[\d一二三四五六七八九十百]+章", t):
        return "chapter"
    if re.match(r"^第[\d一二三四五六七八九十百]+节", t):
        return "section"
    return None


def is_law_name(h1):
    """Heuristic: does an H1 look like a law title rather than a 编/章 heading?"""
    if not h1:
        return False
    if classify_heading(h1):
        return False
    return ("法" in h1) or ("宪法" in h1) or ("决定" in h1) or ("条例" in h1)


def first_h1(path):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = HEADING_RE.match(line.strip())
                if m and len(m.group(1)) == 1:
                    return m.group(2).strip()
    except FileNotFoundError:
        return None
    return None


def resolve_law_name(path, file_h1):
    """Determine the owning law name for a file."""
    if is_law_name(file_h1):
        return file_h1
    # Otherwise use the README.md of the same directory.
    readme = os.path.join(os.path.dirname(path), "README.md")
    if os.path.abspath(readme) != os.path.abspath(path):
        h1 = first_h1(readme)
        if is_law_name(h1):
            return h1
    # Walk up one more level.
    parent_readme = os.path.join(os.path.dirname(os.path.dirname(path)), "README.md")
    h1 = first_h1(parent_readme)
    if is_law_name(h1):
        return h1
    return file_h1 or os.path.basename(os.path.dirname(path))


def page_url(rel_path):
    """Map a docs-relative md path to its public VuePress URL."""
    rel = rel_path.replace(os.sep, "/")
    if rel.endswith("README.md"):
        d = rel[: -len("README.md")]
        return f"{config.SITE_BASE_URL}/{d}".rstrip("/") + "/"
    return f"{config.SITE_BASE_URL}/{rel[:-3]}.html"


def slug_of(rel_path):
    rel = rel_path.replace(os.sep, "/")
    parts = rel.split("/")
    return "/".join(parts[:-1]) if parts[-1] == "README.md" else rel[:-3]


def category_of(rel_path):
    cat_map = {
        "constitution": "宪法",
        "constitutional-relevance": "宪法相关法",
        "civil-and-commercial": "民商法",
        "administrative": "行政法",
        "economic": "经济法",
        "social": "社会法",
        "criminal-law": "刑法",
        "procedural": "程序法",
    }
    top = rel_path.replace(os.sep, "/").split("/")[0]
    return cat_map.get(top, top)


def parse_file(path):
    """Yield chunk dicts for one markdown file."""
    rel = os.path.relpath(path, config.DOCS_DIR)
    # Skip non-law pages.
    if rel.startswith("category" + os.sep) or rel == "README.md":
        return
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()

    file_h1 = None
    for ln in lines:
        m = HEADING_RE.match(ln.strip())
        if m and len(m.group(1)) == 1:
            file_h1 = m.group(2).strip()
            break

    law_name = resolve_law_name(path, file_h1)
    category = category_of(rel)
    url = page_url(rel)
    slug = slug_of(rel)

    book = chapter = section = ""
    cur = None  # current article being accumulated

    def flush(acc):
        if not acc:
            return None
        article_no, body_lines = acc
        text = "\n".join(body_lines).strip()
        ctx = " / ".join(x for x in [law_name, book, chapter, section] if x)
        num = cn_to_int(re.sub(r"^第|条.*$", "", article_no))
        return {
            "law_name": law_name,
            "category": category,
            "slug": slug,
            "book": book,
            "chapter": chapter,
            "section": section,
            "article_no": article_no,
            "article_num": num,
            "source_url": url,
            "context": ctx,
            "text": f"{article_no}　{text}" if text else article_no,
        }

    for raw in lines:
        line = raw.rstrip()
        hm = HEADING_RE.match(line.strip())
        if hm:
            out = flush(cur)
            if out:
                yield out
            cur = None
            kind = classify_heading(hm.group(2))
            title = hm.group(2).strip()
            if kind == "book":
                book, chapter, section = title, "", ""
            elif kind == "chapter":
                chapter, section = title, ""
            elif kind == "section":
                section = title
            continue
        am = ARTICLE_RE.match(line.strip())
        if am:
            out = flush(cur)
            if out:
                yield out
            cur = (am.group(1), [am.group(2)] if am.group(2) else [])
        elif cur is not None:
            cur[1].append(line)
    out = flush(cur)
    if out:
        yield out


def iter_chunks():
    paths = sorted(glob.glob(os.path.join(config.DOCS_DIR, "**", "*.md"), recursive=True))
    idx = 0
    for p in paths:
        for chunk in parse_file(p):
            chunk["chunk_id"] = f"{chunk['slug']}#{chunk['article_no']}".replace("/", "_")
            chunk["seq"] = idx
            idx += 1
            yield chunk


if __name__ == "__main__":
    import collections

    n = 0
    by_law = collections.Counter()
    samples = []
    for c in iter_chunks():
        n += 1
        by_law[c["law_name"]] += 1
        if len(samples) < 3:
            samples.append(c)
    print(f"total chunks: {n}")
    print(f"distinct laws: {len(by_law)}")
    print("top laws by article count:")
    for name, cnt in by_law.most_common(8):
        print(f"  {cnt:5d}  {name}")
    print("\nsample chunk:")
    import json

    print(json.dumps(samples[-1], ensure_ascii=False, indent=2)[:1200])
