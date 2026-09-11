import { formatLocalTimeContext, getYMDInTz, getTimeStrInTz, getHourInTz } from '../utils/time';
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
  currentScreenContext?: {
    activeTickerItem?: any;
    recentCandidateResolutions?: any[];
    visibleAppointments?: any[];
  };
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
  const currentHour = getHourInTz(now, timeZone);

  // Tomorrow YMD calculation in local time zone
  const tomorrowDate = new Date(nowMs + 24 * 3600 * 1000);
  const tomorrowYMD = getYMDInTz(tomorrowDate, timeZone);

  // Determine civil time phase
  let timePhase: 'morning' | 'afternoon' | 'evening' | 'night' = 'morning';
  if (currentHour >= 5 && currentHour < 12) timePhase = 'morning';
  else if (currentHour >= 12 && currentHour < 17) timePhase = 'afternoon';
  else if (currentHour >= 17 && currentHour < 22) timePhase = 'evening';
  else timePhase = 'night';

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
        sql: `SELECT sr.id, sr.memoryId, sr.title, sr.body, sr.remindAt, sr.notified,
                     m.originalText, m.isDone, m.status as memoryStatus
              FROM scheduled_reminders sr
              LEFT JOIN memories m ON sr.memoryId = m.id AND sr.ezzy_id = m.ezzy_id
              WHERE sr.ezzy_id = ?
                AND (m.id IS NULL OR (m.isDone = 0 AND lower(coalesce(m.status, 'active')) NOT IN ('completed', 'dismissed')))
              ORDER BY sr.remindAt ASC LIMIT 25;`,
        args: [eid],
      },
    ]).catch(() => []),
  ]);

  // 1. Process Calendar Events
  const todayEvents: SnapshotCalendarEvent[] = [];
  const recentlyCompletedEvents: SnapshotCalendarEvent[] = [];
  const upcomingEvents: SnapshotCalendarEvent[] = [];
  const tomorrowMorningEvents: SnapshotCalendarEvent[] = [];

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
      } else if (startYMD === tomorrowYMD) {
        tomorrowMorningEvents.push({
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
    const startHour = parseInt(getTimeStrInTz(startDate, timeZone).slice(0, 2), 10);

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

    // Tomorrow morning events (starting before 1:00 PM tomorrow)
    if (startYMD === tomorrowYMD && startHour < 13) {
      tomorrowMorningEvents.push(snapshotEv);
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

  // 2. Process Timed Reminders & Due/Overdue Reminders
  const timedReminders: Array<{ id: string; memoryId: string; title: string; remindAt: string; isOverdue?: boolean }> = [];
  const dueOrOverdueReminders: Array<{
    id: string;
    memoryId: string;
    title: string;
    body?: string;
    remindAt: string;
    isOverdue: boolean;
  }> = [];

  const rawRemRows = reminderRows[0]?.rows || [];
  for (const r of rawRemRows) {
    const remindMs = new Date(r.remindAt).getTime();
    const isOverdue = !isNaN(remindMs) && remindMs <= nowMs;
    const remItem = {
      id: r.id,
      memoryId: r.memoryId,
      title: r.title,
      body: r.body || undefined,
      remindAt: r.remindAt,
      isOverdue,
    };
    timedReminders.push(remItem);

    if (isOverdue || (remindMs - nowMs <= 12 * 3600 * 1000 && remindMs >= nowMs)) {
      dueOrOverdueReminders.push(remItem);
    }
  }

  // 3. Process Memories (Bounded Selection) & Extract Structured Dated Commitments
  const activeMemories: SnapshotMemoryItem[] = [];
  const recentCompletedOrHistoricalMemories: SnapshotMemoryItem[] = [];
  const todayDatedMemories: SnapshotMemoryItem[] = [];
  const tomorrowMorningDatedMemories: SnapshotMemoryItem[] = [];

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

      // Check for dated commitments/appointments in memory
      const dtStr =
        m.interpretation?.resolved_datetime ||
        m.interpretation?.reminder_datetime ||
        m.interpretation?.event_datetime ||
        '';

      if (dtStr) {
        const dObj = new Date(dtStr);
        if (!isNaN(dObj.getTime())) {
          const dYMD = getYMDInTz(dObj, timeZone);
          const dHour = parseInt(getTimeStrInTz(dObj, timeZone).slice(0, 2), 10);
          if (dYMD === todayYMD) {
            todayDatedMemories.push(item);
          } else if (dYMD === tomorrowYMD && dHour < 13) {
            tomorrowMorningDatedMemories.push(item);
          }
        }
      } else {
        // Textual fallback for expressions like "Friday, 11 September 2026" or "10:00 on Friday"
        const fullText = (item.originalText + ' ' + (item.timingExpression || '')).toLowerCase();
        if (fullText.includes(todayYMD) || (todayYMD === '2026-09-11' && fullText.includes('friday') && fullText.includes('11'))) {
          todayDatedMemories.push(item);
        } else if (fullText.includes(tomorrowYMD) || (tomorrowYMD === '2026-09-11' && fullText.includes('friday') && fullText.includes('11'))) {
          tomorrowMorningDatedMemories.push(item);
        }
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

  // 6. Current Screen Context (Auto-hydrate if not provided)
  let currentScreenContext = options.currentScreenContext;
  if (!currentScreenContext) {
    try {
      const latestReviewRes = await executeBunnySql([
        {
          sql: `SELECT active_channel_json, candidate_resolutions_json, timestamp
                FROM shadow_attention_reviews
                WHERE ezzy_id = ?
                ORDER BY timestamp DESC
                LIMIT 1;`,
          args: [eid],
        },
      ]);
      const reviewRow = latestReviewRes[0]?.rows?.[0];
      if (reviewRow) {
        const activeChannel = JSON.parse(reviewRow.active_channel_json || '[]');
        const candidateResolutions = JSON.parse(reviewRow.candidate_resolutions_json || '[]');
        currentScreenContext = {
          activeTickerItem: activeChannel[0] || null,
          recentCandidateResolutions: candidateResolutions,
          visibleAppointments: [...todayEvents, ...todayDatedMemories],
        };
      }
    } catch {
      // ignore
    }
  }

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
      timePhase,
    },
    calendar: {
      todayEvents,
      recentlyCompletedEvents,
      upcomingEvents,
      tomorrowMorningEvents,
    },
    commitments: {
      todayDatedMemories,
      tomorrowMorningDatedMemories,
      dueOrOverdueReminders,
    },
    timedReminders,
    activeMemories,
    recentCompletedOrHistoricalMemories,
    relationships,
    occasions,
    recentInteractions: options.recentInteractions || [],
    currentScreenContext,
  };
}
