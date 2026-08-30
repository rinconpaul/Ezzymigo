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
        ev.start_datetime || ev.startDatetime || nowIso,
        ev.end_datetime || ev.endDatetime || nowIso,
        ev.is_all_day ? 1 : 0,
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
