import {
  getActiveRelationshipByRole,
  getActiveRelationshipByPerson,
  getUserEntity,
  getUserEntities,
  getUserEntityByRole,
  readActiveRelationships,
} from '../relationships/index';
import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';


export interface ImmediateDeviceActionPayload {
  status: 'ready' | 'missing_number' | 'ambiguous' | 'unknown_person';
  action: 'call' | 'sms' | 'none';
  recipientName?: string;
  role?: string;
  phoneNumber?: string;
  sanitizedPhone?: string;
  prefilledMessage?: string;
  feedbackMessage: string;
  candidates?: Array<{ name: string; role?: string }>;
}

export interface ContactQueryResult {
  found: boolean;
  recipientName?: string;
  role?: string;
  phoneNumber?: string;
  email?: string;
  answer: string;
}

// Sanitize phone number for tel: or sms: URI (retain leading + if present, strip spaces/hyphens/brackets)
export function sanitizePhoneNumberForUri(phone: string): string {
  if (!phone) return '';
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

export async function resolveContactAction(params: {
  targetPerson: string | null;
  targetRole: string | null;
  actionType: 'call' | 'sms';
  prefilledMessage: string | null;
  rawInput: string;
}): Promise<ImmediateDeviceActionPayload> {
  const { actionType, prefilledMessage, rawInput } = params;
  let personQuery = (params.targetPerson || '').trim();
  let roleQuery = (params.targetRole || '').trim();

  // If both person and role are empty, try extracting from raw input (e.g. "Ring Fred" -> "Fred", "Call Mum" -> "Mum")
  if (!personQuery && !roleQuery) {
    const verbMatch = rawInput.match(/\b(?:call|ring|phone|text|message)\s+([a-z0-9'’]+(?:\s+[a-z0-9'’]+)?)\b/i);
    if (verbMatch && verbMatch[1]) {
      const candidate = verbMatch[1].trim();
      if (!['tomorrow', 'today', 'tonight', 'later', 'him', 'her', 'them', 'me'].includes(candidate.toLowerCase())) {
        personQuery = candidate;
      }
    }
  }

  // 1. Check all user entities and active relationships to detect ambiguity or exact matches
  const allEntities = await getUserEntities();
  const activeRelationships = await readActiveRelationships();

  // Filter candidates matching person name
  let matchedPersonCandidates: Array<{ name: string; role?: string; phone?: string }> = [];
  if (personQuery) {
    const qLower = personQuery.toLowerCase();
    for (const ent of allEntities) {
      if (ent.name.toLowerCase() === qLower || ent.name.toLowerCase().startsWith(`${qLower} `)) {
        matchedPersonCandidates.push({
          name: ent.name,
          role: ent.role || undefined,
          phone: ent.metadata?.phone || ent.metadata?.mobile || undefined,
        });
      }
    }
    // Also check active relationships
    for (const rel of activeRelationships) {
      if (rel.person.toLowerCase() === qLower || rel.person.toLowerCase().startsWith(`${qLower} `)) {
        if (!matchedPersonCandidates.some(c => c.name.toLowerCase() === rel.person.toLowerCase())) {
          matchedPersonCandidates.push({
            name: rel.person,
            role: rel.role,
            phone: undefined,
          });
        }
      }
    }
  }

  // Check if target was given as role (e.g. "electrician", "plumber", "mum")
  if (matchedPersonCandidates.length === 0 && (roleQuery || personQuery)) {
    const searchRole = roleQuery || personQuery;
    const relByRole = await getActiveRelationshipByRole(searchRole);
    if (relByRole) {
      const ent = await getUserEntity(relByRole.person);
      matchedPersonCandidates.push({
        name: relByRole.person,
        role: relByRole.role,
        phone: ent?.metadata?.phone || ent?.metadata?.mobile || undefined,
      });
    } else {
      const entByRole = await getUserEntityByRole(searchRole);
      if (entByRole) {
        matchedPersonCandidates.push({
          name: entByRole.name,
          role: entByRole.role || undefined,
          phone: entByRole.metadata?.phone || entByRole.metadata?.mobile || undefined,
        });
      }
    }
  }

  // Handle Ambiguity: Multiple distinct people match the target
  if (matchedPersonCandidates.length > 1) {
    // Check if they are truly distinct entities (different full names or different roles)
    const distinctNames = Array.from(new Set(matchedPersonCandidates.map(c => c.name.toLowerCase())));
    if (distinctNames.length > 1) {
      const candidateList = matchedPersonCandidates.map(c =>
        c.role ? `${c.name} your ${c.role}` : c.name
      );
      const question = `Which ${personQuery} — ${candidateList.join(' or ')}?`;
      return {
        status: 'ambiguous',
        action: actionType,
        feedbackMessage: question,
        candidates: matchedPersonCandidates,
      };
    }
  }

  // If no candidates found
  if (matchedPersonCandidates.length === 0) {
    const targetName = personQuery || roleQuery || 'that person';
    return {
      status: 'unknown_person',
      action: actionType,
      feedbackMessage: `I don't have a contact or relationship saved for ${targetName}. Would you like to add their details?`,
    };
  }

  const resolved = matchedPersonCandidates[0];
  let phone = resolved.phone;

  // If phone wasn't in the entity object directly, check entity table again by exact name
  if (!phone) {
    const ent = await getUserEntity(resolved.name);
    phone = ent?.metadata?.phone || ent?.metadata?.mobile || undefined;
  }

  // If still no phone, check stored memories table for any phone number associated with this person
  if (!phone) {
    try {
      await initBunnyDb();
      const memResults = await executeBunnySql([{
        sql: `SELECT content, originalText FROM memories WHERE LOWER(content) LIKE LOWER(?) OR LOWER(originalText) LIKE LOWER(?);`,
        args: [`%${resolved.name}%`, `%${resolved.name}%`]
      }]);
      if (memResults[0]?.rows) {
        for (const row of memResults[0].rows) {
          const text = `${row.content || ''} ${row.originalText || ''}`;

          const phonePattern = /(?:(?:(?:\+?61\s*(?:\(0\))?|0)[2-478](?:[ -]?[0-9]){8})|(?:(?:\+?61\s*(?:\(0\))?|0)4(?:[ -]?[0-9]){8})|(?:\(?0[2-478]\)?\s*[0-9]{4}[ -]?[0-9]{4})|(?<!\d|\$|\/|-)\b(?:04[0-9]{2}[ -]?[0-9]{3}[ -]?[0-9]{3})\b)/i;
          const match = text.match(phonePattern);
          if (match) {
            phone = match[0].trim();
            break;
          }
        }
      }
    } catch {}
  }

  // Handle Missing Number
  if (!phone) {
    const roleDesc = resolved.role ? ` your ${resolved.role}` : '';
    return {
      status: 'missing_number',
      action: actionType,
      recipientName: resolved.name,
      role: resolved.role,
      feedbackMessage: `I know ${resolved.name} is${roleDesc}, but I don't have a phone number saved for them. Would you like to add their number?`,
    };
  }

  // Successfully Resolved with Phone Number
  const sanitized = sanitizePhoneNumberForUri(phone);
  const verbDesc = actionType === 'call' ? 'Calling' : 'Opening message to';
  const roleDesc = resolved.role ? ` (${resolved.role})` : '';
  const feedback = `${verbDesc} ${resolved.name}${roleDesc} at ${phone}...`;

  return {
    status: 'ready',
    action: actionType,
    recipientName: resolved.name,
    role: resolved.role,
    phoneNumber: phone,
    sanitizedPhone: sanitized,
    prefilledMessage: prefilledMessage || undefined,
    feedbackMessage: feedback,
  };
}

export async function resolveContactQuery(query: string): Promise<ContactQueryResult> {
  const qLower = query.toLowerCase();
  const allEntities = await getUserEntities();
  const activeRelationships = await readActiveRelationships();

  // Try matching any entity name or active relationship in the query
  for (const ent of allEntities) {
    if (qLower.includes(ent.name.toLowerCase())) {
      const phone = ent.metadata?.phone || ent.metadata?.mobile;
      const email = ent.metadata?.email;
      if (phone) {
        return {
          found: true,
          recipientName: ent.name,
          role: ent.role || undefined,
          phoneNumber: phone,
          email,
          answer: `${ent.name}'s phone number is ${phone}.`,
        };
      }
    }
  }

  // Check by role (e.g. "electrician", "mum", "doctor")
  for (const rel of activeRelationships) {
    if (qLower.includes(rel.role.toLowerCase()) || qLower.includes(rel.normalized_role.toLowerCase()) || qLower.includes(rel.person.toLowerCase())) {
      const ent = await getUserEntity(rel.person);
      const phone = ent?.metadata?.phone || ent?.metadata?.mobile;
      if (phone) {
        return {
          found: true,
          recipientName: rel.person,
          role: rel.role,
          phoneNumber: phone,
          answer: `${rel.person} (${rel.role})'s phone number is ${phone}.`,
        };
      } else {
        return {
          found: false,
          recipientName: rel.person,
          role: rel.role,
          answer: `I know ${rel.person} is your ${rel.role}, but I don't have a phone number saved for them.`,
        };
      }
    }
  }

  return {
    found: false,
    answer: "I don't have that contact information saved in your memories.",
  };
}
