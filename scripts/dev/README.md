# scripts/dev/

Non-production developer utilities — visual validators, one-off repros,
ad-hoc measurement tools. Not imported by the backend, not exercised by
the test suite, not part of any runtime workflow.

These scripts typically depend on local files under `snapshots/` or
`data/` (both gitignored), so they will not run cleanly on a fresh
checkout without local sample data.

Keep production/operational scripts (release, deploy, maintenance) in
`scripts/` itself, not here.
