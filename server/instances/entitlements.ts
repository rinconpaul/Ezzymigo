import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';

export type InstanceStatus = 'trial' | 'active' | 'expired';
export type MemberRole = 'owner' | 'admin' | 'member' | 'guest';

export interface EzzyInstance {
  id: string;
  name: string;
  owner_user_id: string;
  status: InstanceStatus;
  plan_tier: string;
  member_limit: number;
  trial_ends_at: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

export interface EzzyMember {
  id: string;
  ezzy_id: string;
  user_id: string;
  name: string;
  role: MemberRole;
  joined_at: string;
}

export class EntitlementViolation extends Error {
  code: 'ENTITLEMENT_EXPIRED' | 'MEMBER_LIMIT_REACHED' | 'MEMBER_LIMIT_EXCEEDED' | 'INSTANCE_NOT_FOUND' | 'INVALID_INSTANCE_STATUS' | 'NOT_A_MEMBER';
  ezzyId: string;

  constructor(
    code: 'ENTITLEMENT_EXPIRED' | 'MEMBER_LIMIT_REACHED' | 'MEMBER_LIMIT_EXCEEDED' | 'INSTANCE_NOT_FOUND' | 'INVALID_INSTANCE_STATUS' | 'NOT_A_MEMBER',
    ezzyId: string,
    message: string
  ) {
    super(message);
    this.name = 'EntitlementViolation';
    this.code = code;
    this.ezzyId = ezzyId;
  }
}

export const DEFAULT_EZZY_ID = 'ezzy_default';

/**
 * Retrieves an Ezzy instance by its ID.
 */
export async function getEzzyInstance(ezzyId: string): Promise<EzzyInstance | null> {
  await initBunnyDb();
  const id = (ezzyId || DEFAULT_EZZY_ID).trim();

  try {
    const results = await executeBunnySql([
      {
        sql: `SELECT id, name, owner_user_id, status, plan_tier, member_limit, trial_ends_at, created_at, updated_at
              FROM ezzy_instances
              WHERE id = ? LIMIT 1;`,
        args: [id],
      },
      {
        sql: `SELECT COUNT(*) as member_count FROM ezzy_members WHERE ezzy_id = ?;`,
        args: [id],
      }
    ]);

    const row = results[0]?.rows?.[0];
    if (!row) return null;

    const memberCount = Number(results[1]?.rows?.[0]?.member_count || 0);

    return {
      id: String(row.id),
      name: String(row.name),
      owner_user_id: String(row.owner_user_id),
      status: row.status as InstanceStatus,
      plan_tier: String(row.plan_tier),
      member_limit: Number(row.member_limit || 5),
      trial_ends_at: row.trial_ends_at ? String(row.trial_ends_at) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      member_count: memberCount,
    };
  } catch (err) {
    console.error(`[Instances] Error getting instance "${id}":`, err);
    return null;
  }
}

/**
 * Creates a new Ezzy instance with default or custom entitlement boundaries.
 */
export async function createEzzyInstance(params: {
  id?: string;
  name: string;
  ownerUserId?: string;
  created_by?: string;
  status?: InstanceStatus;
  planTier?: string;
  plan?: string;
  memberLimit?: number;
  max_members?: number;
  trialDays?: number;
  trialEndsAt?: string | null;
  trial_ends_at?: string | null;
  expires_at?: string | null;
}): Promise<EzzyInstance> {
  await initBunnyDb();

  const id = (params.id || `ezzy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`).trim();
  const name = params.name ? params.name.trim() : 'Ezzy';
  const ownerUserId = (params.ownerUserId || params.created_by || 'default_owner').trim();
  const status: InstanceStatus = params.status || 'trial';
  const planTier = params.planTier || params.plan || (status === 'trial' ? 'trial' : 'family');
  const memberLimit = typeof params.memberLimit === 'number' && params.memberLimit > 0
    ? params.memberLimit
    : typeof params.max_members === 'number' && params.max_members > 0
    ? params.max_members
    : 5;

  let trialEndsAt: string | null = params.trialEndsAt !== undefined
    ? params.trialEndsAt
    : params.trial_ends_at !== undefined
    ? params.trial_ends_at
    : null;
  if (status === 'trial' && trialEndsAt === null) {
    const days = params.trialDays || 14;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);
    trialEndsAt = expiry.toISOString();
  }

  const now = new Date().toISOString();

  await executeBunnySql([
    {
      sql: `INSERT INTO ezzy_instances (id, name, owner_user_id, status, plan_tier, member_limit, trial_ends_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              status = excluded.status,
              plan_tier = excluded.plan_tier,
              member_limit = excluded.member_limit,
              trial_ends_at = excluded.trial_ends_at,
              updated_at = excluded.updated_at;`,
      args: [id, name, ownerUserId, status, planTier, memberLimit, trialEndsAt, now, now],
    },
    {
      // Automatically add owner as the first member
      sql: `INSERT OR IGNORE INTO ezzy_members (id, ezzy_id, user_id, name, role, joined_at)
            VALUES (?, ?, ?, ?, ?, ?);`,
      args: [`mem_${id}_${ownerUserId}`, id, ownerUserId, `${name} Owner`, 'owner', now],
    }
  ]);

  return {
    id,
    name,
    owner_user_id: ownerUserId,
    status,
    plan_tier: planTier,
    member_limit: memberLimit,
    trial_ends_at: trialEndsAt,
    created_at: now,
    updated_at: now,
    member_count: 1,
  };
}

/**
 * Updates instance attributes (status, plan_tier, member_limit, etc.).
 */
export async function updateEzzyInstance(
  ezzyId: string,
  updates: Partial<{
    name: string;
    status: InstanceStatus;
    planTier: string;
    memberLimit: number;
    trialEndsAt: string | null;
  }>
): Promise<EzzyInstance> {
  const current = await getEzzyInstance(ezzyId);
  if (!current) {
    throw new EntitlementViolation('INSTANCE_NOT_FOUND', ezzyId, `Ezzy instance "${ezzyId}" not found`);
  }

  const name = updates.name !== undefined ? updates.name.trim() : current.name;
  const status = updates.status !== undefined ? updates.status : current.status;
  const planTier = updates.planTier !== undefined ? updates.planTier : current.plan_tier;
  const memberLimit = updates.memberLimit !== undefined ? updates.memberLimit : current.member_limit;
  const trialEndsAt = updates.trialEndsAt !== undefined ? updates.trialEndsAt : current.trial_ends_at;
  const updatedAt = new Date().toISOString();

  await executeBunnySql([
    {
      sql: `UPDATE ezzy_instances
            SET name = ?, status = ?, plan_tier = ?, member_limit = ?, trial_ends_at = ?, updated_at = ?
            WHERE id = ?;`,
      args: [name, status, planTier, memberLimit, trialEndsAt, updatedAt, ezzyId],
    }
  ]);

  return {
    ...current,
    name,
    status,
    plan_tier: planTier,
    member_limit: memberLimit,
    trial_ends_at: trialEndsAt,
    updated_at: updatedAt,
  };
}

/**
 * Lists all known Ezzy instances.
 */
export async function listEzzyInstances(): Promise<EzzyInstance[]> {
  await initBunnyDb();
  try {
    const results = await executeBunnySql([
      {
        sql: `SELECT id, name, owner_user_id, status, plan_tier, member_limit, trial_ends_at, created_at, updated_at
              FROM ezzy_instances
              ORDER BY created_at ASC;`
      }
    ]);

    if (!results[0]?.rows) return [];
    return results[0].rows.map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      owner_user_id: String(row.owner_user_id),
      status: row.status as InstanceStatus,
      plan_tier: String(row.plan_tier),
      member_limit: Number(row.member_limit || 5),
      trial_ends_at: row.trial_ends_at ? String(row.trial_ends_at) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }));
  } catch (err) {
    console.error('[Instances] Error listing instances:', err);
    return [];
  }
}

/**
 * Retrieves all members of an Ezzy instance.
 */
export async function getEzzyMembers(ezzyId: string): Promise<EzzyMember[]> {
  await initBunnyDb();
  const id = (ezzyId || DEFAULT_EZZY_ID).trim();

  try {
    const results = await executeBunnySql([
      {
        sql: `SELECT id, ezzy_id, user_id, name, role, joined_at
              FROM ezzy_members
              WHERE ezzy_id = ?
              ORDER BY joined_at ASC;`,
        args: [id],
      }
    ]);

    if (!results[0]?.rows) return [];
    return results[0].rows.map((row: any) => ({
      id: String(row.id),
      ezzy_id: String(row.ezzy_id),
      user_id: String(row.user_id),
      name: String(row.name),
      role: row.role as MemberRole,
      joined_at: String(row.joined_at),
    }));
  } catch (err) {
    console.error(`[Instances] Error getting members for instance "${id}":`, err);
    return [];
  }
}

/**
 * Adds a member to an Ezzy instance, strictly enforcing the member limit entitlement boundary.
 */
export async function addEzzyMember(
  ezzyId: string,
  memberOrUserId: string | { userId: string; name?: string; displayName?: string; role?: MemberRole },
  details?: { name?: string; displayName?: string; role?: MemberRole }
): Promise<EzzyMember> {
  await initBunnyDb();
  const instance = await getEzzyInstance(ezzyId);
  if (!instance) {
    throw new EntitlementViolation('INSTANCE_NOT_FOUND', ezzyId, `Ezzy instance "${ezzyId}" does not exist.`);
  }

  const userId = typeof memberOrUserId === 'string' ? memberOrUserId.trim() : memberOrUserId.userId.trim();
  const name = typeof memberOrUserId === 'string'
    ? (details?.displayName || details?.name || userId).trim()
    : (memberOrUserId.displayName || memberOrUserId.name || userId).trim();
  const role = typeof memberOrUserId === 'string'
    ? (details?.role || 'member')
    : (memberOrUserId.role || 'member');

  const existingMembers = await getEzzyMembers(ezzyId);
  const isExisting = existingMembers.some(m => m.user_id === userId);

  if (!isExisting && existingMembers.length >= instance.member_limit) {
    throw new EntitlementViolation(
      'MEMBER_LIMIT_REACHED',
      ezzyId,
      `Cannot add member: Member limit of ${instance.member_limit} reached for Ezzy instance "${instance.name}". Upgrade plan tier to add more members.`
    );
  }

  const memberId = `mem_${ezzyId}_${userId}`;
  const now = new Date().toISOString();

  await executeBunnySql([
    {
      sql: `INSERT INTO ezzy_members (id, ezzy_id, user_id, name, role, joined_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ezzy_id, user_id) DO UPDATE SET
              name = excluded.name,
              role = excluded.role;`,
      args: [memberId, ezzyId, userId, name, role, now],
    }
  ]);

  return {
    id: memberId,
    ezzy_id: ezzyId,
    user_id: userId,
    name,
    role,
    joined_at: now,
  };
}

/**
 * Removes a member from an Ezzy instance.
 */
export async function removeEzzyMember(ezzyId: string, userId: string): Promise<boolean> {
  await initBunnyDb();
  const results = await executeBunnySql([
    {
      sql: `DELETE FROM ezzy_members WHERE ezzy_id = ? AND user_id = ?;`,
      args: [ezzyId, userId],
    }
  ]);
  return (results[0]?.rowsAffected || 0) > 0;
}

/**
 * Checks entitlement status for an operation.
 * - 'read' is allowed even if expired (to view existing memories / export).
 * - 'write' is strictly rejected if expired or if trial period has ended.
 */
export async function checkEzzyEntitlement(
  ezzyId: string,
  operation: 'read' | 'write' = 'read'
): Promise<{
  allowed: boolean;
  effectiveStatus: InstanceStatus;
  instance: EzzyInstance;
  reason?: string;
}> {
  const instance = await getEzzyInstance(ezzyId);
  if (!instance) {
    throw new EntitlementViolation('INSTANCE_NOT_FOUND', ezzyId, `Ezzy instance "${ezzyId}" does not exist.`);
  }

  let effectiveStatus: InstanceStatus = instance.status;

  // Check trial expiration
  if (instance.status === 'trial' && instance.trial_ends_at) {
    const expiryDate = new Date(instance.trial_ends_at);
    if (!isNaN(expiryDate.getTime()) && expiryDate.getTime() < Date.now()) {
      effectiveStatus = 'expired';
    }
  }

  if (effectiveStatus === 'expired') {
    if (operation === 'write') {
      return {
        allowed: false,
        effectiveStatus,
        instance,
        reason: `Ezzy instance "${instance.name}" is expired. An active subscription or trial is required to perform Tell, create memories, or mutate data.`,
      };
    }
    // Read operations on expired instance remain permitted
    return {
      allowed: true,
      effectiveStatus,
      instance,
      reason: 'Instance is expired; read-only access granted.',
    };
  }

  return {
    allowed: true,
    effectiveStatus,
    instance,
  };
}

/**
 * Retrieves the membership record for a specific user in an Ezzy instance.
 */
export async function getEzzyMember(ezzyId: string, userId: string): Promise<EzzyMember | null> {
  await initBunnyDb();
  const eid = (ezzyId || DEFAULT_EZZY_ID).trim();
  const uid = (userId || '').trim();
  if (!uid) return null;

  try {
    const results = await executeBunnySql([
      {
        sql: `SELECT id, ezzy_id, user_id, name, role, joined_at
              FROM ezzy_members
              WHERE ezzy_id = ? AND user_id = ? LIMIT 1;`,
        args: [eid, uid],
      },
    ]);
    const row = results[0]?.rows?.[0];
    if (!row) return null;
    return {
      id: String(row.id),
      ezzy_id: String(row.ezzy_id),
      user_id: String(row.user_id),
      name: String(row.name),
      role: row.role as MemberRole,
      joined_at: String(row.joined_at),
    };
  } catch (err) {
    console.error(`[Instances] Error fetching member "${uid}" in instance "${eid}":`, err);
    return null;
  }
}

/**
 * Checks whether a user is an active member of an Ezzy instance.
 */
export async function isEzzyMember(ezzyId: string, userId: string): Promise<boolean> {
  const member = await getEzzyMember(ezzyId, userId);
  return member !== null;
}

/**
 * Detailed membership check returning structured membership status.
 */
export async function checkEzzyMembership(
  ezzyId: string,
  userId: string
): Promise<{ isMember: boolean; status: 'active' | 'none'; member: EzzyMember | null }> {
  const member = await getEzzyMember(ezzyId, userId);
  if (!member) {
    return { isMember: false, status: 'none', member: null };
  }
  return { isMember: true, status: 'active', member };
}

/**
 * Asserts both:
 * 1. Requesting user is an active member of the specified Ezzy instance.
 *    (A client-supplied ezzy_id is never proof of membership).
 * 2. The instance entitlement permits the requested action ('read' or 'write').
 *
 * Throws EntitlementViolation:
 * - 'INSTANCE_NOT_FOUND' if instance does not exist
 * - 'NOT_A_MEMBER' if requesting user is not an active member of the instance
 * - 'ENTITLEMENT_EXPIRED' if instance is expired and action is 'write'
 */
export async function assertEzzyAccess(
  ezzyId: string,
  userId: string,
  operation: 'read' | 'write'
): Promise<{ instance: EzzyInstance; member: EzzyMember }> {
  const eid = (ezzyId || DEFAULT_EZZY_ID).trim();
  const uid = (userId || '').trim();

  // 1. Verify instance exists
  const instance = await getEzzyInstance(eid);
  if (!instance) {
    throw new EntitlementViolation('INSTANCE_NOT_FOUND', eid, `Ezzy instance "${eid}" does not exist.`);
  }

  // 2. Enforce membership: client-supplied ezzy_id is NEVER proof of membership
  const member = await getEzzyMember(eid, uid);
  if (!member) {
    throw new EntitlementViolation(
      'NOT_A_MEMBER',
      eid,
      `User "${uid}" is not a member of Ezzy "${instance.name}" (${eid}). Access denied.`
    );
  }

  // 3. Enforce instance entitlement
  const entitlement = await checkEzzyEntitlement(eid, operation);
  if (!entitlement.allowed) {
    throw new EntitlementViolation(
      'ENTITLEMENT_EXPIRED',
      eid,
      entitlement.reason || `Ezzy instance "${eid}" is expired. ${operation === 'write' ? 'Writes are blocked.' : 'Access denied.'}`
    );
  }

  return { instance, member };
}

/**
 * Asserts write permission for an Ezzy instance.
 * If userId is provided, strictly asserts both membership and write entitlement.
 * Throws EntitlementViolation if user is not a member or instance write is expired.
 */
export async function assertEzzyWriteAllowed(ezzyId: string, userId?: string): Promise<EzzyInstance> {
  if (userId) {
    const access = await assertEzzyAccess(ezzyId, userId, 'write');
    return access.instance;
  }
  const entitlement = await checkEzzyEntitlement(ezzyId, 'write');
  if (!entitlement.allowed) {
    throw new EntitlementViolation(
      'ENTITLEMENT_EXPIRED',
      ezzyId,
      entitlement.reason || `Ezzy instance "${ezzyId}" is expired. Writes are blocked.`
    );
  }
  return entitlement.instance;
}

/**
 * Standard error responder for entitlement and membership violations.
 * Returns true if the error was handled and an HTTP response was sent, false otherwise.
 */
export function handleEntitlementError(res: any, error: any, ezzyId?: string): boolean {
  if (
    error instanceof EntitlementViolation ||
    error?.name === 'EntitlementViolation' ||
    ['NOT_A_MEMBER', 'ENTITLEMENT_EXPIRED', 'INSTANCE_NOT_FOUND', 'MEMBER_LIMIT_REACHED', 'MEMBER_LIMIT_EXCEEDED', 'INVALID_INSTANCE_STATUS'].includes(error?.code)
  ) {
    const code = error.code || 'ENTITLEMENT_VIOLATION';
    const status = code === 'INSTANCE_NOT_FOUND' ? 404 : 403;
    res.status(status).json({
      error: error.message || 'Entitlement or membership check failed.',
      code,
      ezzyId: error.ezzyId || ezzyId,
    });
    return true;
  }
  return false;
}

