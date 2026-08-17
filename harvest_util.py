"""Helpers for the Exa harvester: path sanitizing and SSRF-safe downloads."""

from __future__ import annotations

import ipaddress
import os
import re
import socket
from urllib.parse import urljoin, urlparse

DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024  # 8 MiB
MAX_REDIRECTS = 3
_BLOCKED_HOSTS = {
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata",
}


def sanitize_filename(name: str) -> str:
    clean = re.sub(r'[<>:"/\\|?*\n\r\t]', "_", name or "").strip()
    clean = re.sub(r"\s+", " ", clean)
    return clean[:80].strip(" ._")


def _ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return bool(
        ip.is_global
        and not ip.is_multicast
        and not ip.is_unspecified
        and not ip.is_reserved
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_private
    )


def is_public_http_url(url: str, resolve: bool = True) -> bool:
    """Return True if *url* is http(s) pointing at a public host.

    ``resolve=False`` skips DNS (for unit tests / cheap pre-checks). When
    True, every resolved address must be globally routable so search-result
    URLs cannot target RFC1918, loopback, or link-local endpoints.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    if parsed.username or parsed.password:
        return False
    host = parsed.hostname
    if not host:
        return False
    if host.lower().strip(".") in _BLOCKED_HOSTS:
        return False
    try:
        ip = ipaddress.ip_address(host)
        return _ip_is_public(ip)
    except ValueError:
        pass
    if not resolve:
        return True
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False
        if not _ip_is_public(ip):
            return False
    return True


def download_raw(url: str, out_path_base: str, max_bytes: int = DOWNLOAD_MAX_BYTES) -> str | None:
    """Download HTML/PDF from a public http(s) URL, capped at *max_bytes*.

    Redirects are followed manually (up to MAX_REDIRECTS hops) so every hop
    stays inside the public-address check; each Location is resolved against
    the current URL, which relative redirects require.
    """
    import requests

    if not is_public_http_url(url, resolve=True):
        return None
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
    }
    current = url
    try:
        for _ in range(MAX_REDIRECTS + 1):
            with requests.get(
                current,
                headers=headers,
                timeout=12,
                stream=True,
                allow_redirects=False,
            ) as r:
                if r.status_code in (301, 302, 303, 307, 308):
                    loc = r.headers.get("Location") or ""
                    nxt = urljoin(current, loc)
                    if not loc or nxt == current or not is_public_http_url(nxt, resolve=True):
                        return None
                    current = nxt
                    continue
                if r.status_code != 200:
                    return None
                return _write_download(r, current, out_path_base, max_bytes)
        return None
    except Exception:
        return None


def _write_download(r, url: str, out_path_base: str, max_bytes: int) -> str | None:
    cl = r.headers.get("Content-Length")
    if cl:
        try:
            if int(cl) > max_bytes:
                return None
        except ValueError:
            pass
    ct = (r.headers.get("Content-Type") or "").lower()
    if "application/pdf" in ct or url.lower().endswith(".pdf"):
        out_path = out_path_base + ".pdf"
    else:
        out_path = out_path_base + ".html"
    written = 0
    try:
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                written += len(chunk)
                if written > max_bytes:
                    f.close()
                    try:
                        os.remove(out_path)
                    except OSError:
                        pass
                    return None
                f.write(chunk)
    except Exception:
        try:
            os.remove(out_path)
        except OSError:
            pass
        return None
    return os.path.basename(out_path)
