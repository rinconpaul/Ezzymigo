import { formatLocalTimeContext, getYMDInTz, getTimeStrInTz } from '../utils/time';
import { readMemories } from '../db/memories';
import { readCalendarEvents } from '../calendar/store';
import { readActiveRelationships } from '../relationships/index';
import { getActiveUserOccasionOccurrences } from '../occasions/manager';
import { executeBunnySql } from '../db/client';
import { DEFAULT_EZZY_ID } from '../instances/entitlements';
import {
  EzzyWorldSnapshot,
  ThinkingOpportunity,
  SnapshotCalendarEvent,
  SnapshotMemoryItem,
  SnapshotEntityRelationship,
  SnapshotOccasion,
  SnapshotRecentInteraction,
} from './types';

export interface AssembleSnapshotOptions {
  ezzyId?: string;
  clientNow?: string;
  clientTimeZone?: string;
  clientLanguage?: string;
  clientRegion?: string;
  opportunity: ThinkingOpportunity;
  trigger: string;
  input?: string;
  recentInteractions?: SnapshotRecentInteraction[];
}

export async function assembleEzzyWorldSnapshot(
  options: AssembleSnapshotOptions
): Promise<EzzyWorldSnapshot> {
  const eid = (options.ezzyId || DEFAULT_EZZY_ID).trim();
  const localContext = formatLocalTimeContext(
    options.clientNow,
    options.clientTimeZone,
    options.clientLanguage,
    options.clientRegion
  );

  const now = localContext.referenceDate;
  const nowMs = now.getTime();
  const timeZone = localContext.timeZone;
  const todayYMD = getYMDInTz(now, timeZone);
  const timeStr = getTimeStrInTz(now, timeZone);

  // Parallel bounded database retrieval across authoritative Personal World
  const [
    allCalendarEvents,
    allMemories,
    activeRelationships,
    occasionOccurrences,
    reminderRows,
  ] = await Promise.all([
    readCalendarEvents(undefined, eid).catch(() => []),
    readMemories(eid).catch(() => []),
    readActiveRelationships(eid).catch(() => []),
    getActiveUserOccasionOccurrences(now, timeZone, 14, 60, eid).catch(() => []),
    executeBunnySql([
      {
        sql: `SELECT id, memoryId, title, body, remindAt FROM scheduled_reminders WHERE ezzy_id = ? AND notified = 0 ORDER BY remindAt ASC LIMIT 20;`,
        args: [eid],
      },
    ]).catch(() => []),
  ]);

  // 1. Process Calendar Events
  const todayEvents: SnapshotCalendarEvent[] = [];
  const recentlyCompletedEvents: SnapshotCalendarEvent[] = [];
  const upcomingEvents: SnapshotCalendarEvent[] = [];

  for (const ev of allCalendarEvents) {
    const isAllDay = Boolean(ev.is_all_day);
    let startMs = 0;
    let endMs = 0;
    let startYMD = '';

    if (isAllDay) {
      startYMD = (ev.start_datetime || '').slice(0, 10);
      const endYMD = (ev.end_datetime || '').slice(0, 10);
      if (startYMD <= todayYMD && (!endYMD || endYMD >= todayYMD)) {
        todayEvents.push({
          id: ev.id,
          title: ev.title,
          startDatetime: ev.start_datetime,
          endDatetime: ev.end_datetime,
          isAllDay: true,
          location: ev.location || undefined,
          description: ev.description || undefined,
          status: ev.status,
        });
      } else if (startYMD > todayYMD) {
        upcomingEvents.push({
          id: ev.id,
          title: ev.title,
          startDatetime: ev.start_datetime,
          endDatetime: ev.end_datetime,
          isAllDay: true,
          location: ev.location || undefined,
          description: ev.description || undefined,
          status: ev.status,
        });
      }
      continue;
    }

    const startDate = new Date(ev.start_datetime);
    const endDate = new Date(ev.end_datetime || ev.start_datetime);
    startMs = startDate.getTime();
    endMs = endDate.getTime();
    if (isNaN(startMs)) continue;
    startYMD = getYMDInTz(startDate, timeZone);

    const hoursUntilStart = (startMs - nowMs) / (1000 * 3600);
    const hoursSinceEnd = (nowMs - endMs) / (1000 * 3600);

    const snapshotEv: SnapshotCalendarEvent = {
      id: ev.id,
      title: ev.title,
      startDatetime: ev.start_datetime,
      endDatetime: ev.end_datetime,
      isAllDay: false,
      location: ev.location || undefined,
      description: ev.description || undefined,
      status: ev.status,
      hoursUntilStart: Math.round(hoursUntilStart * 10) / 10,
      hoursSinceEnd: Math.round(hoursSinceEnd * 10) / 10,
    };

    // Today's events: falls on today or currently active
    if (startYMD === todayYMD || (nowMs >= startMs && nowMs <= endMs)) {
      todayEvents.push(snapshotEv);
    }

    // Recently completed events: ended within the last 36 hours (e.g. today or yesterday)
    if (hoursSinceEnd > 0 && hoursSinceEnd <= 36) {
      recentlyCompletedEvents.push(snapshotEv);
    }

    // Upcoming events: starting in the next 7 days
    if (hoursUntilStart > 0 && hoursUntilStart <= 7 * 24) {
      upcomingEvents.push(snapshotEv);
    }
  }

  // 2. Process Timed Reminders
  const timedReminders: Array<{ id: string; memoryId: string; title: string; remindAt: string }> = [];
  const rawRemRows = reminderRows[0]?.rows || [];
  for (const r of rawRemRows) {
    timedReminders.push({
      id: r.id,
      memoryId: r.memoryId,
      title: r.title,
      remindAt: r.remindAt,
    });
  }

  // 3. Process Memories (Bounded Selection)
  const activeMemories: SnapshotMemoryItem[] = [];
  const recentCompletedOrHistoricalMemories: SnapshotMemoryItem[] = [];

  // Sort memories by recency (newest first)
  const sortedMemories = [...allMemories].sort((a, b) => {
    const tA = new Date(a.createdAt || 0).getTime();
    const tB = new Date(b.createdAt || 0).getTime();
    return tB - tA;
  });

  for (const m of sortedMemories) {
    const memStatus = m.status || m.interpretation?.status || 'active';
    if (memStatus === 'superseded') continue;

    const isDone = Boolean(m.isDone || memStatus === 'completed');
    const isDismissed = memStatus === 'dismissed';
    if (isDismissed) continue;

    const item: SnapshotMemoryItem = {
      id: m.id,
      originalText: m.originalText || '',
      content: m.interpretation?.content || m.content || m.originalText || '',
      kind: m.interpretation?.kind || m.kind || 'note',
      status: memStatus,
      isDone,
      createdAt: m.createdAt || '',
      people: m.interpretation?.people || m.people || [],
      places: m.interpretation?.places || m.places || [],
      topics: m.interpretation?.topics || m.topics || [],
      timingExpression: m.interpretation?.timing_expression || null,
      reminderDatetime: m.interpretation?.reminder_datetime || null,
      resurfacingTiming: m.interpretation?.resurfacing_timing || null,
    };

    if (!isDone) {
      if (activeMemories.length < 40) {
        activeMemories.push(item);
      }
    } else {
      if (recentCompletedOrHistoricalMemories.length < 15) {
        recentCompletedOrHistoricalMemories.push(item);
      }
    }
  }

  // 4. Process Relationships & Entities
  const relationships: SnapshotEntityRelationship[] = activeRelationships.map((r: any) => ({
    person: r.person,
    role: r.role,
    normalizedRole: r.normalized_role || undefined,
  }));

  // 5. Process Occasions
  const occasions: SnapshotOccasion[] = (occasionOccurrences || []).map((occ: any) => ({
    id: occ.id,
    name: occ.name,
    targetYMD: occ.target_ymd,
    daysUntil: occ.days_until,
    temporalDescription: occ.temporal_description || (occ.days_until === 0 ? 'today' : `${occ.days_until} days`),
    isToday: occ.is_today,
  }));

  return {
    ezzyId: eid,
    opportunity: options.opportunity,
    trigger: options.trigger,
    civilTime: {
      iso: now.toISOString(),
      timeZone,
      dateYMD: todayYMD,
      timeStr,
      dayOfWeek: localContext.weekday,
    },
    calendar: {
      todayEvents,
      recentlyCompletedEvents,
      upcomingEvents,
    },
    timedReminders,
    activeMemories,
    recentCompletedOrHistoricalMemories,
    relationships,
    occasions,
    recentInteractions: options.recentInteractions || [],
  };
}
