"""Entrypoint alias so the app is importable as either `app:app` or `main:app`."""

from app import app

__all__ = ["app"]
