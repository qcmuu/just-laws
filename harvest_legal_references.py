"""
Comprehensive Legal Literature & Judicial Cases Harvester via Exa.ai
Integrates 22 valid Exa API keys in parallel, performs semantic neural searches
across 8 legal categories, saves full text, metadata, and generates master index.
"""

import os
import re
import json
import time
import queue
import urllib.parse
import threading
import concurrent.futures
import requests
import yaml
from exa_py import Exa

ROOT_DIR = r"i:\AI_empower\just-laws"
REF_DIR = os.path.join(ROOT_DIR, "references")
MANIFEST_FILE = os.path.join(REF_DIR, "manifest.json")
KEYS_FILE = os.path.join(ROOT_DIR, "valid_exa_keys.txt")

# Read valid keys
with open(KEYS_FILE, "r", encoding="utf-8") as f:
    API_KEYS = [line.strip() for line in f if line.strip()]

print(f"Loaded {len(API_KEYS)} active Exa API keys.")

# Key Pool Manager
class KeyPool:
    def __init__(self, keys):
        self.keys = list(keys)
        self.lock = threading.Lock()
        self.index = 0
        self.exhausted = set()

    def get_key(self):
        with self.lock:
            if len(self.exhausted) >= len(self.keys):
                raise RuntimeError("All Exa API keys exhausted!")
            for _ in range(len(self.keys)):
                k = self.keys[self.index % len(self.keys)]
                self.index += 1
                if k not in self.exhausted:
                    return k
            raise RuntimeError("No available Exa keys remaining!")

    def mark_failed(self, key):
        with self.lock:
            self.exhausted.add(key)
            print(f"[KeyPool] Marked key as exhausted: {key[:8]}... (Remaining: {len(self.keys) - len(self.exhausted)})")

key_pool = KeyPool(API_KEYS)

# Topic and Query Definitions
TOPICS = [
    # 01 民商法
    {
        "category_id": "01_民商法_民法典与公司法",
        "category_name": "民商法与民法典专题",
        "queries": [
            {"query": "最高人民法院 民法典合同编通则司法解释 典型案例", "kind": "case", "num": 6},
            {"query": "最高人民法院 人格权侵权典型案例 裁判要点", "kind": "case", "num": 6},
            {"query": "最高人民法院 民法典物权编 担保制度司法解释 典型案例", "kind": "case", "num": 6},
            {"query": "新公司法 股东出资责任 董监高勤勉义务 司法裁判案例", "kind": "case", "num": 6},
            {"query": "民法典侵权责任编 惩罚性赔偿 典型案例与法律适用", "kind": "paper", "num": 6},
            {"query": "企业破产重整 预重整 重整计划草案 典型司法案例", "kind": "case", "num": 6},
            {"query": "最高人民法院 知识产权侵权纠纷 惩罚性赔偿 典型案例", "kind": "case", "num": 6},
            {"query": "民法典婚姻家庭编 共同债务认定 裁判规则与法理研究", "kind": "paper", "num": 6},
        ]
    },
    # 02 刑法与刑事诉讼
    {
        "category_id": "02_刑法与刑事诉讼法",
        "category_name": "刑法与刑事诉讼专题",
        "queries": [
            {"query": "最高人民法院 指导性案例 刑法 正当防卫认定规则", "kind": "case", "num": 6},
            {"query": "最高人民检察院 依法惩治电信网络诈骗 典型案例", "kind": "case", "num": 6},
            {"query": "侵犯公民个人信息罪 裁判规则 司法解释 典型案例", "kind": "case", "num": 6},
            {"query": "洗钱罪 非法集资 经济犯罪 典型案例与司法裁判", "kind": "case", "num": 6},
            {"query": "刑事诉讼法 认罪认罚从宽制度 典型案例 理论研究", "kind": "paper", "num": 6},
            {"query": "最高人民法院 依法惩治网络暴力 典型案例", "kind": "case", "num": 6},
            {"query": "刑法修正案（十二） 行贿受贿一起查 典型案例", "kind": "case", "num": 6},
        ]
    },
    # 03 经济法与财税金融
    {
        "category_id": "03_经济法与财税金融",
        "category_name": "经济法与金融监管专题",
        "queries": [
            {"query": "最高人民法院 反垄断与反不正当竞争 典型案例", "kind": "case", "num": 6},
            {"query": "证券虚假陈述民事赔偿 司法解释 典型裁判案例", "kind": "case", "num": 6},
            {"query": "商业银行法 保险法 金融纠纷 典型裁判案例", "kind": "case", "num": 6},
            {"query": "电子商务法 平台经营者责任 典型案例分析", "kind": "case", "num": 6},
            {"query": "税收征收管理法 虚开发票 逃税罪 典型司法案例", "kind": "case", "num": 6},
            {"query": "乡村振兴促进法 农村土地承包经营 典型纠纷案例", "kind": "case", "num": 6},
        ]
    },
    # 04 行政法与国家赔偿
    {
        "category_id": "04_行政法与国家赔偿",
        "category_name": "行政法与行政诉讼专题",
        "queries": [
            {"query": "最高人民法院 行政诉讼 指导性案例 裁判要旨", "kind": "case", "num": 6},
            {"query": "行政协议履行与解除 行政诉讼典型案例", "kind": "case", "num": 6},
            {"query": "政府信息公开 行政复议与行政诉讼 典型案例", "kind": "case", "num": 6},
            {"query": "行政处罚法 处罚法定 过罚相当 典型案例", "kind": "case", "num": 6},
            {"query": "国家赔偿法 刑事赔偿 行政赔偿 典型案例", "kind": "case", "num": 6},
            {"query": "行政许可与监管 营商环境法治化 典型行政法案例", "kind": "paper", "num": 6},
        ]
    },
    # 05 社会法与劳动保障
    {
        "category_id": "05_社会法与劳动保障",
        "category_name": "社会法与劳动权益专题",
        "queries": [
            {"query": "最高人民法院 新就业形态劳动者权益保障 典型案例", "kind": "case", "num": 6},
            {"query": "劳动争议仲裁与诉讼 竞业限制 典型案例", "kind": "case", "num": 6},
            {"query": "工伤认定与社会保险争议 典型司法案例", "kind": "case", "num": 6},
            {"query": "未成年人保护法 侵害未成年人权益 典型案例", "kind": "case", "num": 6},
            {"query": "安全生产法 危险化学品安全生产 事故责任典型案例", "kind": "case", "num": 6},
            {"query": "妇女权益保障法 职场性别平等 典型司法案例", "kind": "case", "num": 6},
        ]
    },
    # 06 数据与人工智能法
    {
        "category_id": "06_数据与人工智能法",
        "category_name": "数据安全与人工智能法治专题",
        "queries": [
            {"query": "生成式人工智能著作权侵权 第一案 裁判文书", "kind": "case", "num": 6},
            {"query": "数据安全法 个人信息保护法 典型执法与司法案例", "kind": "case", "num": 6},
            {"query": "人脸识别侵权 生物识别信息保护 典型案例", "kind": "case", "num": 6},
            {"query": "算法推荐 合规与法律责任 典型司法案例与学术论文", "kind": "paper", "num": 6},
            {"query": "数据资产确权 数据交易争议 裁判规则研究", "kind": "paper", "num": 6},
            {"query": "网络爬虫与数据不正当竞争 典型司法案例", "kind": "case", "num": 6},
        ]
    },
    # 07 涉外法治与国际司法
    {
        "category_id": "07_涉外法治与国际司法",
        "category_name": "涉外法治与仲裁海事专题",
        "queries": [
            {"query": "最高人民法院 涉外商事海事仲裁司法审查 典型案例", "kind": "case", "num": 6},
            {"query": "中华人民共和国外国国家豁免法 适用与法理研究", "kind": "paper", "num": 6},
            {"query": "国际民商事司法协助 域外送达与取证 典型案例", "kind": "case", "num": 6},
            {"query": "跨境破产承认与协助 司法实践与典型案例", "kind": "case", "num": 6},
            {"query": "反外国制裁法 阻断办法 法律适用与涉外法治研究", "kind": "paper", "num": 6},
        ]
    },
    # 08 宪法与国家机构
    {
        "category_id": "08_宪法与国家机构",
        "category_name": "宪法与国家治理法治专题",
        "queries": [
            {"query": "全国人大常委会 规范性文件备案审查 典型案例", "kind": "case", "num": 6},
            {"query": "合宪性审查 宪法解释 司法实践与学术论文", "kind": "paper", "num": 6},
            {"query": "监察法实施条例 职务违法调查 典型案例与法理", "kind": "case", "num": 6},
            {"query": "立法法修改 地方立法权限与协同立法 案例研究", "kind": "paper", "num": 6},
        ]
    },
]

def sanitize_filename(name):
    # Remove chars not allowed in Windows paths: < > : " / \ | ? *
    clean = re.sub(r'[<>:"/\\|?*\n\r\t]', '_', name).strip()
    clean = re.sub(r'\s+', ' ', clean)
    return clean[:80].strip(' ._')

def download_raw(url, out_path_base):
    """Attempt downloading raw source file (PDF or HTML) with timeout."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        r = requests.get(url, headers=headers, timeout=12, stream=True)
        if r.status_code == 200:
            ct = r.headers.get("Content-Type", "").lower()
            if "application/pdf" in ct or url.lower().endswith(".pdf"):
                out_path = out_path_base + ".pdf"
            else:
                out_path = out_path_base + ".html"
            with open(out_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
            return os.path.basename(out_path)
    except Exception:
        pass
    return None

def process_query_task(cat_id, cat_name, q_item, manifest, manifest_lock):
    query_str = q_item["query"]
    kind = q_item.get("kind", "case")
    num = q_item.get("num", 6)
    
    cat_dir = os.path.join(REF_DIR, cat_id)
    os.makedirs(cat_dir, exist_ok=True)

    max_attempts = 5
    results = []
    
    for attempt in range(max_attempts):
        try:
            key = key_pool.get_key()
            exa = Exa(api_key=key)
            resp = exa.search(
                query=query_str,
                type="neural",
                num_results=num,
                contents={"text": True},
            )
            results = resp.results
            break
        except Exception as e:
            err_str = str(e)
            if "401" in err_str or "402" in err_str or "403" in err_str or "CREDITS" in err_str:
                key_pool.mark_failed(key)
            else:
                print(f"[Query Error] query='{query_str}' attempt={attempt}: {e}")
                time.sleep(1)

    print(f"[{cat_name}] '{query_str}' -> fetched {len(results)} items.")

    new_items_count = 0
    for r in results:
        url = (r.url or "").strip()
        if not url or not r.text or len(r.text.strip()) < 100:
            continue

        with manifest_lock:
            if url in manifest:
                continue
            manifest[url] = True

        title = (r.title or "").strip()
        if not title:
            title = f"资料_{abs(hash(url)) % 1000000}"

        safe_title = sanitize_filename(title)
        if not safe_title:
            safe_title = f"doc_{int(time.time()*1000)}"

        item_dir = os.path.join(cat_dir, safe_title)
        # Handle directory collisions
        suffix = 1
        base_item_dir = item_dir
        while os.path.exists(item_dir):
            item_dir = f"{base_item_dir}_{suffix}"
            suffix += 1

        os.makedirs(item_dir, exist_ok=True)

        # 1. Save content.md
        content_md_path = os.path.join(item_dir, "content.md")
        header = f"# {title}\n\n- **来源 URL**：[{url}]({url})\n- **收录专题**：{cat_name}\n- **文献类型**：{'司法案例/裁判文书' if kind == 'case' else '法学文献/学术论文'}\n- **抓取时间**：{time.strftime('%Y-%m-%d %H:%M:%S')}\n\n---\n\n"
        with open(content_md_path, "w", encoding="utf-8") as f:
            f.write(header + r.text.strip())

        # 2. Try raw source download
        raw_file = download_raw(url, os.path.join(item_dir, "source"))

        # 3. Save meta.yml
        meta = {
            "title": title,
            "url": url,
            "category_id": cat_id,
            "category_name": cat_name,
            "query": query_str,
            "kind": kind,
            "score": float(r.score) if getattr(r, "score", None) is not None else None,
            "text_length": len(r.text),
            "raw_file": raw_file,
            "harvested_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        with open(os.path.join(item_dir, "meta.yml"), "w", encoding="utf-8") as f:
            yaml.dump(meta, f, allow_unicode=True, sort_keys=False)

        new_items_count += 1

    return new_items_count

def build_master_index():
    """Scan references/ and generate README.md, manifest.json and VuePress index."""
    all_items = []
    by_cat = {}

    for cat_folder in sorted(os.listdir(REF_DIR)):
        cat_path = os.path.join(REF_DIR, cat_folder)
        if not os.path.isdir(cat_path) or cat_folder.startswith("."):
            continue
        items_in_cat = []
        for item_name in sorted(os.listdir(cat_path)):
            item_path = os.path.join(cat_path, item_name)
            meta_path = os.path.join(item_path, "meta.yml")
            if os.path.isfile(meta_path):
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = yaml.safe_load(f) or {}
                meta["dir_name"] = item_name
                meta["rel_dir"] = f"references/{cat_folder}/{item_name}"
                items_in_cat.append(meta)
                all_items.append(meta)
        if items_in_cat:
            by_cat[cat_folder] = items_in_cat

    # Write manifest.json
    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(all_items, f, ensure_ascii=False, indent=2)

    # Generate references/README.md
    md_lines = [
        "# 现行法律文献与典型司法案例资源库",
        "",
        "> 基于 Exa.ai 全网学术与司法数据库检索，落地保存的真实裁判文书、指导性案例要旨、权威司法解释及法学研究文献。",
        f"> **文献总篇数**：{len(all_items)} 篇 | **分类专题数**：{len(by_cat)} 个 | **更新时间**：{time.strftime('%Y-%m-%d')}",
        "",
        "---",
        "",
        "## 专题分类导航",
        ""
    ]

    for cat_id, items in by_cat.items():
        cat_name = items[0].get("category_name", cat_id)
        md_lines.append(f"- [{cat_name} (#{cat_id})](#{cat_id}) （{len(items)} 篇）")

    md_lines.append("\n---\n")

    for cat_id, items in by_cat.items():
        cat_name = items[0].get("category_name", cat_id)
        md_lines.append(f"## <a id=\"{cat_id}\"></a>{cat_name}（共 {len(items)} 篇）\n")
        md_lines.append("| 序号 | 标题 | 类型 | 字数 | 本地正文 | 原始来源 |")
        md_lines.append("| :--- | :--- | :--- | :--- | :--- | :--- |")
        for idx, it in enumerate(items, 1):
            title = it.get("title", "未命名").replace("|", "\|")
            kind_str = "司法案例" if it.get("kind") == "case" else "法学文献"
            tlen = it.get("text_length", 0)
            rel_dir = it.get("rel_dir")
            url = it.get("url", "")
            raw = f" [`{it['raw_file']}`]({it['dir_name']}/{it['raw_file']})" if it.get("raw_file") else ""
            md_lines.append(f"| {idx} | [{title}]({it['dir_name']}/content.md) | {kind_str} | {tlen:,} 字 | [查看正文]({it['dir_name']}/content.md){raw} | [原始链接]({url}) |")
        md_lines.append("")

    with open(os.path.join(REF_DIR, "README.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines))

    # Also generate docs/references/README.md for VuePress
    docs_ref_dir = os.path.join(ROOT_DIR, "docs", "references")
    os.makedirs(docs_ref_dir, exist_ok=True)
    with open(os.path.join(docs_ref_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines))

    print(f"[MasterIndex] Generated index for {len(all_items)} documents across {len(by_cat)} categories.")

def main():
    os.makedirs(REF_DIR, exist_ok=True)
    manifest = {}
    if os.path.exists(MANIFEST_FILE):
        try:
            with open(MANIFEST_FILE, "r", encoding="utf-8") as f:
                old_list = json.load(f)
                for it in old_list:
                    manifest[it.get("url")] = True
        except Exception:
            manifest = {}

    manifest_lock = threading.Lock()

    tasks = []
    for topic in TOPICS:
        for q_item in topic["queries"]:
            tasks.append((topic["category_id"], topic["category_name"], q_item))

    print(f"Starting execution of {len(tasks)} search tasks with {len(API_KEYS)} Exa keys in parallel...")

    total_new = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = [
            executor.submit(process_query_task, cid, cname, q, manifest, manifest_lock)
            for cid, cname, q in tasks
        ]
        for f in concurrent.futures.as_completed(futures):
            try:
                cnt = f.result()
                total_new += cnt
            except Exception as e:
                print(f"Task failed with error: {e}")

    print(f"\nAll search tasks finished! Downloaded and saved {total_new} new legal documents.")
    build_master_index()

if __name__ == "__main__":
    main()
