import base64
import json
import cv2
import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from backend import api_fringe as api
from backend.cameras.null import NullCamera


def capture(cache, sid, key, size=4000):
    result = {'id': key, 'payload': key * size, 'warnings': []}
    cache.store_capture(sid, {'id': key}, result, latest=True)
    return result


def test_byte_limit_retires_oldest_and_keeps_summary_and_result_together():
    cache = api._FringeCache(per_session_bytes=12000)
    capture(cache, 's', 'a')
    capture(cache, 's', 'b')
    result = capture(cache, 's', 'c')
    assert [c['id'] for c in cache.list_captures('s')] == ['b', 'c']
    assert cache.get_full_result('s', 'a') is None
    assert cache.get_full_result('s', 'c')['payload'] == result['payload']
    assert cache.get('s', 'last_capture_id') == 'c'
    assert any('Older session captures' in w for w in result['warnings'])
    store, summaries, _ = cache._data['s']
    assert api._memory_size((store, summaries, cache._full_results['s'])) <= 12000


def test_oversized_result_does_not_remove_existing_history_or_latest_pointer():
    cache = api._FringeCache(per_session_bytes=12000)
    capture(cache, 's', 'a')
    with pytest.raises(HTTPException):
        capture(cache, 's', 'b', 20000)
    assert [c['id'] for c in cache.list_captures('s')] == ['a']
    assert cache.get_full_result('s', 'a') is not None
    assert cache.get_full_result('s', 'b') is None
    assert cache.get('s', 'last_capture_id') == 'a'


def test_new_frame_can_make_room_and_retention_notice_reaches_next_result():
    cache = api._FringeCache(per_session_bytes=14000)
    capture(cache, 's', 'a')
    capture(cache, 's', 'b')
    cache.put('s', 'last_image', np.zeros((80, 80), dtype=np.uint8))
    result = capture(cache, 's', 'c')
    assert cache.get('s', 'last_image').shape == (80, 80)
    assert any('Older session captures' in w for w in result['warnings'])


def test_global_budget_never_evicts_another_sessions_captures():
    cache = api._FringeCache(per_session_bytes=10000, max_bytes=12000)
    capture(cache, 'a', 'x', 7000)
    with pytest.raises(HTTPException):
        capture(cache, 'b', 'y', 7000)
    assert cache.get_full_result('a', 'x') is not None
    assert cache.list_captures('b') == []


def test_count_limit_is_applied_before_byte_budget(monkeypatch):
    monkeypatch.setattr(api, '_CAPTURES_PER_SESSION', 1)
    cache = api._FringeCache(per_session_bytes=7000)
    capture(cache, 's', 'a')
    capture(cache, 's', 'b')
    assert [c['id'] for c in cache.list_captures('s')] == ['b']


@pytest.mark.parametrize('endpoint', ['/fringe/analyze', '/fringe/analyze-stream'])
def test_completed_analysis_survives_history_pressure(monkeypatch, endpoint):
    cache = api._FringeCache(per_session_bytes=18000)
    monkeypatch.setattr(api, '_fringe_cache', cache)
    monkeypatch.setattr(api, 'analyze_interferogram', lambda *a, **kw: {
        'surface_map': 'x' * 6000, 'pv_nm': 2., 'rms_nm': 1.,
        '_mask_full': np.ones((16, 16), dtype=bool),
    })
    app = FastAPI()
    app.include_router(api.make_fringe_router(NullCamera()))
    _, png = cv2.imencode('.png', np.zeros((16, 16), dtype=np.uint8))
    body = {'image_b64': base64.b64encode(png).decode(), 'wavelength_nm': 589.3}
    with TestClient(app) as client:
        for _ in range(4):
            response = client.post(endpoint, json=body)
            assert response.status_code == 200
            if endpoint.endswith('stream'):
                events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
                assert events[-1]['stage'] == 'done', events
                result = events[-1]['result']
            else:
                result = response.json()
            assert client.get('/fringe/session/capture/' + result['id']).status_code == 200
        assert any('Older session captures' in w for w in result['warnings'])
        summaries = client.get('/fringe/session/captures').json()['captures']
        assert summaries[-1]['id'] == result['id']
        assert len(summaries) < 4
