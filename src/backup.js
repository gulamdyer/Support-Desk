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
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { isOci, putObject, BACKUP_PREFIX } from './media-store.js';

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

const made = [dbOut];

if (existsSync(path.resolve('auth_state'))) {
  const tar = path.join(OUT, `auth_state-${stamp}.tar.gz`);
  const ok = await new Promise((resolve) => execFile('tar', ['-czf', tar, 'auth_state'], (err) => {
    console.log(err ? `⚠️  auth_state not archived: ${err.message}` : `✅ ${tar}`);
    resolve(!err);
  }));
  if (ok) made.push(tar);
}

// A backup sitting on the volume it is meant to protect is not a backup: lose
// the instance and it goes with the history it was copying. Push it off the box.
if (isOci()) {
  for (const f of made) {
    const name = BACKUP_PREFIX + path.basename(f);
    try {
      await putObject(name, readFileSync(f));
      console.log(`☁️  ${name}`);
    } catch (err) {
      // Loud, and a non-zero exit, so a scheduled run that silently stopped
      // protecting anything shows up as a failed task rather than a green one.
      console.error(`❌ upload failed for ${name}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

// Prune old backups so the volume doesn't fill up silently.
const cutoff = Date.now() - KEEP_DAYS * 86400e3;
for (const f of readdirSync(OUT)) {
  const p = path.join(OUT, f);
  if (statSync(p).mtimeMs < cutoff) { rmSync(p, { force: true }); console.log(`🗑  pruned ${f}`); }
}
