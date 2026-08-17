import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))

import harvest_util  # noqa: E402
from harvest_util import is_public_http_url, sanitize_filename  # noqa: E402


class SanitizeTests(unittest.TestCase):
    def test_strips_windows_illegal_chars(self):
        self.assertEqual(sanitize_filename('a<>:"/\\|?*b'), "a_________b")

    def test_empty_becomes_empty(self):
        self.assertEqual(sanitize_filename("   "), "")


class UrlGuardTests(unittest.TestCase):
    def test_rejects_non_http(self):
        self.assertFalse(is_public_http_url("file:///etc/passwd", resolve=False))
        self.assertFalse(is_public_http_url("javascript:alert(1)", resolve=False))

    def test_rejects_loopback_and_private_ip(self):
        self.assertFalse(is_public_http_url("http://127.0.0.1/x", resolve=False))
        self.assertFalse(is_public_http_url("http://10.0.0.5/x", resolve=False))
        self.assertFalse(is_public_http_url("http://192.168.1.1/x", resolve=False))
        self.assertFalse(is_public_http_url("http://169.254.169.254/", resolve=False))

    def test_rejects_localhost_name(self):
        self.assertFalse(is_public_http_url("http://localhost/admin", resolve=False))

    def test_allows_public_hostname_without_dns(self):
        self.assertTrue(is_public_http_url("https://www.court.gov.cn/path", resolve=False))

    def test_rejects_userinfo(self):
        self.assertFalse(
            is_public_http_url("https://user:pass@example.com/", resolve=False)
        )


class DownloadRedirectTests(unittest.TestCase):
    """download_raw redirect handling, with requests and DNS mocked out."""

    @staticmethod
    def _resp(status, headers=None, body=b"abc"):
        r = mock.MagicMock()
        # `with requests.get(...) as r:` must yield the same mock.
        r.__enter__.return_value = r
        r.__exit__.return_value = False
        r.status_code = status
        r.headers = headers or {}
        r.iter_content = mock.Mock(return_value=iter([body]))
        return r

    def test_relative_then_absolute_redirect_followed(self):
        import requests as requests_mod

        hops = [
            self._resp(302, {"Location": "/doc.pdf"}),
            self._resp(301, {"Location": "https://cdn.example.com/doc.pdf"}),
            self._resp(200, {"Content-Type": "application/pdf", "Content-Length": "3"}),
        ]
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(
                harvest_util, "is_public_http_url", return_value=True
            ), mock.patch.object(requests_mod, "get", side_effect=hops) as get:
                name = harvest_util.download_raw("https://example.com/page", os.path.join(td, "out"))
            self.assertEqual(name, "out.pdf")
            self.assertTrue(os.path.exists(os.path.join(td, "out.pdf")))
            requested = [c.args[0] for c in get.call_args_list]
            self.assertEqual(
                requested,
                [
                    "https://example.com/page",
                    "https://example.com/doc.pdf",
                    "https://cdn.example.com/doc.pdf",
                ],
            )

    def test_stops_after_max_hops(self):
        import requests as requests_mod

        redirect_forever = [
            self._resp(302, {"Location": f"https://example.com/hop{i}"})
            for i in range(harvest_util.MAX_REDIRECTS + 2)
        ]
        with mock.patch.object(
            harvest_util, "is_public_http_url", return_value=True
        ), mock.patch.object(requests_mod, "get", side_effect=redirect_forever) as get:
            self.assertIsNone(
                harvest_util.download_raw("https://example.com/page", "/tmp/never-written")
            )
        self.assertEqual(get.call_count, harvest_util.MAX_REDIRECTS + 1)

    def test_redirect_to_private_target_rejected(self):
        import requests as requests_mod

        hops = [
            self._resp(302, {"Location": "http://192.168.1.1/secret"}),
        ]
        with mock.patch.object(
            harvest_util, "is_public_http_url", side_effect=lambda u, resolve=True: u == "https://example.com/page"
        ), mock.patch.object(requests_mod, "get", side_effect=hops):
            self.assertIsNone(
                harvest_util.download_raw("https://example.com/page", "/tmp/never-written")
            )


if __name__ == "__main__":
    unittest.main()
