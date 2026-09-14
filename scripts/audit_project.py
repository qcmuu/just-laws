import os
import re
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")

def audit_categories():
    print("=== 1. Category Index vs Directory Coverage ===")
    categories = [
        "constitutional-relevance", "civil-and-commercial", "administrative",
        "economic", "social", "criminal-law", "procedural", "ecological-environment"
    ]
    for cat in categories:
        cat_dir = os.path.join(DOCS, cat)
        if not os.path.isdir(cat_dir):
            continue
        subdirs = sorted([
            d for d in os.listdir(cat_dir)
            if os.path.isdir(os.path.join(cat_dir, d)) and not d.startswith(".")
        ])
        cat_md = os.path.join(DOCS, "category", f"{cat}.md")
        if not os.path.isfile(cat_md):
            print(f"[{cat}] Missing category/{cat}.md! Subdirs count: {len(subdirs)}")
            continue
        with open(cat_md, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Match both href="../cat/slug" and markdown [Name](../cat/slug/)
        links = set()
        for m in re.finditer(r'href=[\'"][^\'"]*?' + cat + r'/([^/\'"#]+)', content):
            links.add(m.group(1))
        for m in re.finditer(r'\]\(\.\./' + cat + r'/([^/\)#]+)', content):
            links.add(m.group(1))
            
        missing_in_index = set(subdirs) - links
        print(f"[{cat}] Subdirs: {len(subdirs)}, Links in index: {len(links)}, Missing: {len(missing_in_index)}")
        if missing_in_index:
            print(f"   -> Missing from {cat}.md: {sorted(list(missing_in_index))[:5]} (total {len(missing_in_index)})")

def audit_corpus():
    print("\n=== 2. Law Corpus Audit ===")
    corpus_path = os.path.join(DOCS, ".vuepress", "public", "law-corpus.json")
    if not os.path.isfile(corpus_path):
        print("law-corpus.json does not exist!")
        return
    with open(corpus_path, "r", encoding="utf-8") as f:
        corpus = json.load(f)
    docs = corpus.get("docs", [])
    print(f"law-corpus.json version: {corpus.get('version')}, docs count: {len(docs)}")
    
    empty_laws = [a for a in docs if not a.get("n")]
    empty_articles = [a for a in docs if not a.get("a")]
    empty_content = [a for a in docs if not a.get("t")]
    empty_urls = [a for a in docs if not a.get("u")]
    print(f"Articles without law name (n): {len(empty_laws)}")
    print(f"Articles without article number (a): {len(empty_articles)}")
    print(f"Articles without content (t): {len(empty_content)}")
    print(f"Articles without url (u): {len(empty_urls)}")

def audit_navbar_links():
    print("\n=== 3. Navbar & Sidebar Dead Links ===")
    config_path = os.path.join(DOCS, ".vuepress", "config.js")
    with open(config_path, "r", encoding="utf-8") as f:
        config_text = f.read()
    
    links = re.findall(r'link:\s*[\'"](/[^\'"]+)[\'"]', config_text)
    print(f"Found {len(links)} links in config.js")
    broken = []
    for link in links:
        # Resolve to file in docs/
        clean_link = link.strip("/")
        # could be directory with README.md or file.md
        candidate1 = os.path.join(DOCS, clean_link, "README.md")
        candidate2 = os.path.join(DOCS, clean_link + ".md")
        candidate3 = os.path.join(DOCS, clean_link)
        if not (os.path.exists(candidate1) or os.path.exists(candidate2) or os.path.exists(candidate3)):
            broken.append(link)
    if broken:
        print(f"Broken links found in config.js ({len(broken)}): {broken}")
    else:
        print("All navbar/sidebar links resolve cleanly to filesystem!")

if __name__ == "__main__":
    audit_categories()
    audit_corpus()
    audit_navbar_links()
