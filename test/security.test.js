import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLimiter,hashPassword,newToken,tokenHash,verifyPassword} from '../src/security.js';

test('password hashes verify only the original password',async()=>{
  const encoded=await hashPassword('correct horse battery staple');
  assert.match(encoded,/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword('correct horse battery staple',encoded),true);
  assert.equal(await verifyPassword('incorrect password',encoded),false);
  assert.equal(await verifyPassword('anything','unsupported$format'),false);
});

test('session token is opaque, URL-safe, and stored as a one-way hash',()=>{
  const token=newToken();
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.match(tokenHash(token),/^[a-f0-9]{64}$/);
  assert.notEqual(tokenHash(token),token);
  assert.notEqual(tokenHash(token),tokenHash(newToken()));
});

test('limiter counts per key and resets after its window',async()=>{
  const limiter=createLimiter(2,10);
  assert.equal(limiter('a'),true); assert.equal(limiter('a'),true); assert.equal(limiter('a'),false);
  assert.equal(limiter('b'),true);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(limiter('a'),true);
});
