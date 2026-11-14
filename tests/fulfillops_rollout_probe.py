#!/usr/bin/env python3
"""Local-only HTTP readiness probe for a class rolling deployment demonstration.
No third-party Python dependencies. Records UTC samples, returns failure on any outage.
Use only on a team-controlled or university-approved lab environment.
"""
import argparse, csv, datetime, sys, time, urllib.request, urllib.error

p=argparse.ArgumentParser(description='Record time-stamped availability during a deployment')
p.add_argument('--base-url',default='http://localhost:8080')
p.add_argument('--path',default='/health/ready')
p.add_argument('--duration',type=float,default=30.0)
p.add_argument('--interval',type=float,default=0.25)
p.add_argument('--output',default='rollout_probe.csv')
a=p.parse_args()
if not (0<a.duration<=300 and 0.05<=a.interval<=10):p.error('duration must be 0-300s and interval 0.05-10s')
if not (a.base_url.startswith('http://127.0.0.1:') or a.base_url.startswith('http://localhost:')):
    p.error('only a localhost port-forward or isolated local endpoint is permitted')
url=a.base_url.rstrip('/')+a.path
start=time.monotonic();results=[]
while True:
    tick=time.monotonic()
    timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        with urllib.request.urlopen(url,timeout=max(1,min(5,a.interval+1))) as response:
            status=response.status
    except urllib.error.HTTPError as exc:status=exc.code
    except Exception:status=0
    results.append((timestamp,status,round(time.monotonic()-tick,3)))
    if time.monotonic()-start>=a.duration:break
    time.sleep(max(0,a.interval-(time.monotonic()-tick)))
with open(a.output,'w',newline='',encoding='utf-8') as f:
    w=csv.writer(f);w.writerow(['timestamp_utc','http_status','duration_seconds']);w.writerows(results)
errors=[r for r in results if not 200<=r[1]<300]
print(f'PROBE duration={a.duration}s total={len(results)} success={len(results)-len(errors)} failures={len(errors)} file={a.output}')
if errors:print(f'FIRST_FAILURE timestamp={errors[0][0]} status={errors[0][1]}')
sys.exit(1 if errors else 0)
