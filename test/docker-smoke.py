#!/usr/bin/env python3
"""Local Docker persistence smoke test. Deletes only its own temporary user."""
import json, secrets, subprocess, time, urllib.request, urllib.error
from uuid import UUID
base='http://127.0.0.1:3005'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(path, method='GET', body=None, token=None):
    headers={'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    req=urllib.request.Request(base+path, data=json.dumps(body).encode() if body is not None else None, headers=headers,method=method)
    with opener.open(req,timeout=5) as r: return json.load(r)
def wait():
    for _ in range(40):
        try:
            if api('/health')['status']=='ok': return
        except (OSError,urllib.error.HTTPError): pass
        time.sleep(1)
    raise RuntimeError('API failed to become healthy')
wait()
created=api('/auth/register','POST',{'login':'docker_smoke_'+secrets.token_hex(5),'password':secrets.token_hex(16)})
user_id=str(UUID(created['user']['id']))
try:
    api('/apps/smoke/zones/default/state','PUT',{'data':{'exercise':7},'score':42,'version':0},created['token'])
    subprocess.run(['docker','compose','-f','compose.yml','restart','postgres','game-state'],check=True,stdout=subprocess.DEVNULL)
    wait()
    saved=api('/apps/smoke/zones/default/state',token=created['token'])['state']
    assert saved['data']=={'exercise':7} and saved['score']==42 and saved['version']==1
    print('PASS: session and state survive PostgreSQL + API restart')
finally:
    subprocess.run(['docker','compose','-f','compose.yml','exec','-T','postgres','psql','-U','game_state','-d','game-state','-v','ON_ERROR_STOP=1','-c',"DELETE FROM users WHERE id='"+user_id+"';"],check=True,stdout=subprocess.DEVNULL)
