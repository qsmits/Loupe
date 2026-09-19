import asyncio
import threading

import pytest
from fastapi import HTTPException
from backend.compute_pool import ComputePool
from backend.rate_limit import _HEAVY_PATHS


def test_cancelled_waiter_does_not_release_a_running_worker():
    pool = ComputePool(capacity=1)
    started = threading.Event()
    finish = threading.Event()
    def job():
        started.set()
        finish.wait(5)
        return 42
    async def scenario():
        task = asyncio.create_task(pool.run(job))
        while not started.is_set():
            await asyncio.sleep(.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(HTTPException) as exc:
            pool.submit(lambda: None)
        assert exc.value.status_code == 503
        finish.set()
    try:
        asyncio.run(scenario())
    finally:
        finish.set()
        pool.shutdown()


def test_capacity_is_released_after_failure():
    pool = ComputePool(capacity=1)
    async def scenario():
        with pytest.raises(ZeroDivisionError):
            await pool.run(lambda: 1 / 0)
        assert await pool.run(lambda: 42) == 42
    try:
        asyncio.run(scenario())
    finally:
        pool.shutdown()


def test_all_fringe_compute_routes_receive_heavy_rate_limits():
    assert {'/fringe/analyze', '/fringe/analyze-stream', '/fringe/reanalyze',
            '/fringe/reanalyze-carrier', '/fringe/subtract', '/fringe/average',
            '/fringe/session/import', '/update-frame'} <= _HEAVY_PATHS


def test_streaming_route_rejects_fourth_job_before_stream_headers(monkeypatch):
    import base64
    import cv2
    import numpy as np
    import httpx
    from fastapi import FastAPI
    import backend.api_fringe as api
    from backend.cameras.null import NullCamera
    pool = ComputePool(3)
    finish = threading.Event()
    lock = threading.Lock()
    active = 0
    def analyze(*args, **kw):
        nonlocal active
        with lock:
            active += 1
        finish.wait(5)
        return {}
    monkeypatch.setattr(api, 'fringe_compute', pool)
    monkeypatch.setattr(api, 'analyze_interferogram', analyze)
    app = FastAPI()
    app.include_router(api.make_fringe_router(NullCamera()))
    _, png = cv2.imencode('.png', np.zeros((8, 8), np.uint8))
    body = {'image_b64': base64.b64encode(png).decode()}
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
            tasks = [asyncio.create_task(c.post('/fringe/analyze-stream', json=body)) for _ in range(3)]
            try:
                for _ in range(200):
                    if active == 3:
                        break
                    await asyncio.sleep(.005)
                assert active == 3
                r = await c.post('/fringe/analyze-stream', json=body)
                assert r.status_code == 503
            finally:
                finish.set()
                results = await asyncio.gather(*tasks)
            assert all(r.status_code == 200 and '"stage": "done"' in r.text for r in results)
    try:
        asyncio.run(scenario())
    finally:
        finish.set()
        pool.shutdown()
