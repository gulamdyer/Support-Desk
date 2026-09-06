/** The owner account stays out of the customer's team.
 *
 *  ADMIN_USERNAME is seeded from the deployment environment and belongs to
 *  whoever runs the server, not to the customer using it. It must not appear in
 *  the team list, must not consume a seat, and — the one that would actually
 *  break things — must not have its password overwritten by the "one shared
 *  password for everyone" action, because that password lives in Coolify.
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'team-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const { default: S } = await import('./db.js');

const add = (username, name, isAdmin) => {
  S.addUser.run(username, name, 'salt:hash', 1, isAdmin ? 1 : 0);
  return S.userByName.get(username);
};

const owner = add('admin', 'IT Support', true);     // seeded from the environment
S.setOwner.run(1, owner.id);
const clientAdmin = add('client.admin', 'Client Admin', true);
const agent = add('ali', 'Ali Hassan', false);

let n = 0;
const check = (label, fn) => { fn(); n += 1; console.log(`  ✓ ${label}`); };

check('the team list shows the customer only', () => {
  const names = S.userList.all().map((u) => u.username).sort();
  assert.deepEqual(names, ['ali', 'client.admin']);
});

check('the owner does not consume a seat', () => {
  assert.equal(S.activeCount.get().c, 2, 'three accounts exist, two are the team');
});

// The one that matters: reset-all-passwords iterates activeUsers. If the owner
// appeared here its environment password would be silently replaced and the
// break-glass account would be locked out of its own server.
check('a team-wide password reset never touches the owner', () => {
  const ids = S.activeUsers.all().map((u) => u.id);
  assert.ok(!ids.includes(owner.id), 'owner must be excluded from bulk resets');
  assert.deepEqual(ids.sort(), [clientAdmin.id, agent.id].sort());
});

// Hiding it in a list is not protection; the routes reject it by id, and they
// need this flag to do so.
check('a lookup by id still reveals the flag the routes guard on', () => {
  assert.equal(S.userById.get(owner.id).is_owner, 1);
  assert.equal(S.userById.get(agent.id).is_owner, 0);
});

check('reporting does not surface the owner', () => {
  const rows = S.agentStats.all(0, 2 ** 31);
  assert.ok(!rows.some((r) => r.id === owner.id));
});

// The customer must still be stopped from deactivating their last visible
// admin — that check counts the team, which no longer includes the owner.
check('the customer still has exactly one admin of their own', () => {
  const admins = S.userList.all().filter((u) => u.is_admin && u.active);
  assert.equal(admins.length, 1);
  assert.equal(admins[0].username, 'client.admin');
});

rmSync(dir, { recursive: true, force: true });
console.log(`✅ team: ${n}/${n} — the owner account is invisible and untouchable`);
