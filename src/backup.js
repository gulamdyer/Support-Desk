#!/usr/bin/env node
/** Nightly backup:  node src/backup.js  (Coolify → Scheduled Tasks)
 *
 *  data/inbox.db is the only copy of the conversation history and auth_state/
 *  is the difference between a 10-minute recovery and an emergency relink.
 *  VACUUM INTO is the safe way to copy a live WAL database — a plain file copy
 *  of inbox.db while the server is running can land mid-transaction.
 */
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.env.BACKUP_DIR || 'data/backups');
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 14);
const stamp = new Date().toISOString().slice(0, 10);

mkdirSync(OUT, { recursive: true });

const dbOut = path.join(OUT, `inbox-${stamp}.db`);
rmSync(dbOut, { force: true }); // VACUUM INTO refuses to overwrite
const db = new DatabaseSync(path.resolve('data', 'inbox.db'), { readOnly: true });
db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
db.close();
console.log(`✅ ${dbOut} (${(statSync(dbOut).size / 1024).toFixed(0)} KB)`);

if (existsSync(path.resolve('auth_state'))) {
  const tar = path.join(OUT, `auth_state-${stamp}.tar.gz`);
  await new Promise((resolve) => execFile('tar', ['-czf', tar, 'auth_state'], (err) => {
    console.log(err ? `⚠️  auth_state not archived: ${err.message}` : `✅ ${tar}`);
    resolve();
  }));
}

// Prune old backups so the volume doesn't fill up silently.
const cutoff = Date.now() - KEEP_DAYS * 86400e3;
for (const f of readdirSync(OUT)) {
  const p = path.join(OUT, f);
  if (statSync(p).mtimeMs < cutoff) { rmSync(p, { force: true }); console.log(`🗑  pruned ${f}`); }
}
