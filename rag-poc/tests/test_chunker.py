import os
import shutil
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import config  # noqa: E402
from chunker import parse_file  # noqa: E402


class ChunkerTests(unittest.TestCase):
    def test_parses_article_and_attaches_fragment(self):
        text = (
            "# 中华人民共和国测试法\n\n"
            "## 第一章　总则\n\n"
            "**第一条**　为了测试切条。\n"
            "续行仍属第一条。\n\n"
            "**第二条**　另一条。\n"
        )
        d = os.path.join(config.DOCS_DIR, ".chunker-test-tmp")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "README.md")
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            chunks = list(parse_file(path))
        finally:
            shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0]["article_no"], "第一条")
        self.assertIn("为了测试切条", chunks[0]["text"])
        self.assertTrue(chunks[0]["source_url"].endswith("#第一条"))
        self.assertEqual(chunks[1]["article_no"], "第二条")

    def test_skips_references_index(self):
        # parse_file skips by docs-relative path; a file whose relpath starts
        # with references/ yields nothing.
        import chunker
        import config

        fake = os.path.join(config.DOCS_DIR, "references", "README.md")
        if not os.path.isfile(fake):
            self.skipTest("docs/references/README.md not present")
        self.assertEqual(list(chunker.parse_file(fake)), [])


if __name__ == "__main__":
    unittest.main()
