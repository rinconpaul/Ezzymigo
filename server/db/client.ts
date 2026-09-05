import { SqlStatement, SqlResultBlock } from '../types';

// Bunny Database URL & Auth resolver
export function getBunnyTargetUrl(): string | null {
  const rawUrl = process.env.BUNNY_DATABASE_URL?.trim();
  if (!rawUrl) return null;

  let urlStr = rawUrl;
  if (urlStr.startsWith('libsql://')) {
    urlStr = urlStr.replace('libsql://', 'https://');
  } else if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
    urlStr = `https://${urlStr}`;
  }

  const urlObj = new URL(urlStr);
  if (!urlObj.pathname.includes('/v2/pipeline')) {
    urlObj.pathname = '/v2/pipeline';
  }
  return urlObj.toString();
}

// Helper to detect if running under an automated test runner / script
export function isTestContext(): boolean {
  if (process.env.NODE_ENV === 'test' || process.env.IS_TEST_RUN === 'true') {
    return true;
  }
  const argvStr = process.argv.join(' ');
  return argvStr.includes('/scripts/') || argvStr.includes('test');
}

// Production Data Guard: Blocks test code from mutating live production / default_user / ezzy_default data
export function assertProductionWriteAllowed(statements: Array<SqlStatement>) {
  if (!isTestContext()) return;

  for (const st of statements) {
    const sqlLower = (st.sql || '').toLowerCase().trim();
    // Allow idempotent bootstrap inserts (e.g. INSERT OR IGNORE into ezzy_instances during init)
    if (/^insert\s+or\s+ignore\b/i.test(sqlLower)) continue;

    const isWrite = /^\s*(insert|update|delete|replace|drop|alter|truncate)\b/i.test(sqlLower);
    if (!isWrite) continue;

    // Check if targeting protected default_user or ezzy_default record
    const hasProtectedTenantInSql = /\b(default_user|ezzy_default)\b/i.test(st.sql);
    const hasProtectedTenantInArgs =
      Array.isArray(st.args) &&
      st.args.some((a) => typeof a === 'string' && (a.trim() === 'default_user' || a.trim() === 'ezzy_default'));

    if (hasProtectedTenantInSql || hasProtectedTenantInArgs) {
      const err = `[PRODUCTION DATA GUARD VIOLATION] Automated test code attempted to execute write operation mutating protected record ('default_user' or 'ezzy_default')! SQL: "${st.sql}". Tests must use isolated test IDs (e.g. 'test_...').`;
      console.error(`❌ ${err}`);
      throw new Error(err);
    }
  }
}

// Execute SQL statements on Bunny Database (libSQL pipeline)
export async function executeBunnySql(statements: Array<SqlStatement>): Promise<SqlResultBlock[]> {
  assertProductionWriteAllowed(statements);

  const targetUrl = getBunnyTargetUrl();
  const token = process.env.BUNNY_DATABASE_TOKEN?.trim() || '';

  if (!targetUrl || !token) {
    console.warn('[Bunny DB] BUNNY_DATABASE_URL or BUNNY_DATABASE_TOKEN is not configured.');
    return [];
  }

  const requests = statements.map(st => {
    const stmtObj: any = { sql: st.sql };
    if (st.args && st.args.length > 0) {
      stmtObj.args = st.args.map(arg => {
        if (arg === null || arg === undefined) return { type: 'null' };
        if (typeof arg === 'number') return { type: 'integer', value: String(arg) };
        if (typeof arg === 'boolean') return { type: 'integer', value: arg ? '1' : '0' };
        return { type: 'text', value: String(arg) };
      });
    }
    return { type: 'execute', stmt: stmtObj };
  });

  const payload = {
    requests: [...requests, { type: 'close' }]
  };

  const jsonBody = JSON.stringify(payload);
  const bodyBuffer = Buffer.from(jsonBody, 'utf-8');

  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(bodyBuffer.byteLength),
        },
        body: bodyBuffer,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Bunny DB request failed (${response.status}): ${errText}`);
      }

      const data: any = await response.json();
      const results: SqlResultBlock[] = [];

      if (data && data.results) {
        for (const res of data.results) {
          if (res.type === 'ok' && res.response && res.response.result) {
            const qr = res.response.result;
            const cols = (qr.cols || []).map((c: any) => c.name);
            const rows = (qr.rows || []).map((row: any[]) => {
              const obj: Record<string, any> = {};
              cols.forEach((colName: string, i: number) => {
                const cell = row[i];
                obj[colName] = cell ? cell.value : null;
              });
              return obj;
            });
            results.push({ rows, affected_rows: qr.affected_row_count });
          } else if (res.type === 'error') {
            throw new Error(`Bunny DB SQL Error: ${res.error?.message || 'Unknown error'}`);
          }
        }
      }

      return results;
    } catch (err: any) {
      lastError = err;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 200));
      }
    }
  }

  throw lastError;
}
