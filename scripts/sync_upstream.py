"""
Upstream Synchronization Engine for JustLaws AI
Safely synchronizes statutory Markdown documents from upstream (ImCa0/just-laws)
while strictly preserving JustLaws AI branding, client-side BYOK RAG components,
Exa reference banks, configuration files, and GitHub Pages workflows.
"""

import os
import sys
import subprocess
import shutil

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPSTREAM_REMOTE = "upstream"
UPSTREAM_URL = "https://github.com/ImCa0/just-laws.git"

# Folders to sync statutory laws from upstream
LAW_DOC_FOLDERS = [
    "docs/constitution",
    "docs/constitutional-relevance",
    "docs/civil-and-commercial",
    "docs/administrative",
    "docs/economic",
    "docs/social",
    "docs/criminal-law",
    "docs/procedural",
    "docs/ecological-environment",
]

def run_cmd(cmd, cwd=ROOT_DIR):
    print(f"-> {cmd}")
    res = subprocess.run(cmd, shell=True, cwd=cwd, text=True, capture_output=True)
    if res.returncode != 0:
        print(f"Error: {res.stderr.strip()}")
    else:
        if res.stdout.strip():
            print(res.stdout.strip())
    return res

def ensure_upstream_remote():
    res = run_cmd("git remote -v")
    if UPSTREAM_REMOTE not in res.stdout:
        print(f"Adding upstream remote: {UPSTREAM_URL}")
        run_cmd(f"git remote add {UPSTREAM_REMOTE} {UPSTREAM_URL}")
    print("Fetching upstream...")
    run_cmd(f"git fetch {UPSTREAM_REMOTE}")

def sync_statutory_laws():
    print("\n--- Syncing Statutory Markdown Documents from Upstream ---")
    for folder in LAW_DOC_FOLDERS:
        print(f"Syncing: {folder} ...")
        run_cmd(f"git checkout {UPSTREAM_REMOTE}/master -- {folder}")

def rebuild_corpus_and_verify():
    print("\n--- Rebuilding Law Corpus JSON ---")
    run_cmd("node docs/.vuepress/scripts/build-law-corpus.mjs")
    print("\n--- Verifying VuePress Build ---")
    run_cmd("npm run docs:build")

def main():
    print("=== JustLaws AI - Upstream Synchronization Tool ===")
    ensure_upstream_remote()
    sync_statutory_laws()
    rebuild_corpus_and_verify()
    print("\n✅ Upstream sync and verification completed successfully!")

if __name__ == "__main__":
    main()
