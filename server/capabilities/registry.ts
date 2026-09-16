import {
  CapabilityName,
  CapabilityExecutionRequest,
  CapabilityExecutionResult,
} from './types';
import { executeSearchPlaces } from './searchPlaces';

// Whitelist of approved capabilities. Unapproved capabilities or action executions are strictly prohibited.
export const APPROVED_CAPABILITIES: ReadonlySet<string> = new Set<CapabilityName>([
  'search_places',
]);

// Explicitly blocked safety actions to protect the user
export const PROHIBITED_CAPABILITIES: ReadonlySet<string> = new Set([
  'make_booking',
  'place_booking',
  'book_reservation',
  'send_message',
  'send_sms',
  'send_email',
  'place_call',
  'make_call',
  'purchase',
  'make_payment',
]);

/**
 * Feature flag check for capability execution.
 * Production capability execution is strictly disabled.
 * Capabilities are ONLY executable when ENABLE_EZZY_CAPABILITIES is set in an isolated test process
 * AND the target tenant is an isolated disposable test tenant (test_*, disposable_*, ezzy_test_*).
 */
export function areCapabilitiesEnabled(ezzyId?: string): boolean {
  const isTestFlagEnabled = process.env.ENABLE_EZZY_CAPABILITIES === 'true';
  const isDisposableTestTenant = Boolean(
    ezzyId &&
      (ezzyId.startsWith('test_') ||
        ezzyId.startsWith('disposable_') ||
        ezzyId.startsWith('ezzy_test_'))
  );

  if (isTestFlagEnabled && isDisposableTestTenant) {
    return true;
  }
  return false;
}

export async function executeCapability(
  request: CapabilityExecutionRequest
): Promise<CapabilityExecutionResult> {
  const t0 = Date.now();
  const eid = (request.ezzyId || '').trim();
  if (!eid) {
    throw new Error('Tenant identification (ezzyId) is required for capability execution');
  }

  // 0. Production Feature Flag Guard: Strictly disabled for all production tenants
  if (!areCapabilitiesEnabled(eid)) {
    throw new Error(
      `Capability execution is strictly disabled for tenant "${eid}". Production execution is not enabled.`
    );
  }

  const capName = request.capability;

  // 1. Safety Guard: Check against prohibited actions
  if (PROHIBITED_CAPABILITIES.has(capName)) {
    throw new Error(
      `Capability "${capName}" is strictly prohibited. Ezzy conducts grounded research and presents actionable information to the user, but never makes automated bookings, messages, or calls.`
    );
  }

  // 2. Approval Check: Ensure capability is in the approved registry
  if (!APPROVED_CAPABILITIES.has(capName)) {
    throw new Error(
      `Capability "${capName}" is not an approved capability. Approved capabilities: ${Array.from(APPROVED_CAPABILITIES).join(', ')}`
    );
  }

  let resultData: any;

  switch (capName) {
    case 'search_places': {
      const searchParams = {
        query: request.parameters.query || '',
        location: request.parameters.location || request.parameters.locality || undefined,
        category: request.parameters.category || undefined,
        placeType: request.parameters.placeType || undefined,
        criteria: request.parameters.criteria || undefined,
        limit: request.parameters.limit || 3,
      };

      resultData = await executeSearchPlaces({
        request: searchParams,
        userMemories: request.userMemories,
        clientTimeZone: request.clientTimeZone,
        clientRegion: request.clientRegion,
      });
      break;
    }
    default:
      throw new Error(`Unhandled capability: ${capName}`);
  }

  const latencyMs = Date.now() - t0;
  return {
    capability: capName,
    success: Boolean(resultData?.success),
    data: resultData,
    executedAt: new Date().toISOString(),
    latencyMs,
  };
}
