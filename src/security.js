import {randomBytes, scrypt as callback, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt = promisify(callback);
const options = {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024};
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, options);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  const [method,salt,key] = hash.split('$');
  if (method !== 'scrypt' || !/^[a-f0-9]{128}$/.test(key || '')) return false;
  const actual = await scrypt(password, salt, 64, options);
  return timingSafeEqual(actual, Buffer.from(key, 'hex'));
}
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
export function newToken() { return randomBytes(32).toString('base64url'); }

// Bounds memory and CPU used by unauthenticated requests. Each process has its own limits.
export function createLimiter(max = 30, windowMs = 15 * 60 * 1000) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    if (buckets.size >= 10000) {
      for (const [k,v] of buckets) if (v.until <= now) buckets.delete(k);
      if (buckets.size >= 10000 && !buckets.has(key)) return false;
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) { bucket = {count: 0, until: now + windowMs}; buckets.set(key,bucket); }
    return ++bucket.count <= max;
  };
}
