"""Static assets must be exempt from hosted-mode rate limiting.

Regression test for the hosted-boot failure where a cold app load (60+ ES
module fetches over HTTP/2) tripped the global per-IP burst limit and 429'd
part of the app's own import graph — main.js never finished booting, so
state._hosted was never set and hosted gating / the upload notice silently
disabled themselves.
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.rate_limit import RateLimitMiddleware, _is_static_asset


def _make_app() -> FastAPI:
    app = FastAPI()

    @app.get("/module.js")
    def module():
        return {"ok": True}

    @app.get("/")
    def index():
        return {"ok": True}

    @app.get("/api-endpoint")
    def api():
        return {"ok": True}

    app.add_middleware(RateLimitMiddleware, hosted=True)
    return app


def test_is_static_asset_classifier():
    assert _is_static_asset("GET", "/")
    assert _is_static_asset("GET", "/main.js")
    assert _is_static_asset("GET", "/vendor/preact.mjs")
    assert _is_static_asset("GET", "/style.css")
    assert _is_static_asset("GET", "/reticles/ruler.json")
    assert _is_static_asset("HEAD", "/index.html")
    # API paths and mutations are NOT static
    assert not _is_static_asset("GET", "/config/ui")
    assert not _is_static_asset("GET", "/stream")
    assert not _is_static_asset("POST", "/load-image")
    assert not _is_static_asset("POST", "/main.js")  # method matters


def test_static_burst_never_429s():
    client = TestClient(_make_app())
    statuses = {client.get("/module.js").status_code for _ in range(150)}
    assert statuses == {200}, "static module fetches must never be rate limited"


def test_api_burst_still_limited():
    client = TestClient(_make_app())
    statuses = [client.get("/api-endpoint").status_code for _ in range(150)]
    assert 429 in statuses, "non-static endpoints must still be rate limited"
    assert statuses[0] == 200
