import type { Request } from 'express';

export const DEFAULT_DEV_USER_ID = 'default_user';

/**
 * Extracts requesting user_id from the incoming HTTP request.
 *
 * Isolated behind this boundary so Flutter/native mobile authentication
 * (e.g. Firebase Auth token, session JWT, Bearer token) can seamlessly replace it later.
 * In development, reads from 'x-user-id' / 'user-id' header, query string, or body,
 * defaulting to DEFAULT_DEV_USER_ID ('default_user').
 */
export function extractUserId(req: Request): string {
  const headerUserId = (req.headers['x-user-id'] || req.headers['user-id']) as string | undefined;
  if (headerUserId && typeof headerUserId === 'string' && headerUserId.trim()) {
    return headerUserId.trim();
  }
  if (req.query && typeof req.query.user_id === 'string' && req.query.user_id.trim()) {
    return req.query.user_id.trim();
  }
  if (req.body && typeof req.body.user_id === 'string' && req.body.user_id.trim()) {
    return req.body.user_id.trim();
  }
  return DEFAULT_DEV_USER_ID;
}
