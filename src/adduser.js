#!/usr/bin/env node
/** Add a support user:  npm run user -- <username> "<Full Name>" <password> [--admin]
 *  On Coolify the same job is done from the in-app admin panel. */
import S, { now } from './db.js';
import { hashPassword } from './auth.js';

const args = process.argv.slice(2);
const isAdmin = args.includes('--admin');
const [username, name, password] = args.filter((a) => a !== '--admin');
if (!username || !name || !password) {
  console.error('Usage: npm run user -- <username> "<Full Name>" <password> [--admin]');
  process.exit(1);
}
if (password.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
try {
  S.addUser.run(username.toLowerCase().trim(), name, await hashPassword(password), now(), isAdmin ? 1 : 0);
  console.log(`✅ ${isAdmin ? 'Admin' : 'User'} "${username}" (${name}) created.`);
} catch (e) {
  console.error(String(e.message).includes('UNIQUE') ? `❌ User "${username}" already exists.` : `❌ ${e.message}`);
  process.exit(1);
}
