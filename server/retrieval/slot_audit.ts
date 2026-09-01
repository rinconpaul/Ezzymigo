import { segmentUnicodeWords, isSubstantiveAnchorToken } from './unicode_segmenter';

export interface SlotAuditResult {
  isContradicted: boolean;
  contradictionReason?: string;
  slotCategory?: string;
  querySlotValue?: string;
  candidateSlotValue?: string;
}

// 1. Day of Week Slots (multilingual) - Only unambiguous, explicit day terms (no short 3-letter abbreviations that collide with common words like French 'mon')
const DAY_OF_WEEK_GROUPS: Array<{ name: string; tokens: Set<string> }> = [
  { name: 'monday', tokens: new Set(['monday', 'lundi', 'lunes', 'montag', 'lunedì', 'lunedi', '月曜', '月曜日', '周一', '星期一', 'الاثنين', 'الإثنين']) },
  { name: 'tuesday', tokens: new Set(['tuesday', 'mardi', 'martes', 'dienstag', 'martedì', 'martedi', '火曜', '火曜日', '周二', '星期二', 'الثلاثاء']) },
  { name: 'wednesday', tokens: new Set(['wednesday', 'mercredi', 'miércoles', 'miercoles', 'mittwoch', 'mercoledì', 'mercoledi', '水曜', '水曜日', '周三', '星期三', 'الأربعاء', 'الاربعاء']) },
  { name: 'thursday', tokens: new Set(['thursday', 'jeudi', 'jueves', 'donnerstag', 'giovedì', 'giovedi', '木曜', '木曜日', '周四', '星期四', 'الخميس']) },
  { name: 'friday', tokens: new Set(['friday', 'vendredi', 'viernes', 'freitag', 'venerdì', 'venerdi', '金曜', '金曜日', '周五', '星期五', 'الجمعة']) },
  { name: 'saturday', tokens: new Set(['saturday', 'samedi', 'sábado', 'sabado', 'samstag', 'sabato', '土曜', '土曜日', '周六', '星期六', 'السبت']) },
  { name: 'sunday', tokens: new Set(['sunday', 'dimanche', 'domingo', 'sonntag', 'domenica', '日曜', '日曜日', '周日', '星期日', '星期天', 'الأحد', 'الاحد']) },
];

// 2. Transport Mode Slots (multilingual)
const TRANSPORT_MODE_GROUPS: Array<{ name: string; tokens: Set<string> }> = [
  { name: 'flight_air', tokens: new Set(['flight', 'flights', 'plane', 'airplane', 'air', 'avión', 'avion', 'aviones', 'vol', 'aereo', 'aerei', 'flug', 'flüge', 'fluege', 'flugzeug', '飞机', '机票', '航班', '飛行機', '航空券', 'طائرة', 'طيران']) },
  { name: 'train_rail', tokens: new Set(['train', 'trains', 'rail', 'tren', 'trenes', 'treno', 'treni', 'zug', 'züge', 'zuege', 'bahn', '火车', '车票', '高铁', '列车', '電車', '新幹線', '切符', 'قطار']) },
  { name: 'bus', tokens: new Set(['bus', 'autobús', 'autobus', 'pullman', 'coach', 'buses', '巴士', '公交', '大巴', 'バス', 'حافلة', 'باص']) },
];

// 3. Common Entity / Location Context anchors that tend to cause false semantic attraction
const COMMON_CONTEXT_ENTITIES = new Set<string>([
  'bunnings', 'store', 'shop', 'supermarket', 'hardware', 'market',
  'magasin', 'bricolage', 'supermarché', 'boutique',
  'tienda', 'supermercado', 'ferretería', 'ferreteria',
  'baumarkt', 'supermarkt', 'geschäft', 'geschaeft',
  'negozio', 'supermercato',
  'ホームセンター', 'スーパー', '店', '店舗',
  '建材超市', '超市', '商场', '商店',
  'متجر', 'سوبرماركت', 'دكان', 'محل'
]);

/**
 * Checks whether a candidate memory contradicts a substantive constraint in the query.
 * Treats substantive slot contradiction as evidence AGAINST candidate admissibility.
 */
export function auditCandidateSlots(
  query: string,
  candidateText: string
): SlotAuditResult {
  if (!query || !candidateText) return { isContradicted: false };

  const queryTokens = segmentUnicodeWords(query);
  const candTokens = segmentUnicodeWords(candidateText);
  const queryTokenSet = new Set(queryTokens);
  const candTokenSet = new Set(candTokens);

  // --- Check 1: Day of Week Contradiction ---
  let queryDay: string | null = null;
  for (const group of DAY_OF_WEEK_GROUPS) {
    for (const tok of group.tokens) {
      if (queryTokenSet.has(tok) || (tok.length >= 2 && queryTokens.some(t => t === tok || (t.length > 2 && t.includes(tok))))) {
        queryDay = group.name;
        break;
      }
    }
    if (queryDay) break;
  }

  if (queryDay) {
    let candDay: string | null = null;
    for (const group of DAY_OF_WEEK_GROUPS) {
      for (const tok of group.tokens) {
        if (candTokenSet.has(tok) || (tok.length >= 2 && candTokens.some(t => t === tok || (t.length > 2 && t.includes(tok))))) {
          candDay = group.name;
          break;
        }
      }
      if (candDay) break;
    }

    if (candDay && candDay !== queryDay) {
      return {
        isContradicted: true,
        contradictionReason: `DAY_OF_WEEK_MISMATCH: Query specified ${queryDay}, candidate contains conflicting ${candDay}`,
        slotCategory: 'day_of_week',
        querySlotValue: queryDay,
        candidateSlotValue: candDay,
      };
    }
  }

  // --- Check 2: Transport Mode Contradiction ---
  let queryTransport: string | null = null;
  for (const group of TRANSPORT_MODE_GROUPS) {
    for (const tok of group.tokens) {
      if (queryTokenSet.has(tok) || query.toLowerCase().includes(tok)) {
        queryTransport = group.name;
        break;
      }
    }
    if (queryTransport) break;
  }

  if (queryTransport) {
    let candTransport: string | null = null;
    for (const group of TRANSPORT_MODE_GROUPS) {
      for (const tok of group.tokens) {
        if (candTokenSet.has(tok) || candidateText.toLowerCase().includes(tok)) {
          candTransport = group.name;
          break;
        }
      }
      if (candTransport) break;
    }

    if (candTransport && candTransport !== queryTransport) {
      return {
        isContradicted: true,
        contradictionReason: `TRANSPORT_MODE_MISMATCH: Query specified ${queryTransport}, candidate contains conflicting ${candTransport}`,
        slotCategory: 'transport_mode',
        querySlotValue: queryTransport,
        candidateSlotValue: candTransport,
      };
    }
  }

  // --- Check 3: Near-miss Action/Item Verification Contradiction ---
  const querySubstantive = queryTokens.filter(isSubstantiveAnchorToken);
  const candSubstantive = candTokens.filter(isSubstantiveAnchorToken);

  const queryItemSlots = querySubstantive.filter(tok => !COMMON_CONTEXT_ENTITIES.has(tok));
  const candItemSlots = candSubstantive.filter(tok => !COMMON_CONTEXT_ENTITIES.has(tok));

  if (queryItemSlots.length > 0 && candItemSlots.length > 0) {
    const hasAnyItemOverlap = queryItemSlots.some(qTok => candTokenSet.has(qTok) || candidateText.toLowerCase().includes(qTok));
    const hasContextEntity = queryTokens.some(qTok => COMMON_CONTEXT_ENTITIES.has(qTok) && (candTokenSet.has(qTok) || candidateText.toLowerCase().includes(qTok)));

    if (hasContextEntity && !hasAnyItemOverlap) {
      return {
        isContradicted: true,
        contradictionReason: `ITEM_SLOT_CONTRADICTION: Query asked for item slots [${queryItemSlots.join(', ')}] at shared context entity, but candidate contains alternative items [${candItemSlots.join(', ')}]`,
        slotCategory: 'item_slot',
        querySlotValue: queryItemSlots.join(','),
        candidateSlotValue: candItemSlots.join(','),
      };
    }
  }

  return { isContradicted: false };
}
