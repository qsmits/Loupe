import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.api_fringe import make_fringe_router
from backend.cameras.null import NullCamera


@pytest.mark.parametrize('fields', [
    {'surface_height': 1000000, 'surface_width': 1000000},
    {'surface_height': 2048, 'surface_width': 2048},
    {'raw_height_grid_nm': [1.]},
    {'raw_height_grid_nm': [1.], 'raw_grid_rows': 2, 'raw_grid_cols': 2},
    {'mask': [1]},
    {'coefficients': [0.] * 67},
])
def test_reanalyze_rejects_unsafe_shapes_before_computing(monkeypatch, fields):
    def forbidden(**kw):
        pytest.fail('unsafe request reached computation')
    monkeypatch.setattr('backend.api_fringe.reanalyze', forbidden)
    app = FastAPI()
    app.include_router(make_fringe_router(NullCamera()))
    body = dict(coefficients=[], surface_height=32, surface_width=32)
    body.update(fields)
    assert TestClient(app).post('/fringe/reanalyze', json=body).status_code == 422


def test_large_source_metadata_allowed_for_small_raw_grid(monkeypatch):
    monkeypatch.setattr('backend.api_fringe.reanalyze', lambda **kw: {})
    app = FastAPI()
    app.include_router(make_fringe_router(NullCamera()))
    r = TestClient(app).post('/fringe/reanalyze', json={
        'coefficients': [], 'surface_height': 4096, 'surface_width': 4096,
        'raw_height_grid_nm': [0.] * 16, 'raw_grid_rows': 4, 'raw_grid_cols': 4,
        'mask': [1] * 16,
    })
    assert r.status_code == 200
