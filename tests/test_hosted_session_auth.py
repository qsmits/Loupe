import uuid

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api_camera import make_camera_router
from backend.cameras.null import NullCamera
from backend.session_store import SessionFrameStore, SESSION_COOKIE


def clients():
    app = FastAPI()
    app.state.hosted = True
    app.include_router(make_camera_router(NullCamera(), SessionFrameStore()))
    return TestClient(app), TestClient(app)


def test_exported_project_uuid_does_not_grant_frame_access():
    a, b = clients()
    headers = {'X-Session-ID': str(uuid.uuid4())}
    assert a.post('/session/new').status_code == 200
    _, png = cv2.imencode('.png', np.full((8, 8, 3), 100, np.uint8))
    assert a.post('/load-image', headers=headers, files={'file': ('a.png', png.tobytes())}).status_code == 200
    assert b.get('/frame', headers=headers).status_code == 401
    b.post('/session/new')
    assert b.get('/frame', headers=headers).status_code == 404
    assert b.delete('/session', headers=headers).status_code == 200
    assert a.get('/frame', headers=headers).status_code == 200
    # Bootstrap must not rotate an existing valid owner or lose the frame.
    a.post('/session/new')
    assert a.get('/frame', headers=headers).status_code == 200


def test_cookie_is_private_and_tampering_is_rejected():
    a, _ = clients()
    r = a.post('/session/new')
    assert 'HttpOnly' in r.headers['set-cookie']
    assert 'SameSite=strict' in r.headers['set-cookie']
    assert r.headers['cache-control'] == 'no-store'
    token = a.cookies.get(SESSION_COOKIE)
    a.cookies.clear()
    a.cookies.set(SESSION_COOKIE, token + 'x')
    r = a.get('/frame', headers={'X-Session-ID': str(uuid.uuid4())})
    assert r.status_code == 401
    assert r.headers['X-Loupe-Session-Required'] == '1'
