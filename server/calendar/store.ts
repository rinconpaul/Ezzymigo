import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';

// -------------------------------------------------------------
// Calendar Events Store Layer (External Calendar Integration)
// -------------------------------------------------------------

// Read calendar events from Bunny Database (optionally filtered by date range or search)
export async function readCalendarEvents(options: { startAfter?: string; startBefore?: string; limit?: number } = {}): Promise<any[]> {
  try {
    await initBunnyDb();
    let sql = 'SELECT id, source, sourceEventId, title, description, location, attendees, startDatetime, endDatetime, isAllDay, status, updatedAt FROM calendar_events';
    const conditions: string[] = [];
    const args: any[] = [];

    if (options.startAfter) {
      conditions.push('startDatetime >= ?');
      args.push(options.startAfter);
    }
    if (options.startBefore) {
      conditions.push('startDatetime <= ?');
      args.push(options.startBefore);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ' ORDER BY startDatetime ASC';

    if (options.limit && options.limit > 0) {
      sql += ` LIMIT ${options.limit}`;
    }

    const results = await executeBunnySql([{ sql: `${sql};`, args }]);
    if (!results[0] || !results[0].rows) return [];

    return results[0].rows.map((row: any) => ({
      id: row.id,
      source: row.source,
      source_event_id: row.sourceEventId,
      title: row.title,
      description: row.description || null,
      location: row.location || null,
      attendees: row.attendees ? JSON.parse(row.attendees) : [],
      start_datetime: row.startDatetime,
      end_datetime: row.endDatetime,
      is_all_day: Boolean(Number(row.isAllDay)),
      status: row.status,
      updated_at: row.updatedAt,
    }));
  } catch (err) {
    console.error('[Bunny DB] Error reading calendar events from database:', err);
    return [];
  }
}

export interface QueryCalendarEventsOptions {
  minDate?: string;
  maxDate?: string;
  textMatch?: string;
  limit?: number;
  direction?: 'asc' | 'desc';
}

// Targeted query function for Calendar events (parameterized SQL, zero schema changes)
export async function queryCalendarEvents(options: QueryCalendarEventsOptions = {}): Promise<any[]> {
  try {
    await initBunnyDb();
    let sql = 'SELECT id, source, sourceEventId, title, description, location, attendees, startDatetime, endDatetime, isAllDay, status, updatedAt FROM calendar_events';
    const conditions: string[] = [];
    const args: any[] = [];

    if (options.minDate) {
      conditions.push('startDatetime >= ?');
      args.push(options.minDate);
    }
    if (options.maxDate) {
      conditions.push('startDatetime <= ?');
      args.push(options.maxDate);
    }
    if (options.textMatch && options.textMatch.trim()) {
      const pattern = `%${options.textMatch.trim()}%`;
      conditions.push('(title LIKE ? OR description LIKE ? OR location LIKE ?)');
      args.push(pattern, pattern, pattern);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    const direction = options.direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    sql += ` ORDER BY startDatetime ${direction}`;

    if (options.limit && options.limit > 0) {
      sql += ` LIMIT ${options.limit}`;
    }

    const results = await executeBunnySql([{ sql: `${sql};`, args }]);
    if (!results[0] || !results[0].rows) return [];

    return results[0].rows.map((row: any) => ({
      id: row.id,
      source: row.source,
      source_event_id: row.sourceEventId,
      title: row.title,
      description: row.description || null,
      location: row.location || null,
      attendees: row.attendees ? JSON.parse(row.attendees) : [],
      start_datetime: row.startDatetime,
      end_datetime: row.endDatetime,
      is_all_day: Boolean(Number(row.isAllDay)),
      status: row.status,
      updated_at: row.updatedAt,
    }));
  } catch (err) {
    console.error('[Bunny DB] Error querying calendar events:', err);
    return [];
  }
}

export interface RetrieveCalendarContextParams {
  question: string;
  referenceDate?: Date;
  timeZone?: string;
  resolvedEntities?: Array<{ roleMatch: string; normalizedRole: string; resolvedPerson: string }>;
  activeRelationships?: Array<{ id: string; person: string; role: string; normalized_role: string; is_active: boolean }>;
}

export async function retrieveTargetedCalendarEvents(params: RetrieveCalendarContextParams): Promise<{
  events: any[];
  usedTargetedPath: boolean;
  queryStrategy: string;
}> {
  // Temporary rollback / kill-switch flag
  if (process.env.DISABLE_TARGETED_CALENDAR_RETRIEVAL === 'true') {
    const events = await readCalendarEvents();
    return { events, usedTargetedPath: false, queryStrategy: 'fallback_full_table' };
  }

  const { question, resolvedEntities = [], activeRelationships = [] } = params;
  const qLower = question.toLowerCase();
  const refDate = params.referenceDate || new Date();
  const refTime = refDate.getTime();

  // 1. Check for specific name/person/entity in query
  let targetName: string | null = null;
  const drMatch = question.match(/\b(?:dr|doctor)\.?\s+([a-z0-9'-]+)/i);
  if (drMatch && drMatch[1]) {
    targetName = drMatch[1].trim();
  }

  if (!targetName && resolvedEntities.length > 0) {
    targetName = resolvedEntities[0].resolvedPerson;
  }

  if (!targetName) {
    for (const rel of activeRelationships) {
      if (rel.person && qLower.includes(rel.person.toLowerCase())) {
        targetName = rel.person;
        break;
      }
    }
  }

  if (!targetName) {
    const healthMatches = ['dentist', 'physio', 'optometrist', 'mechanic', 'vet', 'specialist', 'barber', 'hairdresser'];
    for (const hm of healthMatches) {
      if (qLower.includes(hm)) {
        targetName = hm;
        break;
      }
    }
  }

  // 2. Temporal Intent Analysis
  const isGenericSchedule = /\b(?:what(?:'s|\s+is|\s+are|\s+do\s+i\s+have)?\s+(?:on\s+my\s+calendar|my\s+schedule|coming\s+up|upcoming|scheduled|my\s+agenda|on\s+the\s+agenda))\b/i.test(qLower) ||
    /\b(?:what|any|list|show|check|got|have)\s+(?:upcoming\s+)?(?:appointments|meetings|events|schedule|calendar|plans)\b/i.test(qLower) ||
    /\b(?:what(?:\s+have\s+i|\s+do\s+i)\s+got\s+coming\s+up)\b/i.test(qLower) ||
    /\b(?:what\s+am\s+i\s+doing)\b/i.test(qLower) ||
    /\b(?:calendar|schedule|appointments?|meetings?|agenda)\b/i.test(qLower);

  const isHistorical = /\b(?:last\s+week|last\s+month|last\s+year|yesterday|past|previous|history|did\s+i\s+have|did\s+i\s+see)\b/i.test(qLower);

  // If a specific name is detected (e.g. "When am I seeing Dr Marning?"):
  if (targetName) {
    const events = await queryCalendarEvents({
      textMatch: targetName,
      limit: 25,
      direction: isHistorical ? 'desc' : 'asc',
    });
    if (events.length > 0 || !isGenericSchedule) {
      return { events, usedTargetedPath: true, queryStrategy: `targeted_name_match:${targetName}` };
    }
  }

  // If explicit generic schedule / upcoming query (e.g. "What appointments have I got coming up?"):
  if (isGenericSchedule && !isHistorical) {
    const startOfTodayIso = new Date(refTime - 24 * 60 * 60 * 1000).toISOString();
    const events = await queryCalendarEvents({
      minDate: startOfTodayIso,
      limit: 30,
      direction: 'asc',
    });
    return { events, usedTargetedPath: true, queryStrategy: 'targeted_upcoming_range' };
  }

  // If historical query (e.g. "What appointments did I have last month?"):
  if (isHistorical) {
    let minDate: string | undefined;
    let maxDate: string | undefined = new Date(refTime).toISOString();

    if (/\blast\s+month\b/i.test(qLower)) {
      const year = refDate.getFullYear();
      const month = refDate.getMonth();
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;
      minDate = new Date(Date.UTC(prevYear, prevMonth, 1)).toISOString();
      maxDate = new Date(Date.UTC(prevYear, prevMonth + 1, 0, 23, 59, 59)).toISOString();
    } else if (/\blast\s+week\b/i.test(qLower)) {
      minDate = new Date(refTime - 14 * 24 * 60 * 60 * 1000).toISOString();
      maxDate = new Date(refTime).toISOString();
    } else if (/\blast\s+year\b/i.test(qLower)) {
      const prevYear = refDate.getFullYear() - 1;
      minDate = new Date(Date.UTC(prevYear, 0, 1)).toISOString();
      maxDate = new Date(Date.UTC(prevYear, 11, 31, 23, 59, 59)).toISOString();
    }

    const events = await queryCalendarEvents({
      minDate,
      maxDate,
      limit: 50,
      direction: 'desc',
    });
    return { events, usedTargetedPath: true, queryStrategy: 'targeted_historical_range' };
  }

  // Default bounded window for mixed / general queries (covers -7 days to +60 days)
  const defaultMin = new Date(refTime - 7 * 24 * 60 * 60 * 1000).toISOString();
  const defaultMax = new Date(refTime + 60 * 24 * 60 * 60 * 1000).toISOString();
  const events = await queryCalendarEvents({
    minDate: defaultMin,
    maxDate: defaultMax,
    limit: 50,
    direction: 'asc',
  });

  return { events, usedTargetedPath: true, queryStrategy: 'bounded_rolling_window' };
}

// Helper to compute deterministic, canonical Google Calendar identity
export function canonicalizeCalendarEvent(ev: any): { id: string; source: string; sourceEventId: string } {
  const source = ev.source || 'google_calendar';
  let sourceEventId = ev.source_event_id || ev.sourceEventId || '';
  let id = ev.id || '';

  if (source === 'google_calendar') {
    if (sourceEventId.includes('#')) {
      const hashIndex = sourceEventId.indexOf('#');
      const calId = sourceEventId.substring(0, hashIndex);
      const googleEventId = sourceEventId.substring(hashIndex + 1);
      const sanitizedCalendarId = calId === 'primary' ? 'primary' : calId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const canonicalId = `cal_google_${sanitizedCalendarId}_${googleEventId}`;
      if (!id || id.startsWith('cal_ext_') || id.startsWith('cal_google_calendar_')) {
        id = canonicalId;
      }
    } else if (sourceEventId) {
      // Single event ID without calendar qualifier -> default to primary
      const canonicalId = `cal_google_primary_${sourceEventId}`;
      if (!id || id.startsWith('cal_ext_') || id.startsWith('cal_google_calendar_')) {
        id = canonicalId;
      }
      sourceEventId = `primary#${sourceEventId}`;
    } else if (id && id.startsWith('cal_google_')) {
      sourceEventId = id.replace(/^cal_google_/, '');
    } else {
      const fallbackKey = Math.random().toString(36).substring(2, 9);
      id = id || `cal_google_primary_${fallbackKey}`;
      sourceEventId = `primary#${fallbackKey}`;
    }
  } else {
    if (!id) {
      id = `cal_${source}_${sourceEventId || Math.random().toString(36).substring(2, 9)}`;
    }
    if (!sourceEventId) {
      sourceEventId = id;
    }
  }

  return { id, source, sourceEventId };
}

// Upsert calendar events into Bunny Database (keyed by deterministic canonical id)
export async function upsertCalendarEvents(events: any[]): Promise<void> {
  if (!events || events.length === 0) return;
  await initBunnyDb();

  const stmts: Array<{ sql: string; args: any[] }> = [];
  const nowIso = new Date().toISOString();

  for (const ev of events) {
    const { id, source, sourceEventId } = canonicalizeCalendarEvent(ev);
    const isAllDay = Boolean(ev.is_all_day || Number(ev.isAllDay));
    let startVal = ev.start_datetime || ev.startDatetime || nowIso;
    let endVal = ev.end_datetime || ev.endDatetime || nowIso;
    if (isAllDay) {
      startVal = String(startVal).slice(0, 10);
      endVal = String(endVal).slice(0, 10);
    }
    stmts.push({
      sql: `INSERT INTO calendar_events (id, source, sourceEventId, title, description, location, attendees, startDatetime, endDatetime, isAllDay, status, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              source = excluded.source,
              sourceEventId = excluded.sourceEventId,
              title = excluded.title,
              description = excluded.description,
              location = excluded.location,
              attendees = excluded.attendees,
              startDatetime = excluded.startDatetime,
              endDatetime = excluded.endDatetime,
              isAllDay = excluded.isAllDay,
              status = excluded.status,
              updatedAt = excluded.updatedAt;`,
      args: [
        id,
        source,
        sourceEventId,
        ev.title || 'Untitled Event',
        ev.description || null,
        ev.location || null,
        JSON.stringify(Array.isArray(ev.attendees) ? ev.attendees : []),
        startVal,
        endVal,
        isAllDay ? 1 : 0,
        ev.status || 'confirmed',
        ev.updated_at || ev.updatedAt || nowIso,
      ]
    });
  }

  await executeBunnySql(stmts);
}

// Delete calendar events by ID
export async function deleteCalendarEventFromDb(id: string): Promise<void> {
  await initBunnyDb();
  await executeBunnySql([{
    sql: 'DELETE FROM calendar_events WHERE id = ?;',
    args: [id]
  }]);
}
