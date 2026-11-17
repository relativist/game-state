import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {createPool, migrate} from '../src/db.js';

const dbUrl=process.env.TEST_DATABASE_URL;
if (!dbUrl) throw new Error('TEST_DATABASE_URL is required');
if (new URL(dbUrl).pathname.slice(1)!=='game_state_test') throw new Error('TEST_DATABASE_URL must target database game_state_test');
const pool=createPool(dbUrl);
const prefix=`sec_${crypto.randomUUID().replaceAll('-','').slice(0,16)}`;
let server,base,token;
const users=[];

async function request(path,{method='GET',body,headers={}}={}) {
  return fetch(`${base}${path}`,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:`Bearer ${token}`}:{ }),...headers},body:body===undefined?undefined:JSON.stringify(body)});
}
before(async()=>{
  await migrate(pool);
  server=createApp(pool,{origins:['https://allowed.example']});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  const response=await request('/auth/register',{method:'POST',body:{login:`${prefix}_user`,password:'secure-test-password'}});
  assert.equal(response.status,201); const value=await response.json(); token=value.token; users.push(value.user.id);
});
after(async()=>{
  if(server) await new Promise(resolve=>server.close(resolve));
  if(users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::text[])',[users]);
  await pool.end();
});

test('rejects invalid route keys, leaderboard limits, and unsafe state values',async()=>{
  for(const path of ['/apps/bad%20key/zones/z/state','/apps/a/zones/../state']) {
    const response=await request(path); assert.ok([400,404].includes(response.status));
  }
  for(const limit of ['0','-1','101','1.5','9999']) assert.equal((await request(`/apps/test/zones/z/leaderboard?limit=${encodeURIComponent(limit)}`)).status,400);
  for(const body of [
    {version:-1,data:{}},{version:0.5,data:{}},{version:0,data:[],score:1},
    {version:0,data:{},score:-1},{version:0,data:{},score:9007199254740992},
    {version:2147483647,data:{}},{version:0,data:null}
  ]) assert.equal((await request('/apps/validate/zones/z/state',{method:'PUT',body})).status,400);
});
test('allows configured CORS origin and rejects other origins',async()=>{
  const allowed=await request('/me',{headers:{origin:'https://allowed.example'}});
  assert.equal(allowed.status,200); assert.equal(allowed.headers.get('access-control-allow-origin'),'https://allowed.example');
  assert.equal((await request('/me',{headers:{origin:'https://attacker.example'}})).status,403);
});
test('rejects oversized JSON bodies',async()=>{
  const response=await fetch(`${base}/auth/register`,{method:'POST',headers:{'content-type':'application/json'},body:`{"login":"${prefix}_large","password":"${'x'.repeat(270000)}"}`});
  assert.equal(response.status,413);
  assert.equal((await response.json()).error.code,'BODY_TOO_LARGE');
});
