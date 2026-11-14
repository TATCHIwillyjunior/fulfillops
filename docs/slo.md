# FulfillOps SLOs and alerts

## Service level objectives
| SLO | Target | Metric |
|-----|--------|--------|
| API availability | 99.5% of requests are not 5xx (30 days) | `fulfillops_http_requests_total` |
| API latency | p95 < 300 ms | `fulfillops_http_request_duration_seconds` |
| Order fulfilment | 99% of jobs completed, not dead-lettered | `fulfillops_worker_jobs_processed_total` |
| Queue freshness | fewer than 50 pending jobs for more than 5 min | `fulfillops_worker_queue_depth` |

## PromQL
```promql
# Availability (ratio of good requests)
sum(rate(fulfillops_http_requests_total{status!~"5.."}[5m]))
  / sum(rate(fulfillops_http_requests_total[5m]))

# p95 latency
histogram_quantile(0.95, sum by (le) (rate(fulfillops_http_request_duration_seconds_bucket[5m])))

# Dead-letter ratio
sum(rate(fulfillops_worker_jobs_processed_total{result="dead_letter"}[15m]))
  / sum(rate(fulfillops_worker_jobs_processed_total[15m]))

# Retries per minute
rate(fulfillops_worker_retries_total[5m]) * 60
```

## Alerts
| Alert | Condition | Action |
|-------|-----------|--------|
| HighErrorRate | availability < 99.5% for 10 min | check API logs and DB health |
| SlowAPI | p95 > 300 ms for 10 min | check DB locks and pool usage |
| DeadLetters | any new `dead_letter` job | inspect `last_error`, fix, requeue |
| QueueBacklog | pending > 50 for 5 min | scale workers, check worker logs |
