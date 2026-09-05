/** Minimal session auth — node:crypto only, no dependency. */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import S, { now } from './db.js';

const scryptAsync = promisify(scrypt);
const SESSION_TTL = 12 * 3600; // a support shift

// Login is the only unauthenticated route, and each attempt costs ~100ms of
// scrypt. Without these two guards it is both a brute-force path and a way to
// starve the process for everyone else.
const LOCK = { maxFails: 5, forMs: 15 * 60 * 1000, maxInFlight: 8 };
const fails = new Map(); // "ip:1.2.3.4" | "user:ali" -> { n, until }
let inFlight = 0;

const lockedUntil = (key) => fails.get(key)?.until ?? 0;
function recordFail(key) {
  const f = fails.get(key) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= LOCK.maxFails) { f.until = Date.now() + LOCK.forMs; f.n = 0; }
  fails.set(key, f);
  // ponytail: pruned on write, not on a timer. Fine while the map is per-process
  // and small; move to a real store if the app is ever run multi-instance.
  if (fails.size > 500) for (const [k, v] of fails) if (v.until < Date.now() && !v.n) fails.delete(k);
}

export async function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scryptAsync(pw, salt, 64)).toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const a = Buffer.from(key, 'hex');
  const b = await scryptAsync(pw, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class LoginError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}

export async function login(username, password, ip = '?') {
  const name = String(username || '').toLowerCase().trim();
  const keys = [`ip:${ip}`, `user:${name}`];
  const until = Math.max(...keys.map(lockedUntil));
  if (until > Date.now()) {
    throw new LoginError(`Too many failed attempts. Try again in ${Math.ceil((until - Date.now()) / 60000)} minutes.`, 429);
  }
  if (inFlight >= LOCK.maxInFlight) throw new LoginError('Server busy, try again in a moment.', 503);

  inFlight += 1;
  try {
    const user = S.userByName.get(name);
    if (!user || !(await verifyPassword(String(password || ''), user.pw_hash))) {
      keys.forEach(recordFail);
      return null;
    }
    // Deactivated members fail exactly like a wrong password: no hint that the
    // account exists, no way back in without an admin reactivating them.
    if (!user.active) { keys.forEach(recordFail); return null; }
    keys.forEach((k) => fails.delete(k));
    const token = randomBytes(32).toString('hex');
    S.addSession.run(token, user.id, now());
    return { token, user: publicUser(user) };
  } finally {
    inFlight -= 1;
  }
}

export const publicUser = (u) =>
  ({ id: u.id, username: u.username, name: u.name, is_admin: !!u.is_admin });

export function logout(token) { if (token) S.dropSession.run(token); }

/** Express middleware — rejects anything without a live session. */
export function requireAuth(req, res, next) {
  const token = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
  const sess = token && S.session.get(token, now() - SESSION_TTL);
  if (!sess) return res.status(401).json({ error: 'Not signed in' });
  if (!sess.active) { S.dropUserSessions.run(sess.user_id); return res.status(401).json({ error: 'Account deactivated' }); }
  req.user = publicUser({ ...sess, id: sess.user_id });
  req.token = token;
  next();
}

/** Password resets and user management are admin-only. */
export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admins only.' });
  next();
}

/** First boot on a fresh volume has no users and no shell to run adduser in,
 *  so the admin comes from the environment. Existing users are never touched. */
export async function seedAdmin() {
  const username = String(process.env.ADMIN_USERNAME || '').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) return;
  const existing = S.userByName.get(username);
  if (existing) {
    if (!existing.is_admin) { S.setAdmin.run(1, existing.id); console.log(`👑 Promoted "${username}" to admin.`); }
    return;
  }
  if (password.length < 8) return console.error('⚠️  ADMIN_PASSWORD is under 8 characters — admin not created.');
  S.addUser.run(username, process.env.ADMIN_NAME || 'Administrator', await hashPassword(password), now(), 1);
  console.log(`👑 Admin "${username}" created from the environment.`);
}
