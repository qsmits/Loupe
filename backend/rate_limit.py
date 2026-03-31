"""Simple in-memory rate limiter for hosted mode.

Uses a sliding window counter per IP address. Middleware checks the rate
before the request reaches the endpoint. Returns 429 Too Many Requests
when the limit is exceeded.
"""
import time
import threading
from collections import defaultdict

from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


class RateLimiter:
    """Thread-safe sliding-window rate limiter keyed by IP address."""

    def __init__(self, requests_per_second: float = 30, burst: int = 60):
        """
        Parameters
        ----------
        requests_per_second : steady-state rate limit per IP
        burst : max requests allowed in a 1-second window (spike tolerance)
        """
        self._rps = requests_per_second
        self._burst = burst
        self._lock = threading.Lock()
        # IP → list of request timestamps (only recent ones kept)
        self._windows: dict[str, list[float]] = defaultdict(list)
        self._last_cleanup = time.monotonic()

    def check(self, ip: str) -> bool:
        """Return True if the request is allowed, False if rate-limited."""
        now = time.monotonic()
        window = 1.0  # 1-second sliding window

        with self._lock:
            # Periodic cleanup of stale IPs (every 60s)
            if now - self._last_cleanup > 60:
                self._cleanup(now)

            timestamps = self._windows[ip]
            # Remove timestamps outside the window
            cutoff = now - window
            while timestamps and timestamps[0] < cutoff:
                timestamps.pop(0)

            if len(timestamps) >= self._burst:
                return False

            timestamps.append(now)
            return True

    def _cleanup(self, now: float) -> None:
        """Remove IPs that haven't made requests in the last 60 seconds."""
        stale = [ip for ip, ts in self._windows.items()
                 if not ts or ts[-1] < now - 60]
        for ip in stale:
            del self._windows[ip]
        self._last_cleanup = now


# Heavy endpoints that get stricter limits
_HEAVY_PATHS = frozenset({
    "/detect-edges", "/detect-circles", "/detect-lines",
    "/detect-lines-merged", "/detect-arcs-partial",
    "/inspect-guided", "/align-dxf-edges",
    "/load-image", "/load-dxf",
    "/gradient-overlay", "/preprocessed-view",
})


class RateLimitMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that applies rate limiting in hosted mode.

    Two tiers:
    - Global: 60 req/s per IP (covers browser refresh spam)
    - Heavy: 5 req/s per IP for CPU-intensive endpoints
    """

    def __init__(self, app, hosted: bool = False):
        super().__init__(app)
        self._hosted = hosted
        self._global = RateLimiter(requests_per_second=30, burst=60)
        self._heavy = RateLimiter(requests_per_second=5, burst=10)

    async def dispatch(self, request: Request, call_next):
        if not self._hosted:
            return await call_next(request)

        ip = request.client.host if request.client else "unknown"

        # Global rate limit
        if not self._global.check(ip):
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please slow down."},
            )

        # Stricter limit for heavy endpoints
        path = request.url.path
        if path in _HEAVY_PATHS and not self._heavy.check(ip):
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests to this endpoint. Please wait."},
            )

        return await call_next(request)


class ConcurrencyLimitMiddleware(BaseHTTPMiddleware):
    """Limits the number of simultaneous heavy operations to prevent resource exhaustion."""

    def __init__(self, app, max_concurrent: int = 3, hosted: bool = False):
        super().__init__(app)
        self._hosted = hosted
        import asyncio
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._heavy_paths = _HEAVY_PATHS

    async def dispatch(self, request, call_next):
        if not self._hosted:
            return await call_next(request)
        path = request.url.path
        if path in self._heavy_paths:
            if self._semaphore.locked():
                # All slots busy — reject immediately
                return JSONResponse(
                    status_code=503,
                    content={"detail": "Server busy. Please try again in a moment."},
                )
            async with self._semaphore:
                return await call_next(request)
        return await call_next(request)
