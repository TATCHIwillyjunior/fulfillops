#!/usr/bin/env python3
"""Measure local API latency and save raw samples as CSV."""
import argparse
import csv
import datetime
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--output", default="latency_samples.csv")
    args = parser.parse_args()

    parsed = urllib.parse.urlparse(args.base_url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        parser.error("base URL must target localhost or loopback")
    if not 200 <= args.count <= 5000:
        parser.error("count must be between 200 and 5000")
    if not 0 < args.timeout <= 30:
        parser.error("timeout must be greater than 0 and at most 30 seconds")

    url = args.base_url.rstrip("/") + "/api/v1/catalog"
    samples = []
    for _ in range(args.count):
        started = time.perf_counter()
        status = 0
        try:
            with urllib.request.urlopen(url, timeout=args.timeout) as response:
                status = response.status
                response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            error.read()
        except (OSError, TimeoutError) as error:
            print(f"request failed: {error}", file=sys.stderr)
        elapsed_ms = (time.perf_counter() - started) * 1000
        samples.append((datetime.datetime.now(datetime.timezone.utc).isoformat(), status, elapsed_ms))

    with open(args.output, "w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow(("timestamp_utc", "http_status", "duration_ms"))
        writer.writerows((timestamp, status, f"{duration:.3f}") for timestamp, status, duration in samples)

    durations = sorted(duration for _, status, duration in samples if 200 <= status < 300)
    failures = sum(not 200 <= status < 300 for _, status, _ in samples)
    if durations:
        p95 = durations[math.ceil(0.95 * len(durations)) - 1]
        mean = sum(durations) / len(durations)
        print(f"samples={len(samples)} successes={len(durations)} failures={failures}")
        print(f"p95_ms={p95:.3f} mean_ms={mean:.3f} csv={args.output}")
    else:
        print(f"samples={len(samples)} successes=0 failures={failures} csv={args.output}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
