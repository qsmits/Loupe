"""REST API endpoints for run storage and SPC."""

import csv
import io

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .run_store import RunStore


class CreatePartBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dxf_filename: str = ""
    template_name: str = ""


class SaveRunBody(BaseModel):
    results: list[dict] = Field(max_length=500)
    operator: str = Field(default="", max_length=100)
    notes: str = Field(default="", max_length=1000)


def make_runs_router(run_store: RunStore) -> APIRouter:
    router = APIRouter()

    def _check_hosted(request: Request):
        if getattr(request.app.state, "hosted", False):
            raise HTTPException(403, detail="Run storage disabled in hosted mode")

    @router.get("/parts")
    def list_parts(request: Request):
        _check_hosted(request)
        return run_store.get_parts()

    @router.post("/parts")
    def create_part(body: CreatePartBody, request: Request):
        _check_hosted(request)
        part_id = run_store.create_part(
            name=body.name,
            dxf_filename=body.dxf_filename or None,
            template_name=body.template_name or None,
        )
        return {"id": part_id, "name": body.name}

    @router.get("/parts/{part_id}/runs")
    def list_runs(
        part_id: int,
        request: Request,
        limit: int = Query(default=50, ge=1),
        offset: int = Query(default=0, ge=0),
    ):
        _check_hosted(request)
        limit = min(limit, 200)
        return run_store.get_runs(part_id, limit=limit, offset=offset)

    @router.post("/parts/{part_id}/runs")
    def save_run(part_id: int, body: SaveRunBody, request: Request):
        _check_hosted(request)
        run_id = run_store.save_run(
            part_id=part_id,
            results=body.results,
            operator=body.operator,
            notes=body.notes,
        )
        return {"run_id": run_id}

    @router.get("/runs/{run_id}")
    def get_run(run_id: int, request: Request):
        _check_hosted(request)
        results = run_store.get_run_results(run_id)
        return {"run_id": run_id, "results": results}

    @router.delete("/runs/{run_id}")
    def delete_run(run_id: int, request: Request):
        _check_hosted(request)
        run_store.delete_run(run_id)
        return {"ok": True}

    @router.get("/parts/{part_id}/spc/{handle}")
    def get_spc(part_id: int, handle: str, request: Request):
        _check_hosted(request)
        return run_store.compute_spc(part_id, handle)

    @router.get("/parts/{part_id}/history/{handle}")
    def get_history(
        part_id: int,
        handle: str,
        request: Request,
        limit: int = Query(default=100, ge=1),
    ):
        _check_hosted(request)
        limit = min(limit, 500)
        return run_store.get_feature_history(part_id, handle, limit=limit)

    @router.get("/parts/{part_id}/spc-export")
    def spc_export(part_id: int, request: Request):
        _check_hosted(request)
        # Get all runs oldest-first
        runs = run_store.get_runs(part_id, limit=200, offset=0)
        runs.sort(key=lambda r: r.get("run_number", 0))

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "run_number", "timestamp", "operator", "overall_status",
            "handle", "feature_type", "feature_name",
            "deviation_mm", "perp_dev_mm", "center_dev_mm",
            "tolerance_warn", "tolerance_fail", "pass_fail",
        ])

        for run in runs:
            results = run_store.get_run_results(run["id"])
            for res in results:
                writer.writerow([
                    run.get("run_number", ""),
                    run.get("timestamp", ""),
                    run.get("operator", ""),
                    run.get("overall_status", ""),
                    res.get("handle", ""),
                    res.get("feature_type", ""),
                    res.get("feature_name", ""),
                    res.get("deviation_mm", ""),
                    res.get("perp_dev_mm", ""),
                    res.get("center_dev_mm", ""),
                    res.get("tolerance_warn", ""),
                    res.get("tolerance_fail", ""),
                    res.get("pass_fail", ""),
                ])

        return Response(
            content=buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=spc_part_{part_id}.csv"},
        )

    return router
