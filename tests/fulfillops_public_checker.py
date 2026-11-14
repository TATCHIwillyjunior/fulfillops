#!/usr/bin/env python3
"""FulfillOps independent API contract checker. Python standard library only.
WARNING: creates real test orders and consumes isolated test inventory. Never run against production.
"""
import argparse, concurrent.futures, json, os, sys, time, uuid, urllib.request, urllib.error

class Client:
    def __init__(self, base): self.base=base.rstrip('/')
    def request(self, method, path, body=None, key=None):
        headers={'Accept':'application/json'}
        if key: headers['Idempotency-Key']=key
        data=None
        if body is not None:
            headers['Content-Type']='application/json'
            data=body if isinstance(body,bytes) else json.dumps(body).encode()
        req=urllib.request.Request(self.base+path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req,timeout=12) as response:
                raw=response.read(); status=response.status; ctype=response.headers.get('Content-Type','')
        except urllib.error.HTTPError as error:
            raw=error.read(); status=error.code; ctype=error.headers.get('Content-Type','')
        try: parsed=json.loads(raw) if 'json' in ctype.lower() or raw.lstrip()[:1] in [b'{',b'['] else raw.decode(errors='replace')
        except ValueError: parsed=raw.decode(errors='replace')
        return status, parsed

class Assessment:
    def __init__(self, client): self.c=client; self.passed=0; self.failed=0; self.skipped=0; self.results=[]
    def run(self, title, func):
        try:
            result=func()
            if result == 'SKIP':
                self.skipped+=1; print('SKIP',title)
            else:
                self.passed+=1; print('PASS',title)
        except Exception as exc:
            self.failed+=1; print('FAIL',title,'-',str(exc))
    def check(self, expected, actual, label):
        if expected!=actual: raise AssertionError(f'{label}: expected {expected!r}, got {actual!r}')
    def ensure(self, test, label):
        if not test: raise AssertionError(label)
    def error(self, method, path, body, key, status, code):
        actual, payload=self.c.request(method,path,body,key)
        self.check(status,actual,'HTTP status')
        self.ensure(isinstance(payload,dict) and isinstance(payload.get('error'),dict),'error object must be JSON {"error":{...}}')
        self.check(code,payload['error'].get('code'),'error.code')

def main():
    p=argparse.ArgumentParser(description='Independent FulfillOps API checks (use only an isolated test environment)')
    p.add_argument('--base-url', default=os.getenv('FULFILLOPS_BASE_URL','http://localhost:8080'))
    p.add_argument('--concurrency', action='store_true', help='Run destructive race-condition check against isolated test stock')
    p.add_argument('--stress', action='store_true', help='Run two additional destructive same-key and multi-line checks; requires a FRESH isolated test dataset')
    args=p.parse_args()
    print('WARNING: test orders consume stock. Run on an isolated TEST deployment; never production.')
    c=Client(args.base_url); a=Assessment(c)
    def live():
        status,data=c.request('GET','/health/live'); a.check(200,status,'HTTP status'); a.check('ok',data.get('status'),'status')
    a.run('Liveness endpoint', live)
    def ready():
        status,data=c.request('GET','/health/ready'); a.check(200,status,'HTTP status'); a.check('ready',data.get('status'),'status')
    a.run('Readiness endpoint',ready)
    catalog_cache={}
    def catalog():
        status,data=c.request('GET','/api/v1/catalog'); a.check(200,status,'HTTP status')
        a.ensure(isinstance(data,dict) and isinstance(data.get('products'),list),'products must be a JSON array')
        known={x.get('sku'):x for x in data['products'] if isinstance(x,dict)}
        for sku,price in [('KIT-100',1299),('PART-200',599),('PACK-300',249)]:
            a.ensure(sku in known, f'{sku} missing'); a.check(price,known[sku].get('unit_price_cents'),sku+' price')
        catalog_cache.update(known)
    a.run('Catalog and fixed prices',catalog)
    a.run('Unknown order returns 404',lambda:a.error('GET','/api/v1/orders/not-real-order',None,None,404,'ORDER_NOT_FOUND'))
    a.run('Missing Idempotency-Key returns 400',lambda:a.error('POST','/api/v1/orders',{'customer_id':'CUST-042','items':[{'sku':'KIT-100','quantity':1}]},None,400,'IDEMPOTENCY_REQUIRED'))
    a.run('Invalid item quantity returns 422',lambda:a.error('POST','/api/v1/orders',{'customer_id':'CUST-042','items':[{'sku':'KIT-100','quantity':0}]},'badq-'+uuid.uuid4().hex,422,'INVALID_QUANTITY'))
    inv_before={}
    def inventory():
        status,data=c.request('GET','/api/v1/inventory/KIT-100'); a.check(200,status,'HTTP status')
        a.check('KIT-100',data.get('sku'),'sku'); a.ensure(type(data.get('available')) is int and data['available']>=0,'available must be nonnegative integer')
        inv_before['value']=data['available']
    a.run('Inventory reading',inventory)
    order_context={}
    def idempotent_order():
        if inv_before.get('value',0)<1: return 'SKIP'
        key='contract-'+uuid.uuid4().hex; payload={'customer_id':'CUST-042','items':[{'sku':'KIT-100','quantity':1}]}
        code,out=c.request('POST','/api/v1/orders',payload,key)
        a.check(202,code,'initial order'); a.ensure(isinstance(out,dict) and isinstance(out.get('order_id'),str) and out['order_id'],'order_id must be string')
        order_id=out['order_id']; a.check('queued',out.get('status'),'initial status')
        code2,again=c.request('POST','/api/v1/orders',payload,key)
        a.check(202,code2,'retry status'); a.check(order_id,again.get('order_id'),'same key must return same order')
        order_context.update({'id':order_id,'key':key,'payload':payload})
    a.run('Create order and idempotent retry',idempotent_order)
    def different_payload():
        if 'key' not in order_context: return 'SKIP'
        p=dict(order_context['payload']); p['customer_id']='CUST-999'
        a.error('POST','/api/v1/orders',p,order_context['key'],409,'IDEMPOTENCY_CONFLICT')
    a.run('Conflicting idempotency payload rejected',different_payload)
    def worker():
        if 'id' not in order_context: return 'SKIP'
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            code,out=c.request('GET','/api/v1/orders/'+order_context['id'])
            a.check(200,code,'order status')
            if out.get('status')=='completed':
                a.check(1299,out.get('total_cents'),'total cost'); return
            a.ensure(out.get('status') in {'queued','processing'},'unexpected order status: '+str(out.get('status')))
            time.sleep(.35)
        raise AssertionError('order was not completed within 15 seconds; check worker, queue and database')
    a.run('Asynchronous worker eventually completes',worker)
    def stock_exactly_once():
        if 'id' not in order_context: return 'SKIP'
        code,out=c.request('GET','/api/v1/inventory/KIT-100');a.check(200,code,'inventory status')
        a.check(inv_before['value']-1,out.get('available'),'one accepted order must reserve exactly one item')
    a.run('Inventory reduced exactly once',stock_exactly_once)
    def metrics():
        code,data=c.request('GET','/metrics');a.check(200,code,'metrics status')
        a.ensure(isinstance(data,str),'metrics should be text/plain')
        for name in ['fulfillops_orders_created_total','fulfillops_http_requests_total']:
            a.ensure(name in data,f'missing metric {name}')
    a.run('Prometheus metrics exposed',metrics)
    def concurrency_check():
        code,data=c.request('GET','/api/v1/inventory/PART-200');a.check(200,code,'inventory status')
        available=data.get('available',0)
        if type(available) is not int or available<1:return 'SKIP'
        n=min(available+5,25)
        def submit(i):
            return c.request('POST','/api/v1/orders',{'customer_id':'CUST-RACE','items':[{'sku':'PART-200','quantity':1}]}, 'race-'+uuid.uuid4().hex)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool: outcomes=list(pool.map(submit,range(n)))
        accepted=sum(s==202 for s,_ in outcomes)
        a.ensure(all(s in (202,409) for s,_ in outcomes),f'unexpected statuses: {[s for s,_ in outcomes]}')
        a.ensure(accepted<=available,'overselling: accepted more orders than available stock')
        code,after=c.request('GET','/api/v1/inventory/PART-200');a.check(200,code,'inventory status')
        a.check(available-accepted,after.get('available'),'post-race inventory')
        if n>available: a.check(available,accepted,'all available inventory should be allocated once')
    if args.concurrency: a.run('Concurrent inventory reservations are atomic',concurrency_check)
    else: print('NOTE: add --concurrency to exercise atomic reservation under contention.')
    def same_key_concurrent():
        status, item=c.request('GET','/api/v1/inventory/PACK-300')
        a.check(200,status,'inventory before same-key race')
        initial=item.get('available')
        if type(initial) is not int or initial<5:return 'SKIP'
        shared_key='shared-'+uuid.uuid4().hex
        body={'customer_id':'CUST-SHARED','items':[{'sku':'PACK-300','quantity':1}]}
        def submit(_):return c.request('POST','/api/v1/orders',body,shared_key)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            responses=list(pool.map(submit,range(8)))
        a.ensure(all(code==202 and isinstance(out,dict) and out.get('status')=='queued' for code,out in responses), 'all 8 replays must be accepted as queued receipts')
        ids={out.get('order_id') for code,out in responses}
        a.ensure(len(ids)==1 and None not in ids,'same idempotency key created multiple order IDs')
        after_status, after=c.request('GET','/api/v1/inventory/PACK-300')
        a.check(200,after_status,'inventory after same-key race')
        a.check(initial-1,after.get('available'),'same-key race must reserve exactly once')
    def duplicate_sku_lines():
        status, inv=c.request('GET','/api/v1/inventory/PACK-300')
        a.check(200,status,'inventory before multiline order')
        initial=inv.get('available')
        if type(initial) is not int or initial<4:return 'SKIP'
        key='multiline-'+uuid.uuid4().hex
        data={'customer_id':'CUST-MULTI','items':[{'sku':'PACK-300','quantity':2},{'sku':'PACK-300','quantity':2}]}
        code,out=c.request('POST','/api/v1/orders',data,key)
        a.check(202,code,'multiline acceptance')
        a.ensure(isinstance(out,dict) and out.get('order_id'),'order_id required')
        after_status,after=c.request('GET','/api/v1/inventory/PACK-300')
        a.check(200,after_status,'inventory after multiline order')
        a.check(initial-4,after.get('available'),'duplicate SKU lines must be aggregated before reservation')
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            s2,o2=c.request('GET','/api/v1/orders/'+out['order_id'])
            a.check(200,s2,'order status')
            if o2.get('status')=='completed':
                a.check(4*249,o2.get('total_cents'),'multiline order total');return
            a.ensure(o2.get('status') in ('queued','processing'),'unexpected status')
            time.sleep(.25)
        raise AssertionError('multi-line order did not complete within 15 s')
    if args.stress:
        a.run('Eight concurrent identical-key requests reserve once',same_key_concurrent)
        a.run('Duplicate SKU lines aggregate and bill correctly',duplicate_sku_lines)
    else:
        print('NOTE: add --stress on a freshly seeded test DB for cross-replica idempotency and repeated-SKU checks.')
    print(f'\nRESULT: {a.passed} passed / {a.failed} failed / {a.skipped} skipped')
    return 1 if a.failed else 0
if __name__=='__main__':sys.exit(main())
