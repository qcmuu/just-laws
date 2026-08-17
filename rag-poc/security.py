"""Small, dependency-free helpers for the RAG HTTP layer.

Kept separate from FastAPI so unit tests can cover IP parsing and auth
without importing the LLM / vector stack.
"""

from __future__ import annotations

import hmac
import ipaddress
import re

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def validate_pg_table(name: str) -> str:
    """Reject identifiers that would be unsafe in interpolated SQL."""
    if not name or not _IDENT_RE.fullmatch(name):
        raise ValueError(f"invalid PG_TABLE: {name!r}")
    return name


def pick_client_ip(
    header_name: str | None,
    header_value: str | None,
    peer: str | None,
) -> str:
    """Resolve the client IP for rate limiting.

    - ``X-Real-IP`` / ``Fly-Client-IP``: a single address written by the
      reverse proxy / edge. Note Fly does NOT write ``X-Real-IP``; use
      ``fly-client-ip`` there, or clients can spoof it.
    - ``X-Forwarded-For``: use the *rightmost* hop. The leftmost value is
      attacker-controlled; nginx's ``$proxy_add_x_forwarded_for`` appends the
      real peer at the end.

    The chosen value must parse as an IP address; otherwise we fall back to
    the socket peer so a spoofed header can never mint fresh rate-limit keys.
    """
    if header_name and header_value:
        parts = [p.strip() for p in header_value.split(",") if p.strip()]
        candidate = parts[-1] if header_name.lower().replace("_", "-") == "x-forwarded-for" else parts[0]
        try:
            ipaddress.ip_address(candidate)
            return candidate
        except ValueError:
            pass
    return peer or "unknown"


def api_key_ok(expected: str, x_api_key: str, authorization: str) -> bool:
    """Constant-time compare of CHAT_API_KEY against request headers."""
    if not expected:
        return True
    got = (x_api_key or "").strip()
    auth = authorization or ""
    if auth.lower().startswith("bearer "):
        got = got or auth[7:].strip()
    if not got:
        return False
    try:
        return hmac.compare_digest(got, expected)
    except (TypeError, ValueError):
        return False
