// docs/API.md §9.10–9.18 Team members, link-only team invites, roles.
// Rules: Owner role has every staff permission and can't be edited; you can't
// change your own role; the Owner role always keeps at least one member; only
// an Owner can put someone into the Owner role.
const express = require('express');
const config = require('../../config');
const db = require('../../db');
const { parse, z } = require('../../lib/validate');
const { audit } = require('../../lib/audit');
const { randomToken, hmac } = require('../../lib/crypto');
const { requireStaff } = require('../../middleware/auth');
const realtime = require('../../services/realtime');
const { E } = require('../../errors');

const router = express.Router();
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const INVITE_DAYS = 7;
const need = requireStaff('team.manage');

async function role(id, q = db) {
  const r = await q.query('SELECT id, name, is_owner FROM staff_roles WHERE id = $1', [id]);
  if (!r.rows[0]) throw E.notFound('Role not found');
  return r.rows[0];
}
const callerIsOwner = async (req) => (await db.one(
  'SELECT r.is_owner FROM staff_roles r WHERE r.id = $1', [req.user.staff_role_id]))?.is_owner === true;

async function ownerCount(q = db) {
  return (await q.query(`SELECT count(*)::int AS n FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
                          WHERE r.is_owner AND u.deleted_at IS NULL`)).rows[0].n;
}

// 9.10
router.get('/team', need, async (req, res) => {
  const members = await db.many(
    `SELECT u.id, u.full_name, u.phone, u.last_active_at, r.id AS role_id, r.name AS role_name
       FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
      WHERE u.deleted_at IS NULL ORDER BY r.is_owner DESC, u.full_name`);
  const invites = await db.many(
    `SELECT i.id, i.label, i.expires_at, r.id AS role_id, r.name AS role_name
       FROM staff_invites i JOIN staff_roles r ON r.id = i.role_id
      WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() ORDER BY i.created_at`);
  res.json({
    members: members.map((m) => ({ userId: m.id, fullName: m.full_name, phone: m.phone,
      role: { id: m.role_id, name: m.role_name }, lastActiveAt: m.last_active_at })),
    invites: invites.map((i) => ({ id: i.id, label: i.label, role: { id: i.role_id, name: i.role_name }, expiresAt: i.expires_at })),
  });
});

// 9.11 Link-only team invite (shown once)
router.post('/team/invites', need, async (req, res) => {
  const body = parse(z.object({ label: z.string().trim().min(1).max(60), roleId: z.number().int().positive() }), req.body);
  const r = await role(body.roleId);
  if (r.is_owner && !(await callerIsOwner(req))) throw E.forbidden('FORBIDDEN', 'Only an Owner can invite another Owner');
  const token = randomToken();
  const inv = await db.tx(async (c) => {
    const { rows: [i] } = await c.query(
      `INSERT INTO staff_invites (label, role_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
      [body.label, r.id, hmac('invite', token), req.user.id, INVITE_DAYS]);
    await audit(req, { action: 'team.invite', targetType: 'role', targetId: r.id, targetLabel: r.name, detail: `"${body.label}"` }, c);
    return i;
  });
  res.status(201).json({
    invite: { id: inv.id, label: body.label, role: { id: r.id, name: r.name }, expiresAt: inv.expires_at },
    inviteUrl: `${config.publicBaseUrl}/invite/${token}`,
    expiresAt: inv.expires_at,
  });
});

// 9.12
router.delete('/team/invites/:id', need, async (req, res) => {
  if (!isUuid(req.params.id)) throw E.notFound('Invite not found');
  const r = await db.query(
    'UPDATE staff_invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING label', [req.params.id]);
  if (!r.rowCount) throw E.notFound('Invite not found');
  await audit(req, { action: 'team.invite_cancel', targetType: 'invite', targetId: req.params.id, detail: r.rows[0].label });
  res.status(204).end();
});

async function member(req, c) {
  if (!isUuid(req.params.userId)) throw E.notFound('Team member not found');
  const { rows: [m] } = await c.query(
    `SELECT u.id, u.full_name, r.is_owner, r.name AS role_name FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
      WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE OF u`, [req.params.userId]);
  if (!m) throw E.notFound('Team member not found');
  if (m.id === req.user.id) throw E.invalid('OWN_ROLE', 'You cannot change your own role');
  return m;
}

// 9.13 Change a member's role
router.patch('/team/:userId', need, async (req, res) => {
  const body = parse(z.object({ roleId: z.number().int().positive() }), req.body);
  const out = await db.tx(async (c) => {
    // One change of the Owner list at a time, so the last Owner check holds.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('argus.owners'))");
    const m = await member(req, c);
    const r = await role(body.roleId, c);
    if ((r.is_owner || m.is_owner) && !(await callerIsOwner(req))) throw E.forbidden('FORBIDDEN', 'Only an Owner can change Owners');
    if (m.is_owner && !r.is_owner && (await ownerCount(c)) <= 1) throw E.invalid('LAST_OWNER', 'The team must keep at least one Owner');
    await c.query('UPDATE users SET staff_role_id = $2 WHERE id = $1', [m.id, r.id]);
    await audit(req, { action: 'team.role.assign', targetType: 'user', targetId: m.id, targetLabel: m.full_name,
      detail: `${m.role_name} → ${r.name}` }, c);
    return { userId: m.id, fullName: m.full_name, role: { id: r.id, name: r.name } };
  });
  realtime.disconnectUser(out.userId);
  res.json(out);
});

// 9.14 Remove from the team (the account stays as a customer)
router.delete('/team/:userId', need, async (req, res) => {
  const id = await db.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('argus.owners'))");
    const m = await member(req, c);
    if (m.is_owner && !(await callerIsOwner(req))) throw E.forbidden('FORBIDDEN', 'Only an Owner can remove an Owner');
    if (m.is_owner && (await ownerCount(c)) <= 1) throw E.invalid('LAST_OWNER', 'The team must keep at least one Owner');
    await c.query('UPDATE users SET staff_role_id = NULL, token_version = token_version + 1 WHERE id = $1', [m.id]);
    await audit(req, { action: 'team.remove', targetType: 'user', targetId: m.id, targetLabel: m.full_name, detail: m.role_name }, c);
    return m.id;
  });
  realtime.disconnectUser(id);
  res.status(204).end();
});

const STAFF_PERMS_SQL = "SELECT code, label FROM permissions WHERE scope = 'staff' ORDER BY sort_order";

// 9.15 Roles with permissions and member counts
router.get('/roles', need, async (req, res) => {
  const perms = await db.many(STAFF_PERMS_SQL);
  const roles = await db.many(
    `SELECT r.id, r.name, r.is_owner,
            COALESCE((SELECT array_agg(p.permission ORDER BY p.permission) FROM staff_role_permissions p WHERE p.role_id = r.id), '{}') AS perms,
            (SELECT count(*)::int FROM users u WHERE u.staff_role_id = r.id AND u.deleted_at IS NULL) AS members
       FROM staff_roles r ORDER BY r.is_owner DESC, r.id`);
  res.json({
    roles: roles.map((r) => ({ id: r.id, name: r.name, isOwner: r.is_owner, memberCount: r.members,
      permissions: r.is_owner ? perms.map((p) => p.code) : r.perms })),
    permissions: perms.map((p) => ({ code: p.code, label: p.label, scope: 'staff' })),
  });
});

async function checkStaffPerms(list) {
  const codes = new Set((await db.many(STAFF_PERMS_SQL)).map((p) => p.code));
  const uniq = [...new Set(list)];
  const bad = uniq.filter((p) => !codes.has(p));
  if (bad.length) throw E.invalid('BAD_PERMISSION', `Not staff permissions: ${bad.join(', ')}`, 'permissions');
  return uniq.sort();
}
const nameRule = z.string().trim().min(1).max(40);

// 9.16 New role
router.post('/roles', need, async (req, res) => {
  const body = parse(z.object({ name: nameRule, permissions: z.array(z.string().max(40)).max(20) }), req.body);
  const perms = await checkStaffPerms(body.permissions);
  const r = await db.tx(async (c) => {
    let row;
    try {
      ({ rows: [row] } = await c.query('INSERT INTO staff_roles (name) VALUES ($1) RETURNING id, name', [body.name]));
    } catch (err) {
      if (err.code === '23505') throw E.conflict('ROLE_EXISTS', 'A role with this name already exists', 'name');
      throw err;
    }
    if (perms.length) await c.query('INSERT INTO staff_role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [row.id, perms]);
    await audit(req, { action: 'team.role.create', targetType: 'role', targetId: row.id, targetLabel: row.name, detail: perms.join(', ') }, c);
    return row;
  });
  res.status(201).json({ id: r.id, name: r.name, isOwner: false, permissions: perms, memberCount: 0 });
});

// 9.17 Rename / switch permissions (Owner is locked)
router.patch('/roles/:id', need, async (req, res) => {
  const body = parse(z.object({ name: nameRule.optional(), permissions: z.array(z.string().max(40)).max(20).optional() }).strict(), req.body);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw E.notFound('Role not found');
  const r = await role(id);
  if (r.is_owner) throw E.conflict('ROLE_LOCKED', 'The Owner role always has every permission');
  const perms = body.permissions ? await checkStaffPerms(body.permissions) : null;
  await db.tx(async (c) => {
    if (body.name && body.name !== r.name) {
      try { await c.query('UPDATE staff_roles SET name = $2 WHERE id = $1', [id, body.name]); } catch (err) {
        if (err.code === '23505') throw E.conflict('ROLE_EXISTS', 'A role with this name already exists', 'name');
        throw err;
      }
    }
    if (perms) {
      await c.query('DELETE FROM staff_role_permissions WHERE role_id = $1', [id]);
      if (perms.length) await c.query('INSERT INTO staff_role_permissions (role_id, permission) SELECT $1, unnest($2::text[])', [id, perms]);
    }
    await audit(req, { action: 'team.role.update', targetType: 'role', targetId: id, targetLabel: body.name || r.name,
      detail: perms ? perms.join(', ') : 'renamed' }, c);
  });
  const members = await db.many('SELECT id FROM users WHERE staff_role_id = $1', [id]);
  for (const m of members) realtime.disconnectUser(m.id);   // sockets rejoin admin rooms with the new permissions
  const out = (await db.many(`SELECT permission FROM staff_role_permissions WHERE role_id = $1 ORDER BY permission`, [id])).map((x) => x.permission);
  res.json({ id, name: body.name || r.name, isOwner: false, permissions: out, memberCount: members.length });
});

// 9.18 Delete an unused role
router.delete('/roles/:id', need, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw E.notFound('Role not found');
  const r = await role(id);
  if (r.is_owner) throw E.conflict('ROLE_LOCKED', 'The Owner role cannot be deleted');
  if ((await db.one('SELECT count(*)::int AS n FROM users WHERE staff_role_id = $1 AND deleted_at IS NULL', [id])).n) {
    throw E.conflict('ROLE_IN_USE', 'Move its members to another role first');
  }
  await db.tx(async (c) => {
    await c.query('DELETE FROM staff_roles WHERE id = $1', [id]);
    await audit(req, { action: 'team.role.delete', targetType: 'role', targetId: id, targetLabel: r.name }, c);
  });
  res.status(204).end();
});

module.exports = router;
