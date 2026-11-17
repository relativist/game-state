import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {createPool, migrate} from '../src/db.js';

const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) throw new Error('TEST_DATABASE_URL is required');
const dbName = new URL(dbUrl).pathname.slice(1);
if (dbName !== 'game_state_test') throw new Error('TEST_DATABASE_URL must target database game_state_test');

const pool = createPool(dbUrl);
const prefix = `it_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
let server, base;
const users = [];
const tokens = {};

async function request(path, {method = 'GET', token, body, headers = {}} = {}) {
  return fetch(`${base}${path}`, {method, headers: {...(body === undefined ? {} : {'content-type':'application/json'}), ...(token ? {authorization:`Bearer ${token}`} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
}
async function register(label, displayName = label) {
  const login = `${prefix}_${label}`;
  const response = await request('/auth/register', {method:'POST', body:{login, password:'test-password-123', displayName}});
  assert.equal(response.status, 201);
  const value = await response.json(); users.push(value.user.id);
  return value;
}
async function save(token, appId, zoneId, version, data, score) {
  return request(`/apps/${appId}/zones/${zoneId}/state`, {method:'PUT', token, body:{version, data, ...(score === undefined ? {} : {score})}});
}

before(async () => {
  await migrate(pool);
  server = createApp(pool, {origins:['https://game.example']});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await pool.end();
});

test('registration, login, identity, logout and expired session', async () => {
  const created = await register('auth', 'Auth Player');
  assert.deepEqual(Object.keys(created.user).sort(), ['displayName','id','login']);
  assert.ok(!JSON.stringify(created).toLowerCase().includes('password_hash'));
  assert.ok(!JSON.stringify(created).includes('test-password-123'));
  assert.equal((await request('/me', {token:created.token})).status, 200);
  const wrong = await request('/auth/login', {method:'POST', body:{login:created.user.login,password:'wrong-password'}});
  assert.equal(wrong.status, 401);
  const login = await request('/auth/login', {method:'POST', body:{login:created.user.login,password:'test-password-123'}});
  assert.equal(login.status, 200);
  const loggedIn = await login.json(); tokens.auth = loggedIn.token;
  assert.equal((await request('/me', {token:loggedIn.token})).status, 200);
  const deviceLogin = await request('/auth/login', {method:'POST', body:{login:created.user.login,password:'test-password-123'}});
  assert.equal(deviceLogin.status,200);
  assert.equal((await request('/apps/authapp/zones/z/state',{method:'PUT',token:created.token,body:{version:0,data:{device:1}}})).status,200);
  assert.equal((await request('/apps/authapp/zones/z/state',{method:'PUT',token:(await deviceLogin.json()).token,body:{version:0,data:{device:2}}})).status,409);
  assert.equal((await request('/auth/logout', {method:'POST', token:loggedIn.token})).status, 200);
  assert.equal((await request('/me', {token:loggedIn.token})).status, 401);
  await pool.query('UPDATE sessions SET expires_at=now()-interval \'1 second\' WHERE user_id=$1', [created.user.id]);
  assert.equal((await request('/me', {token:created.token})).status, 401);
});

test('states are scoped to user, app and zone; missing state and auth are denied', async () => {
  const a = await register('scopea'), b = await register('scopeb');
  const first = await save(a.token,'scopeapp','north',0,{progress:1},5);
  assert.equal(first.status,200);
  assert.equal((await request('/apps/scopeapp/zones/north/state')).status,401);
  assert.equal((await request('/apps/scopeapp/zones/north/state',{token:b.token})).status,404);
  assert.equal((await request('/apps/scopeapp/zones/south/state',{token:a.token})).status,404);
  assert.equal((await request('/apps/otherapp/zones/north/state',{token:a.token})).status,404);
  const list = await (await request('/apps/scopeapp/states',{token:a.token})).json();
  assert.equal(list.states.length,1); assert.equal(list.states[0].zoneId,'north');
  assert.equal((await request('/apps/scopeapp/zones/north/state',{token:a.token})).status,200);
});

test('initial create and optimistic update races have exactly one winner', async () => {
  const u = await register('race');
  const create = await Promise.all([save(u.token,'raceapp','z',0,{n:1},1),save(u.token,'raceapp','z',0,{n:2},2)]);
  assert.deepEqual(create.map(r=>r.status).sort(),[200,409]);
  const winningCreate = await Promise.all(create.map(async r => r.status === 200 ? (await r.json()).state.score : null));
  const current = await (await request('/apps/raceapp/zones/z/state',{token:u.token})).json();
  const updates = await Promise.all([save(u.token,'raceapp','z',current.state.version,{n:3},0),save(u.token,'raceapp','z',current.state.version,{n:4},3)]);
  assert.deepEqual(updates.map(r=>r.status).sort(),[200,409]);
  const winningUpdate = await Promise.all(updates.map(async r => r.status === 200 ? (await r.json()).state.score : null));
  const saved = await (await request('/apps/raceapp/zones/z/state',{token:u.token})).json();
  assert.equal(saved.state.score, Math.max(...winningCreate.filter(v=>v!==null), ...winningUpdate.filter(v=>v!==null)));
  assert.ok([3,4].includes(saved.state.data.n));
});

test('public leaderboard orders ties deterministically; own rank, zero and null scores', async () => {
  const a=await register('ranka','Same'), b=await register('rankb','Same'), c=await register('rankc');
  await save(a.token,'rankapp','board',0,{p:1},10); await save(b.token,'rankapp','board',0,{p:2},10);
  await save(c.token,'rankapp','board',0,{p:3},0);
  const board = await (await request('/apps/rankapp/zones/board/leaderboard')).json();
  assert.deepEqual(board.players.map(p=>p.userId),[a.user.id,b.user.id].sort().concat(c.user.id));
  assert.deepEqual(board.players.map(p=>p.rank),[1,2,3]);
  assert.equal((await (await request(`/apps/rankapp/zones/board/rank`,{token:b.token})).json()).rank,[a.user.id,b.user.id].sort().indexOf(b.user.id)+1);
  assert.equal((await (await request('/apps/rankapp/zones/board/rank',{token:a.token})).json()).score,10);
  const d=await register('ranknull'); await save(d.token,'rankapp','board',0,{p:4});
  const nullRank=await (await request('/apps/rankapp/zones/board/rank',{token:d.token})).json();
  assert.deepEqual(nullRank,{rank:null,score:null});
  assert.ok(!(await (await request('/apps/rankapp/zones/board/leaderboard')).json()).players.some(p=>p.userId===d.user.id));
});

test('best score survives lower or omitted scores while progress updates',async()=>{
  const u=await register('best');
  const first=await save(u.token,'bestapp','z',0,{level:1},100);
  assert.equal(first.status,200);
  const savedFirst=await first.json();
  const lower=await save(u.token,'bestapp','z',savedFirst.state.version,{level:2},1);
  assert.equal(lower.status,200); const savedLower=await lower.json();
  assert.deepEqual(savedLower.state.data,{level:2}); assert.equal(savedLower.state.score,100);
  const omitted=await save(u.token,'bestapp','z',savedLower.state.version,{level:3});
  assert.equal(omitted.status,200); const savedOmitted=await omitted.json();
  assert.deepEqual(savedOmitted.state.data,{level:3}); assert.equal(savedOmitted.state.score,100);
});

test('authLimit rejects the second authentication attempt',async()=>{
  const u=await register('limited');
  const limited=createApp(pool,{authLimit:1});
  await new Promise(resolve=>limited.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${limited.address().port}/auth/login`;
    const send=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:u.user.login,password:'bad-password'})});
    assert.equal((await send()).status,401);
    assert.equal((await send()).status,429);
  } finally { await new Promise(resolve=>limited.close(resolve)); }
});

test('service exposes JSON API only, without HTML or static routes', async () => {
  for (const path of ['/', '/example.html', '/client.js']) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
});
