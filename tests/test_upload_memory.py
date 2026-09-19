from io import BytesIO
import numpy as np
import pytest
from PIL import Image
from fastapi import HTTPException
from backend.image_upload import validate_image_upload
from backend.session_store import SessionFrameStore
from backend.api_fringe import _FringeCache


def test_compressed_image_dimensions_checked_without_decoding(monkeypatch):
    buf = BytesIO()
    Image.new('L', (8193, 1)).save(buf, format='PNG')
    monkeypatch.setattr(Image.Image, 'load', lambda *a: pytest.fail('decoded pixels'))
    with pytest.raises(HTTPException) as exc:
        validate_image_upload(buf.getvalue(), True)
    assert exc.value.status_code == 413


def test_small_image_accepted_and_local_panorama_unrestricted():
    buf = BytesIO()
    Image.new('RGB', (16, 16)).save(buf, format='PNG')
    validate_image_upload(buf.getvalue(), True)
    validate_image_upload(b'local decoding occurs elsewhere', False)


def test_frame_budget_counts_bytes_and_preserves_existing_frame():
    store = SessionFrameStore(max_bytes=100)
    store.store('a', np.zeros((10, 10), dtype=np.uint8))
    with pytest.raises(HTTPException):
        store.store('b', np.ones((1, 1), dtype=np.uint8))
    store.store('a', np.ones((5, 5), dtype=np.uint8))
    store.store('b', np.zeros((5, 5), dtype=np.uint8))
    assert store.get('a').sum() == 25


def test_fringe_budget_includes_arrays_and_python_grids():
    cache = _FringeCache(max_bytes=12000, per_session_bytes=10000)
    cache.put('a', 'last_image', np.zeros((80, 80), dtype=np.uint8))
    with pytest.raises(HTTPException):
        cache.put('b', 'last_image', np.zeros((80, 80), dtype=np.uint8))
    cache.append_capture('a', {'id': 'large'})
    with pytest.raises(HTTPException):
        cache.put_full_result('a', 'large', {'grid': [float(i) for i in range(1000)]})
    assert cache.list_captures('a') == []
    assert cache.get('a', 'last_image').shape == (80, 80)
