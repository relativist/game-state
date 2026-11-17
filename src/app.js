import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {hashPassword, verifyPassword, tokenHash, newToken, createLimiter} from './security.js';

class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this,{status,code}); }
}
function fail(status,code,message) { throw new HttpError(status,code,message); }
function validate(condition,message) { if (!condition) fail(400,'VALIDATION_ERROR',message); }
const publicUser = u => ({id:u.id,login:u.login,displayName:u.display_name});
const stateValue = s => ({appId:s.app_id,zoneId:s.zone_id,data:s.data,score:s.score === null ? null : Number(s.score),version:s.version,updatedAt:s.updated_at});
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
async function body(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415,'CONTENT_TYPE','Use application/json');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 262144) fail(413,'BODY_TOO_LARGE','Maximum request size is 256 KiB');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400,'INVALID_JSON','Invalid JSON body'); }
  validate(value !== null && typeof value === 'object' && !Array.isArray(value),'Body must be an object');
  return value;
}
const ranking = `SELECT s.user_id, u.display_name, s.score,
  row_number() OVER (ORDER BY s.score DESC, s.user_id ASC)::integer AS rank
  FROM player_states s JOIN users u ON u.id=s.user_id
  WHERE s.app_id=$1 AND s.zone_id=$2 AND s.score IS NOT NULL`;

export function createApp(pool, {origins = [], trustProxy = false, sessionDays = 30, authLimit = 30} = {}) {
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365) throw new Error('Invalid sessionDays');
  const allowAuth = createLimiter(authLimit);
  const allowRequest = createLimiter(600,60000);
  // An unknown login still executes scrypt, avoiding the obvious username timing difference.
  const dummyHash = hashPassword(randomUUID());
  async function issueSession(client, user) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + sessionDays * 86400000);
    await client.query('DELETE FROM sessions WHERE user_id=$1 AND expires_at <= now()',[user.id]);
    await client.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[tokenHash(token),user.id,expiresAt]);
    return {token,expiresAt,user:publicUser(user)};
  }
  return createServer({requestTimeout:15000,headersTimeout:10000},async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const send = (status,value) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const origin = req.headers.origin;
      const host = req.headers.host;
      const sameOrigin = origin && (origin === `http://${host}` || origin === `https://${host}`);
      if (origin && !sameOrigin && !origins.includes(origin)) fail(403,'ORIGIN_DENIED','Origin is not allowed');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin',origin);
        res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');
      }
      if (req.method === 'OPTIONS') {res.writeHead(204);res.end();return;}
      const ip = trustProxy ? (req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress;
      if (!allowRequest(String(ip))) fail(429,'RATE_LIMIT','Too many requests');
      const url = new URL(req.url,'http://localhost');
      const path = url.pathname;
      if (path === '/health' && req.method === 'GET') {await pool.query('SELECT 1');send(200,{status:'ok'});return;}
      if (['/auth/register','/auth/login'].includes(path) && req.method === 'POST') {
        if (!allowAuth(String(ip))) fail(429,'RATE_LIMIT','Too many authentication attempts; retry later');
        const input = await body(req);
        validate(typeof input.login === 'string' && typeof input.password === 'string','login and password are required');
        const login = input.login.trim().toLowerCase();
        validate(/^[a-z0-9_.-]{3,64}$/.test(login),'Login: 3–64 letters a-z, digits, _, . or -');
        validate(input.password.length >= 4 && input.password.length <= 128,'Password: 4–128 characters');
        if (path === '/auth/register') {
          const name = input.displayName === undefined ? login : input.displayName;
          validate(typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 80,'displayName: 1–80 characters');
          const hash = await hashPassword(input.password);
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const {rows:[user]} = await client.query('INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),login,name.trim(),hash]);
            const session = await issueSession(client,user);
            await client.query('COMMIT');send(201,session);
          } catch(e) {await client.query('ROLLBACK'); if(e.code === '23505') fail(409,'LOGIN_EXISTS','Login already exists');throw e;}
          finally {client.release();}
        } else {
          const {rows:[user]} = await pool.query('SELECT * FROM users WHERE login=$1',[login]);
          const valid = await verifyPassword(input.password,user?.password_hash ?? await dummyHash);
          if (!user || !valid) fail(401,'INVALID_CREDENTIALS','Invalid login or password');
          send(200,await issueSession(pool,user));
        }
        return;
      }
      const match = path.match(/^\/apps\/([^/]+)(?:\/(states)|\/zones\/([^/]+)\/(state|leaderboard|rank))$/);
      let appId,zoneId;
      if (match) {
        appId = match[1];zoneId = match[3];
        validate(keyPattern.test(appId) && (!zoneId || keyPattern.test(zoneId)),'app and zone: 1–64 letters, digits, _ or -');
        if (match[4] === 'leaderboard' && req.method === 'GET') {
          const value = url.searchParams.get('limit') ?? '10';
          validate(/^\d{1,3}$/.test(value) && Number(value)>=1 && Number(value)<=100,'limit must be 1–100');
          const {rows} = await pool.query(`${ranking} ORDER BY score DESC, s.user_id ASC LIMIT $3`,[appId,zoneId,Number(value)]);
          send(200,{players:rows.map(r=>({userId:r.user_id,displayName:r.display_name,score:Number(r.score),rank:r.rank})),limit:Number(value)});return;
        }
      }
      if (!match && !['/me','/auth/logout'].includes(path)) fail(404,'NOT_FOUND','Route not found');
      const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
      if (!bearer) fail(401,'UNAUTHORIZED','Bearer token required');
      const hash = tokenHash(bearer[1]);
      const {rows:[user]} = await pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[hash]);
      if (!user) fail(401,'UNAUTHORIZED','Session expired or revoked');
      if (path === '/me' && req.method === 'GET') {send(200,{user:publicUser(user)});return;}
      if (path === '/auth/logout' && req.method === 'POST') {await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hash]);send(200,{ok:true});return;}
      if (match?.[2] && req.method === 'GET') {
        const {rows} = await pool.query('SELECT * FROM player_states WHERE user_id=$1 AND app_id=$2 ORDER BY zone_id',[user.id,appId]);
        send(200,{states:rows.map(stateValue)});return;
      }
      if (match?.[4] === 'rank' && req.method === 'GET') {
        const {rows:[entry]} = await pool.query(`SELECT rank,score FROM (${ranking}) ranked WHERE user_id=$3`,[appId,zoneId,user.id]);
        send(200,{rank:entry?.rank ?? null,score:entry ? Number(entry.score) : null});return;
      }
      if (match?.[4] === 'state') {
        if (req.method === 'GET') {
          const {rows:[state]} = await pool.query('SELECT * FROM player_states WHERE user_id=$1 AND app_id=$2 AND zone_id=$3',[user.id,appId,zoneId]);
          if (!state) fail(404,'STATE_NOT_FOUND','No saved state');
          send(200,{state:stateValue(state)});return;
        }
        if (req.method === 'PUT') {
          const input = await body(req);
          validate(input.data !== null && typeof input.data === 'object' && !Array.isArray(input.data),'data must be a JSON object');
          validate(Number.isInteger(input.version) && input.version >= 0 && input.version < 2147483647,'version must be a nonnegative integer');
          validate(input.score === undefined || (Number.isSafeInteger(input.score) && input.score >= 0),'score must be a nonnegative safe integer');
          // Atomic compare-and-swap, including the first save. No read/update race.
          let result;
          if (input.version === 0) {
            result = await pool.query(`INSERT INTO player_states(user_id,app_id,zone_id,data,score)
              VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,[user.id,appId,zoneId,input.data,input.score ?? null]);
          } else {
            result = await pool.query(`UPDATE player_states SET data=$4, score=GREATEST(score,$5::bigint), version=version+1, updated_at=now()
              WHERE user_id=$1 AND app_id=$2 AND zone_id=$3 AND version=$6 RETURNING *`,[user.id,appId,zoneId,input.data,input.score ?? null,input.version]);
          }
          if (!result.rows.length) fail(409,'VERSION_CONFLICT','Reload the current state before saving');
          send(200,{state:stateValue(result.rows[0])});return;
        }
      }
      fail(405,'METHOD_NOT_ALLOWED','Method not allowed');
    } catch (e) {
      if (res.headersSent || res.destroyed) return;
      if (e instanceof HttpError) send(e.status,{error:{code:e.code,message:e.message}});
      else {console.error('Request failed', {code:e.code || 'INTERNAL_ERROR'});send(500,{error:{code:'INTERNAL_ERROR',message:'Internal server error'}});}
    }
  });
}
