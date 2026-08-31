import { executeBunnySql } from './client';
import { parseStoredTopicsAndMetadata } from './memories';

export interface SearchDoc {
  memory_id: string;
  content: string;
  original_text: string;
  people: string;
  places: string;
  topics: string;
  retrieval_cues: string;
  items: string;
  subject: string;
  subject_normalized: string | null;
  status: string;
  createdAt: string;
}

// Deterministic normalization of subject extracted from memory topics/metadata
export function normalizeSubject(subject: string | null | undefined): string | null {
  if (!subject || typeof subject !== 'string') return null;
  const trimmed = subject.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return null;
  // Lowercase, remove straight & curly apostrophes, collapse multiple spaces
  return trimmed.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ');
}

// Extract clean, flattened searchable values from database row or in-memory item
export function extractSearchDoc(input: any): SearchDoc {
  const memoryId = input.id || input.memory_id;
  const originalText = input.originalText || input.original_text || '';
  const createdAt = input.createdAt || input.created_at || new Date().toISOString();

  let content = '';
  let status = 'active';
  let kind = 'fact';
  let peopleArr: string[] = [];
  let placesArr: string[] = [];
  let topicsArr: string[] = [];
  let contextsArr: string[] = [];
  let cuesArr: string[] = [];
  let itemsArr: string[] = [];
  let rawSubject: string | null = null;

  if (input.interpretation) {
    // In-memory memory item from insertMemories / updateMemoryInDb
    content = input.interpretation.content || originalText;
    status = input.interpretation.status || (input.isDone ? 'done' : 'active');
    kind = input.interpretation.kind || 'fact';
    peopleArr = Array.isArray(input.interpretation.people) ? input.interpretation.people : [];
    placesArr = Array.isArray(input.interpretation.places) ? input.interpretation.places : [];
    topicsArr = Array.isArray(input.interpretation.topics) ? input.interpretation.topics : [];
    contextsArr = Array.isArray(input.interpretation.contexts) ? input.interpretation.contexts : [];
    cuesArr = Array.isArray(input.interpretation.retrieval_cues) ? input.interpretation.retrieval_cues : [];
    itemsArr = Array.isArray(input.interpretation.items) ? input.interpretation.items : [];
    rawSubject = typeof input.interpretation.subject === 'string' && input.interpretation.subject.trim()
      ? input.interpretation.subject.trim()
      : null;
  } else {
    // Raw database row format
    content = input.content || originalText;
    status = input.status || (Number(input.isDone) ? 'done' : 'active');
    kind = input.kind || 'fact';

    if (typeof input.people === 'string') {
      try {
        const p = JSON.parse(input.people);
        if (Array.isArray(p)) peopleArr = p;
      } catch {}
    } else if (Array.isArray(input.people)) {
      peopleArr = input.people;
    }

    if (typeof input.places === 'string') {
      try {
        const p = JSON.parse(input.places);
        if (Array.isArray(p)) placesArr = p;
      } catch {}
    } else if (Array.isArray(input.places)) {
      placesArr = input.places;
    }

    const meta = parseStoredTopicsAndMetadata(input.topics, kind);
    topicsArr = meta.topics || [];
    contextsArr = meta.contexts || [];
    cuesArr = meta.retrieval_cues || [];
    itemsArr = meta.items || [];
    rawSubject = meta.subject || null;
  }

  // Clean flattened searchable strings (distinct, clean values)
  const combinedTopics = Array.from(new Set([...topicsArr, ...contextsArr])).filter(Boolean).join(' ');
  const peopleStr = peopleArr.filter(Boolean).join(' ');
  const placesStr = placesArr.filter(Boolean).join(' ');
  const cuesStr = cuesArr.filter(Boolean).join(' ');
  const itemsStr = itemsArr.filter(Boolean).join(' ');
  const cleanSubject = (rawSubject && rawSubject.toLowerCase() !== 'null' && rawSubject.toLowerCase() !== 'undefined') ? rawSubject : '';
  const normSubject = normalizeSubject(rawSubject);

  return {
    memory_id: memoryId,
    content: content || '',
    original_text: originalText || '',
    people: peopleStr,
    places: placesStr,
    topics: combinedTopics,
    retrieval_cues: cuesStr,
    items: itemsStr,
    subject: cleanSubject,
    subject_normalized: normSubject,
    status,
    createdAt
  };
}

// Generate atomic SQL statements to synchronize memories_fts and memory_search_projection
export function getSearchSyncStatements(doc: SearchDoc): Array<{ sql: string; args: any[] }> {
  return [
    {
      sql: 'DELETE FROM memories_fts WHERE memory_id = ?;',
      args: [doc.memory_id]
    },
    {
      sql: `INSERT INTO memories_fts (memory_id, content, original_text, people, places, topics, retrieval_cues, items, subject)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        doc.memory_id,
        doc.content,
        doc.original_text,
        doc.people,
        doc.places,
        doc.topics,
        doc.retrieval_cues,
        doc.items,
        doc.subject
      ]
    },
    {
      sql: 'DELETE FROM memory_search_projection WHERE memory_id = ?;',
      args: [doc.memory_id]
    },
    {
      sql: `INSERT INTO memory_search_projection (memory_id, subject, subject_normalized, status, createdAt)
            VALUES (?, ?, ?, ?, ?);`,
      args: [
        doc.memory_id,
        doc.subject || null,
        doc.subject_normalized || null,
        doc.status,
        doc.createdAt
      ]
    }
  ];
}

// Generate atomic SQL statements to delete from memories_fts and memory_search_projection
export function getSearchDeleteStatements(memoryId: string): Array<{ sql: string; args: any[] }> {
  return [
    {
      sql: 'DELETE FROM memories_fts WHERE memory_id = ?;',
      args: [memoryId]
    },
    {
      sql: 'DELETE FROM memory_search_projection WHERE memory_id = ?;',
      args: [memoryId]
    }
  ];
}

// Perform idempotent backfill from authoritative memories table into memories_fts & memory_search_projection
export async function backfillMemorySearch(options?: { force?: boolean }): Promise<{
  sourceCount: number;
  ftsCount: number;
  projectionCount: number;
}> {
  const memRes = await executeBunnySql([{
    sql: 'SELECT * FROM memories;'
  }]);
  const rows = memRes[0]?.rows || [];
  const sourceCount = rows.length;

  if (sourceCount === 0) {
    return { sourceCount: 0, ftsCount: 0, projectionCount: 0 };
  }

  const stmts: Array<{ sql: string; args: any[] }> = [];

  if (options?.force) {
    stmts.push({ sql: 'DELETE FROM memories_fts;', args: [] });
    stmts.push({ sql: 'DELETE FROM memory_search_projection;', args: [] });
  }

  for (const row of rows) {
    const doc = extractSearchDoc(row);
    if (!options?.force) {
      stmts.push(...getSearchSyncStatements(doc));
    } else {
      stmts.push(
        {
          sql: `INSERT INTO memories_fts (memory_id, content, original_text, people, places, topics, retrieval_cues, items, subject)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          args: [
            doc.memory_id,
            doc.content,
            doc.original_text,
            doc.people,
            doc.places,
            doc.topics,
            doc.retrieval_cues,
            doc.items,
            doc.subject
          ]
        },
        {
          sql: `INSERT INTO memory_search_projection (memory_id, subject, subject_normalized, status, createdAt)
                VALUES (?, ?, ?, ?, ?);`,
          args: [
            doc.memory_id,
            doc.subject || null,
            doc.subject_normalized || null,
            doc.status,
            doc.createdAt
          ]
        }
      );
    }
  }

  await executeBunnySql(stmts);

  const ftsRes = await executeBunnySql([{ sql: 'SELECT count(*) as count FROM memories_fts;' }]);
  const projRes = await executeBunnySql([{ sql: 'SELECT count(*) as count FROM memory_search_projection;' }]);

  const ftsCount = Number(ftsRes[0]?.rows?.[0]?.count || 0);
  const projectionCount = Number(projRes[0]?.rows?.[0]?.count || 0);

  return { sourceCount, ftsCount, projectionCount };
}
