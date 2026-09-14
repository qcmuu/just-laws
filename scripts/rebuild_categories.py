import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")

CATEGORIES = [
    ("constitutional-relevance", "宪法相关法"),
    ("civil-and-commercial", "民商法"),
    ("administrative", "行政法"),
    ("economic", "经济法"),
    ("social", "社会法"),
    ("criminal-law", "刑法"),
    ("procedural", "诉讼与非诉讼程序法"),
    ("ecological-environment", "生态环境"),
]

def get_law_title(readme_path, slug):
    if not os.path.isfile(readme_path):
        return slug
    with open(readme_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("# "):
                raw = line[2:].strip()
                # Special cases or standard prefix removal
                if raw.startswith("中华人民共和国"):
                    cleaned = raw[7:].strip()
                    if cleaned:
                        return cleaned
                return raw
    return slug

def rebuild_category(cat, title_name):
    cat_dir = os.path.join(DOCS, cat)
    if not os.path.isdir(cat_dir):
        return
    subdirs = sorted([
        d for d in os.listdir(cat_dir)
        if os.path.isdir(os.path.join(cat_dir, d)) and not d.startswith(".")
    ])
    
    cat_md = os.path.join(DOCS, "category", f"{cat}.md")
    existing_header = ""
    if os.path.isfile(cat_md):
        with open(cat_md, "r", encoding="utf-8") as f:
            content = f.read()
            # extract everything up to and including the first `# Title`
            m = re.search(r"^(.*?#\s+[^\r\n]+)", content, re.DOTALL)
            if m:
                existing_header = m.group(1).strip()
    
    if not existing_header:
        existing_header = f"---\npageClass: jl-category-index\n---\n\n# {title_name}"
        
    items = []
    for slug in subdirs:
        readme = os.path.join(cat_dir, slug, "README.md")
        title = get_law_title(readme, slug)
        if slug == "amendment" and cat == "criminal-law":
            title = "刑法修正案（一至十二）"
        items.append(f'  <a class="jl-law-index__item" href="../{cat}/{slug}/"><span class="jl-law-index__name">{title}</span></a>')
        
    new_content = f"{existing_header}\n\n<div class=\"jl-law-index\">\n" + "\n".join(items) + "\n</div>\n"
    
    with open(cat_md, "w", encoding="utf-8", newline="\n") as f:
        f.write(new_content)
    print(f"Rebuilt category/{cat}.md with {len(items)} laws.")

if __name__ == "__main__":
    for cat, title_name in CATEGORIES:
        rebuild_category(cat, title_name)
