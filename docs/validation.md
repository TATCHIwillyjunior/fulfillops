# Validation evidence

Evidence recorded on 2026-11-14. All destructive order/checker tests used
newly-created, isolated PostgreSQL databases; no production or shared
classroom service was targeted.

## Completed locally

| Check | Result | Evidence |
|---|---|---|
| Automated unit and integration suite | 9 tests passed, including same-key replay across two API processes, distinct-key stock competition, and worker crash/poison recovery | `npm test` |
| Public API checker | 15 passed, 0 failed, 0 skipped with `--concurrency --stress`; the stack had two worker processes | `python tests/fulfillops_public_checker.py --base-url http://127.0.0.1:18080 --concurrency --stress` |
| Fresh Compose stack | `docker compose up -d --build --wait` brought up PostgreSQL, the migration service, two APIs and two workers; checker passed 15/15 | Isolated project and database, removed with `docker compose down -v` afterward |
| Worker recovery | Killed worker's job completed on attempt 2 with exactly one receipt; stale completion/failure from attempt 1 did not alter completed state | `worker/test/recovery.integration.test.js` |
| Poison job handling | Failed order and retained dead-letter record after 3 attempts; no receipt | `worker/test/recovery.integration.test.js` |
| API latency | 200/200 successful local catalog requests; nearest-rank p95 25.906 ms; mean 9.509 ms | [`evidence/local-latency-2026-11-14.csv`](./evidence/local-latency-2026-11-14.csv) |
| kind deployment | PostgreSQL, 2 API replicas and 2 worker replicas became Ready; API readiness and worker readiness probes passed | `kubectl rollout status` and pod status |
| kind public checker | 15 passed, 0 failed, 0 skipped against the deployed services | Same checker command using the kind API port-forward |
| Healthy API rolling restart | 121/121 service-proxy readiness samples returned HTTP 200 over 30 seconds | [`evidence/rollout-probe-2026-11-14.csv`](./evidence/rollout-probe-2026-11-14.csv) |
| Dockerfile syntax | `docker build --check -f Dockerfile .` passed | Local Docker BuildKit |
| Database migrator | All 3 migrations applied and a second run was a no-op | `node db/migrate.js` and Compose migration service against isolated databases |

The latency sample is a sequential loopback measurement from one API process
and is not a production performance claim. See [slo.md](./slo.md) for its
limitations and reproduction command.

## Still requiring environment-backed evidence

- Argo CD reconciliation has not been run. The changes are still local and
  have not been pushed to the Git branch configured by the Argo CD Application.
- The dedicated kind cluster used for the successful deployment checks was
  deleted afterward to release local resources. Recreate it using the
  assignment's setup guide and manifests in `infra/k8s/` before repeating the
  deployment demonstrations.
- GitHub Actions has not been run from this local session. Its SBOM artifact,
  vulnerability scan, blocking gate, immutable image publication and red to
  green pipeline evidence must be verified from an Actions run.
- A controlled failed API rollout and restoration to a known-good Git state
  remain to be demonstrated through GitOps. The successful rolling restart
  above is not a substitute for that recovery drill.
