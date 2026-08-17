import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import security  # noqa: E402


class PickClientIpTests(unittest.TestCase):
    def test_prefers_x_real_ip_first_value(self):
        self.assertEqual(
            security.pick_client_ip("x-real-ip", "203.0.113.9, 10.0.0.1", "127.0.0.1"),
            "203.0.113.9",
        )

    def test_xff_uses_rightmost_hop(self):
        # Client can prepend 1.2.3.4; nginx appends the real peer last.
        self.assertEqual(
            security.pick_client_ip(
                "x-forwarded-for",
                "1.2.3.4, 203.0.113.9",
                "127.0.0.1",
            ),
            "203.0.113.9",
        )

    def test_falls_back_to_peer(self):
        self.assertEqual(security.pick_client_ip("x-real-ip", None, "10.1.1.1"), "10.1.1.1")
        self.assertEqual(security.pick_client_ip(None, None, None), "unknown")

    def test_spoofed_non_ip_value_fails_closed_to_peer(self):
        # A garbage or attacker-minted value must not become a rate-limit key.
        self.assertEqual(security.pick_client_ip("x-real-ip", "not-an-ip", "10.1.1.1"), "10.1.1.1")
        self.assertEqual(security.pick_client_ip("fly-client-ip", "", "10.1.1.1"), "10.1.1.1")

    def test_non_ip_xff_value_falls_back_to_peer(self):
        self.assertEqual(
            security.pick_client_ip("x-forwarded-for", "1.2.3.4, bogus", "10.1.1.1"),
            "10.1.1.1",
        )


class ApiKeyTests(unittest.TestCase):
    def test_empty_expected_allows_all(self):
        self.assertTrue(security.api_key_ok("", "", ""))

    def test_x_api_key_header(self):
        self.assertTrue(security.api_key_ok("secret", "secret", ""))
        self.assertFalse(security.api_key_ok("secret", "nope", ""))

    def test_bearer_header(self):
        self.assertTrue(security.api_key_ok("secret", "", "Bearer secret"))
        self.assertFalse(security.api_key_ok("secret", "", "Bearer nope"))
        self.assertFalse(security.api_key_ok("secret", "", ""))


class PgTableTests(unittest.TestCase):
    def test_accepts_plain_ident(self):
        self.assertEqual(security.validate_pg_table("law_chunks"), "law_chunks")

    def test_rejects_injection(self):
        with self.assertRaises(ValueError):
            security.validate_pg_table("law_chunks; drop table x")
        with self.assertRaises(ValueError):
            security.validate_pg_table("")


if __name__ == "__main__":
    unittest.main()
