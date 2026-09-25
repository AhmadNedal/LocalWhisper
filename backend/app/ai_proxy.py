"""Free AI through the account server instead of a Groq key shipped in the app.

When a user has no Groq key of their own, the desktop app passes
``lt-proxy:<sign-in token>`` as the "key". Requests that would go to
``https://api.groq.com/openai/v1/...`` then go to ``<server>/api/ai/...`` with the
token; the server adds the real key and applies a daily allowance per user.
The server address comes from TRANSCRIBER_AI_PROXY (set by Electron from auth-config.json).
"""

from __future__ import annotations

import os

from .errors import AppError, ErrorCode

PREFIX = "lt-proxy:"
_GROQ = "https://api.groq.com/openai/v1/"


def is_proxy(api_key: str) -> bool:
    return api_key.strip().startswith(PREFIX)


def route(url: str, api_key: str) -> tuple[str, dict[str, str]]:
    """(url, headers) for a Groq request made with a proxy "key"."""
    base = os.environ.get("TRANSCRIBER_AI_PROXY", "").rstrip("/")
    if not base:
        raise AppError(ErrorCode.FREE_AI_UNAVAILABLE, "The free AI server is not configured")
    if not url.startswith(_GROQ):
        raise AppError(ErrorCode.CLOUD_AUTH, "The free AI only covers Groq; add your own key for this provider")
    token = api_key.strip()[len(PREFIX):]
    return f"{base}/api/ai/{url[len(_GROQ):]}", {"Authorization": f"Bearer {token}"}


def bearer(url: str, api_key: str) -> tuple[str, dict[str, str]]:
    """(url, headers) for an OpenAI-style request: direct with the user's key, or via the proxy."""
    if is_proxy(api_key):
        return route(url, api_key)
    return url, {"Authorization": f"Bearer {api_key.strip()}"}


def error(status: int, text: str) -> AppError | None:
    """The proxy's own errors (daily allowance, sign-in) → app errors; None = not one of them."""
    import json

    try:
        data = json.loads(text)
        code = str(data.get("code", "")) if isinstance(data, dict) else ""
    except ValueError:
        data, code = {}, ""
    if code == "ai_daily_limit":
        return AppError(ErrorCode.FREE_LIMIT, str(data.get("message", ""))[:300])
    if status in (401, 403) or code in ("unauthorized", "ai_disabled"):
        return AppError(ErrorCode.FREE_AI_UNAVAILABLE, f"free_ai:{code or status}")
    return None
