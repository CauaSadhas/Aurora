const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const IS_VERCEL = Boolean(process.env.VERCEL);

// A Vercel encerra o HTTPS no proxy antes de encaminhar a requisição ao Express.
// Sem confiar nesse proxy, o Express enxerga a conexão como HTTP e o cookie
// seguro da sessão não é gravado, causando um ciclo entre /login e /dashboard.
if (IS_VERCEL) app.set('trust proxy', 1);
const HAS_TURSO = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
const CONFIG_ERROR = IS_VERCEL && !HAS_TURSO;

function normalizeRow(row) {
  if (!row) return row;
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return normalized;
}

class LocalDatabase {
  constructor(filePath) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.raw = new DatabaseSync(filePath);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }

  async exec(sql) {
    this.raw.exec(sql);
  }

  async run(sql, ...params) {
    const result = this.raw.prepare(sql).run(...params);
    return {
      lastInsertRowid: result.lastInsertRowid,
      rowsAffected: result.changes,
      changes: result.changes
    };
  }

  async get(sql, ...params) {
    return normalizeRow(this.raw.prepare(sql).get(...params));
  }

  async all(sql, ...params) {
    return this.raw.prepare(sql).all(...params).map(normalizeRow);
  }

  async batch(statements) {
    this.raw.exec('BEGIN');
    try {
      let rowsAffected = 0;
      let lastInsertRowid = null;
      for (const statement of statements) {
        const sql = typeof statement === 'string' ? statement : statement.sql;
        const args = typeof statement === 'string' ? [] : (statement.args || []);
        const result = this.raw.prepare(sql).run(...args);
        rowsAffected += Number(result.changes || 0);
        if (result.lastInsertRowid !== undefined && result.lastInsertRowid !== null) {
          lastInsertRowid = result.lastInsertRowid;
        }
      }
      this.raw.exec('COMMIT');
      return { rowsAffected, lastInsertRowid };
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

class TursoDatabase {
  constructor(url, authToken) {
    const { connect } = require('@tursodatabase/serverless');
    this.raw = connect({ url, authToken });
  }

  async exec(sql) {
    return this.raw.exec(sql);
  }

  async run(sql, ...params) {
    return this.raw.run(sql, ...params);
  }

  async get(sql, ...params) {
    return normalizeRow(await this.raw.get(sql, ...params));
  }

  async all(sql, ...params) {
    const rows = await this.raw.all(sql, ...params);
    return rows.map(normalizeRow);
  }

  async batch(statements) {
    return this.raw.batch(statements, 'immediate');
  }
}

let db = null;
let databaseMode = 'not-configured';

if (HAS_TURSO) {
  db = new TursoDatabase(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN);
  databaseMode = 'turso-cloud';
} else if (!IS_VERCEL) {
  const dataDir = path.join(__dirname, 'data');
  db = new LocalDatabase(path.join(dataDir, 'gestor.db'));
  databaseMode = 'sqlite-local';
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.on('finish', () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 1500) console.warn(`[Aurora] Requisição lenta: ${req.method} ${req.path} — ${elapsed}ms`);
  });
  next();
});
app.use(express.urlencoded({ extended: true, limit: '250kb' }));
app.use(express.json({ limit: '250kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: IS_VERCEL ? '1h' : 0
}));

const sessionSecret = process.env.SESSION_SECRET || process.env.TURSO_AUTH_TOKEN || 'aurora-local-development-secret';
app.use(cookieSession({
  name: 'aurora_session',
  keys: [sessionSecret],
  maxAge: 1000 * 60 * 60 * 24 * 14,
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_VERCEL || process.env.NODE_ENV === 'production'
}));

app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  res.locals.flash = req.session?.flash || null;
  if (req.session?.flash) delete req.session.flash;
  next();
});

async function initDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS board_columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT '#64748b',
      FOREIGN KEY(board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      board_id INTEGER NOT NULL,
      column_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      client TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      due_date TEXT,
      estimated_minutes INTEGER DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(board_id) REFERENCES boards(id) ON DELETE CASCADE,
      FOREIGN KEY(column_id) REFERENCES board_columns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      required INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recurring_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      board_id INTEGER NOT NULL,
      column_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      client TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      day_of_month INTEGER NOT NULL DEFAULT 1,
      create_days_before INTEGER NOT NULL DEFAULT 5,
      checklist_json TEXT DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      last_generated_month TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(board_id) REFERENCES boards(id) ON DELETE CASCADE,
      FOREIGN KEY(column_id) REFERENCES board_columns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'disconnected',
      account_label TEXT DEFAULT '',
      settings_json TEXT DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, provider),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_board_user_position ON tasks(board_id,user_id,column_id,position,id);
    CREATE INDEX IF NOT EXISTS idx_tasks_user_due ON tasks(user_id,due_date,completed_at);
    CREATE INDEX IF NOT EXISTS idx_columns_board_position ON board_columns(board_id,position,id);
    CREATE INDEX IF NOT EXISTS idx_checklist_task_position ON checklist_items(task_id,position,id);
    CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_id);
    CREATE INDEX IF NOT EXISTS idx_time_entries_task_running ON time_entries(task_id,ended_at,id);
    CREATE INDEX IF NOT EXISTS idx_time_entries_user_day ON time_entries(user_id,started_at,ended_at);
    CREATE INDEX IF NOT EXISTS idx_recurring_user_active ON recurring_tasks(user_id,active,last_generated_month);
  `);
}

async function createDefaultWorkspace(userId, withDemoTasks = false) {
  const boardResult = await db.run(
    'INSERT INTO boards (user_id,name,description) VALUES (?,?,?)',
    userId,
    'Meu trabalho',
    'Organize tarefas, clientes e prazos em um só lugar.'
  );
  const boardId = Number(boardResult.lastInsertRowid);
  const columnDefinitions = [
    ['A fazer', 0, '#f59e0b'],
    ['Em andamento', 1, '#3b82f6'],
    ['Aguardando', 2, '#8b5cf6'],
    ['Concluído', 3, '#22c55e']
  ];
  await db.batch(columnDefinitions.map(([name, position, color]) => ({
    sql: 'INSERT INTO board_columns (board_id,name,position,color) VALUES (?,?,?,?)',
    args: [boardId, name, position, color]
  })));

  if (withDemoTasks) {
    const columnRows = await db.all(
      'SELECT id FROM board_columns WHERE board_id=? ORDER BY position,id',
      boardId
    );
    const columns = columnRows.map((row) => Number(row.id));
    const today = new Date();
    const iso = (offset) => {
      const date = new Date(today);
      date.setDate(date.getDate() + offset);
      return date.toISOString().slice(0, 10);
    };

    const firstTask = await db.run(
      `INSERT INTO tasks
       (user_id,board_id,column_id,title,description,client,priority,due_date,estimated_minutes,position)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      userId,
      boardId,
      columns[0],
      'Conferir documentos do cliente',
      'Validar documentos recebidos e registrar pendências.',
      'Cliente Exemplo',
      'high',
      iso(1),
      60,
      0
    );

    const taskId = Number(firstTask.lastInsertRowid);
    await db.batch([
      {
        sql: `INSERT INTO tasks
          (user_id,board_id,column_id,title,description,client,priority,due_date,estimated_minutes,position)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [userId, boardId, columns[1], 'Preparar relatório mensal', 'Consolidar informações e revisar antes do envio.', 'Empresa Modelo', 'normal', iso(3), 120, 0]
      },
      {
        sql: `INSERT INTO tasks
          (user_id,board_id,column_id,title,description,client,priority,due_date,estimated_minutes,position)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [userId, boardId, columns[2], 'Aguardar retorno sobre notas fiscais', 'Cliente foi avisado e precisa enviar os arquivos faltantes.', 'João da Silva', 'urgent', iso(-1), 30, 0]
      },
      { sql: 'INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)', args: [taskId, 'Verificar competência dos documentos', 1, 0] },
      { sql: 'INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)', args: [taskId, 'Conferir valores e CNPJ', 1, 1] },
      { sql: 'INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)', args: [taskId, 'Registrar pendências', 0, 2] }
    ]);
  }

  return boardId;
}

async function seedDemo() {
  const existing = await db.get('SELECT id FROM users WHERE email = ?', 'demo@gestor.local');
  if (existing) return;

  try {
    const result = await db.run(
      'INSERT INTO users (name,email,password_hash) VALUES (?,?,?)',
      'Conta Demonstração',
      'demo@gestor.local',
      await bcrypt.hash('123456', 11)
    );
    await createDefaultWorkspace(Number(result.lastInsertRowid), true);
  } catch (error) {
    if (!String(error.message || '').toLowerCase().includes('unique')) throw error;
  }
}

const SCHEMA_VERSION = '8';

async function ensureDatabaseReady() {
  try {
    const version = await db.get('SELECT value FROM app_meta WHERE key=?', 'schema_version');
    if (String(version?.value || '') === SCHEMA_VERSION) return;
  } catch (_) {
    // Primeira implantação ou banco criado por uma versão anterior.
  }

  await initDatabase();
  await seedDemo();
  await db.run(
    `INSERT INTO app_meta (key,value,updated_at)
     VALUES ('schema_version',?,CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`,
    SCHEMA_VERSION
  );
}

let readyPromise = Promise.resolve();
if (db) readyPromise = ensureDatabaseReady();

app.use(async (req, res, next) => {
  if (CONFIG_ERROR) {
    if (req.path === '/health') {
      return res.status(503).json({
        ok: false,
        database: 'not-configured',
        missing: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']
      });
    }
    return res.status(503).render('setup', {
      title: 'Configurar banco de dados',
      missing: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']
    });
  }

  try {
    await readyPromise;
    next();
  } catch (error) {
    next(error);
  }
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

const recurringGenerationCache = new Map();
const RECURRING_CHECK_TTL_MS = 1000 * 60 * 30;

async function generateRecurringForUser(userId) {
  const templates = await db.all('SELECT * FROM recurring_tasks WHERE user_id = ? AND active = 1', userId);
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);

  for (const item of templates) {
    if (item.last_generated_month === currentMonth) continue;

    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const due = new Date(now.getFullYear(), now.getMonth(), Math.min(Number(item.day_of_month), lastDay));
    const creationDate = new Date(due);
    creationDate.setDate(creationDate.getDate() - Number(item.create_days_before));
    if (now < creationDate) continue;

    const dueIso = due.toISOString().slice(0, 10);
    const title = `${item.title} — ${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

    const result = await db.run(
      `INSERT INTO tasks
       (user_id,board_id,column_id,title,description,client,priority,due_date,position)
       VALUES (?,?,?,?,?,?,?,?,0)`,
      userId,
      item.board_id,
      item.column_id,
      title,
      item.description,
      item.client,
      item.priority,
      dueIso
    );

    const taskId = Number(result.lastInsertRowid);
    let checklist = [];
    try {
      checklist = JSON.parse(item.checklist_json || '[]');
    } catch (_) {
      checklist = [];
    }

    const statements = checklist.map((text, index) => ({
      sql: 'INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)',
      args: [taskId, String(text), 1, index]
    }));
    statements.push({
      sql: 'UPDATE recurring_tasks SET last_generated_month = ? WHERE id = ?',
      args: [currentMonth, item.id]
    });
    await db.batch(statements);
  }
}

async function maybeGenerateRecurringForUser(userId, force = false) {
  const month = new Date().toISOString().slice(0, 7);
  const key = `${userId}:${month}`;
  const lastCheck = recurringGenerationCache.get(key) || 0;
  if (!force && Date.now() - lastCheck < RECURRING_CHECK_TTL_MS) return;

  recurringGenerationCache.set(key, Date.now());
  try {
    await generateRecurringForUser(userId);
  } catch (error) {
    recurringGenerationCache.delete(key);
    throw error;
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function hydrateTask(task) {
  if (!task) return null;
  const numberKeys = [
    'id', 'user_id', 'board_id', 'column_id', 'estimated_minutes', 'position',
    'checklistDone', 'checklistTotal', 'totalSeconds', 'runningId'
  ];
  const normalized = { ...task };
  for (const key of numberKeys) normalized[key] = Number(normalized[key] || 0);
  normalized.runningTimer = normalized.runningId
    ? { id: normalized.runningId }
    : null;
  return normalized;
}

const TASK_JSON = `json_object(
  'id', id,
  'user_id', user_id,
  'board_id', board_id,
  'column_id', column_id,
  'title', title,
  'description', description,
  'client', client,
  'priority', priority,
  'due_date', due_date,
  'estimated_minutes', estimated_minutes,
  'position', position,
  'completed_at', completed_at,
  'created_at', created_at,
  'updated_at', updated_at,
  'column_name', column_name,
  'board_name', board_name,
  'checklistDone', checklist_done,
  'checklistTotal', checklist_total,
  'totalSeconds', total_seconds,
  'runningId', running_id
)`;

const TASK_ROWS_SQL = `
  SELECT
    t.*,
    bc.name AS column_name,
    b.name AS board_name,
    COALESCE((SELECT COUNT(*) FROM checklist_items ci WHERE ci.task_id=t.id),0) AS checklist_total,
    COALESCE((SELECT SUM(ci.done) FROM checklist_items ci WHERE ci.task_id=t.id),0) AS checklist_done,
    COALESCE((
      SELECT SUM(
        CASE
          WHEN te.ended_at IS NULL THEN MAX(0, CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s',te.started_at) AS INTEGER))
          ELSE COALESCE(te.duration_seconds,0)
        END
      )
      FROM time_entries te
      WHERE te.task_id=t.id
    ),0) AS total_seconds,
    COALESCE((
      SELECT te.id
      FROM time_entries te
      WHERE te.task_id=t.id AND te.ended_at IS NULL
      ORDER BY te.id DESC
      LIMIT 1
    ),0) AS running_id
  FROM tasks t
  JOIN board_columns bc ON bc.id=t.column_id
  JOIN boards b ON b.id=t.board_id
`;

async function loadDashboardSnapshot(userId, today) {
  const row = await db.get(`
    WITH task_rows AS (
      ${TASK_ROWS_SQL}
      WHERE t.user_id=?
      ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.id DESC
    )
    SELECT
      COALESCE((
        SELECT json_group_array(json_object(
          'id', id,
          'user_id', user_id,
          'name', name,
          'description', description,
          'created_at', created_at
        ))
        FROM (SELECT * FROM boards WHERE user_id=? ORDER BY id)
      ), '[]') AS boards_json,
      COALESCE((SELECT json_group_array(${TASK_JSON}) FROM task_rows), '[]') AS tasks_json,
      COALESCE((
        SELECT SUM(duration_seconds)
        FROM time_entries
        WHERE user_id=? AND ended_at IS NOT NULL AND substr(started_at,1,10)=?
      ),0) AS total_today
  `, userId, userId, userId, today);

  return {
    boards: parseJson(row?.boards_json, []).map((board) => ({ ...board, id: Number(board.id), user_id: Number(board.user_id) })),
    tasks: parseJson(row?.tasks_json, []).map(hydrateTask),
    totalSecondsToday: Number(row?.total_today || 0)
  };
}

async function loadBoardSnapshot(boardId, userId, selectedId = 0) {
  const row = await db.get(`
    WITH task_rows AS (
      ${TASK_ROWS_SQL}
      WHERE t.board_id=? AND t.user_id=?
      ORDER BY t.position, t.id DESC
    )
    SELECT
      (
        SELECT json_object(
          'id', id,
          'user_id', user_id,
          'name', name,
          'description', description,
          'created_at', created_at
        )
        FROM boards
        WHERE id=? AND user_id=?
      ) AS board_json,
      COALESCE((
        SELECT json_group_array(json_object(
          'id', id,
          'board_id', board_id,
          'name', name,
          'position', position,
          'color', color
        ))
        FROM (SELECT * FROM board_columns WHERE board_id=? ORDER BY position,id)
      ), '[]') AS columns_json,
      COALESCE((SELECT json_group_array(${TASK_JSON}) FROM task_rows), '[]') AS tasks_json,
      (SELECT ${TASK_JSON} FROM task_rows WHERE id=?) AS selected_json,
      COALESCE((
        SELECT json_group_array(json_object(
          'id', id,
          'task_id', task_id,
          'text', text,
          'done', done,
          'required', required,
          'position', position
        ))
        FROM (
          SELECT ci.*
          FROM checklist_items ci
          JOIN tasks t ON t.id=ci.task_id
          WHERE ci.task_id=? AND t.user_id=? AND t.board_id=?
          ORDER BY ci.position,ci.id
        )
      ), '[]') AS checklist_json
  `, boardId, userId, boardId, userId, boardId, selectedId, selectedId, userId, boardId);

  const board = parseJson(row?.board_json, null);
  if (!board) return null;

  const tasks = parseJson(row?.tasks_json, []).map(hydrateTask);
  const selectedTask = hydrateTask(parseJson(row?.selected_json, null));
  if (selectedTask) {
    selectedTask.checklist = parseJson(row?.checklist_json, []).map((item) => ({
      ...item,
      id: Number(item.id),
      task_id: Number(item.task_id),
      done: Number(item.done),
      required: Number(item.required),
      position: Number(item.position)
    }));
  }

  return {
    board: { ...board, id: Number(board.id), user_id: Number(board.user_id) },
    columns: parseJson(row?.columns_json, []).map((column) => ({
      ...column,
      id: Number(column.id),
      board_id: Number(column.board_id),
      position: Number(column.position)
    })),
    tasks,
    selectedTask
  };
}

async function loadObligationsSnapshot(userId) {
  const row = await db.get(`
    SELECT
      COALESCE((
        SELECT json_group_array(json_object(
          'id', r.id,
          'user_id', r.user_id,
          'board_id', r.board_id,
          'column_id', r.column_id,
          'title', r.title,
          'description', r.description,
          'client', r.client,
          'priority', r.priority,
          'day_of_month', r.day_of_month,
          'create_days_before', r.create_days_before,
          'checklist_json', r.checklist_json,
          'active', r.active,
          'last_generated_month', r.last_generated_month,
          'created_at', r.created_at,
          'board_name', b.name,
          'column_name', bc.name
        ))
        FROM recurring_tasks r
        JOIN boards b ON b.id=r.board_id
        JOIN board_columns bc ON bc.id=r.column_id
        WHERE r.user_id=?
        ORDER BY r.day_of_month
      ), '[]') AS templates_json,
      COALESCE((
        SELECT json_group_array(json_object(
          'id', id,
          'user_id', user_id,
          'name', name,
          'description', description,
          'created_at', created_at
        ))
        FROM (SELECT * FROM boards WHERE user_id=? ORDER BY name)
      ), '[]') AS boards_json,
      COALESCE((
        SELECT json_group_array(json_object(
          'id', bc.id,
          'board_id', bc.board_id,
          'name', bc.name,
          'position', bc.position,
          'color', bc.color
        ))
        FROM board_columns bc
        JOIN boards b ON b.id=bc.board_id
        WHERE b.user_id=?
        ORDER BY bc.board_id,bc.position
      ), '[]') AS columns_json
  `, userId, userId, userId);

  return {
    templates: parseJson(row?.templates_json, []).map((item) => ({
      ...item,
      id: Number(item.id),
      user_id: Number(item.user_id),
      board_id: Number(item.board_id),
      column_id: Number(item.column_id),
      day_of_month: Number(item.day_of_month),
      create_days_before: Number(item.create_days_before),
      active: Number(item.active)
    })),
    boards: parseJson(row?.boards_json, []).map((board) => ({ ...board, id: Number(board.id), user_id: Number(board.user_id) })),
    columns: parseJson(row?.columns_json, []).map((column) => ({
      ...column,
      id: Number(column.id),
      board_id: Number(column.board_id),
      position: Number(column.position)
    }))
  };
}

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  return next();
}

app.get('/', (req, res) => res.redirect(req.session?.user ? '/dashboard' : '/login'));

app.get('/login', (req, res) => res.render('login', { title: 'Entrar' }));

app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    setFlash(req, 'error', 'E-mail ou senha incorretos.');
    return res.redirect('/login');
  }

  req.session.user = { id: Number(user.id), name: user.name, email: user.email };
  return res.redirect('/dashboard');
});

app.get('/register', (req, res) => res.render('register', { title: 'Criar conta' }));

app.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (name.length < 2 || !email.includes('@') || password.length < 6) {
    setFlash(req, 'error', 'Preencha nome, e-mail válido e senha com pelo menos 6 caracteres.');
    return res.redirect('/register');
  }

  try {
    const result = await db.run(
      'INSERT INTO users (name,email,password_hash) VALUES (?,?,?)',
      name,
      email,
      await bcrypt.hash(password, 11)
    );
    const userId = Number(result.lastInsertRowid);
    await createDefaultWorkspace(userId, false);
    req.session.user = { id: userId, name, email };
    return res.redirect('/dashboard');
  } catch (error) {
    setFlash(req, 'error', 'Este e-mail já está cadastrado.');
    return res.redirect('/register');
  }
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  await maybeGenerateRecurringForUser(userId);

  const today = new Date().toISOString().slice(0, 10);
  const snapshot = await loadDashboardSnapshot(userId, today);
  const { boards, tasks, totalSecondsToday } = snapshot;
  const todayTasks = tasks.filter((task) => task.due_date === today && !task.completed_at);
  const overdue = tasks.filter((task) => task.due_date && task.due_date < today && !task.completed_at);
  const running = tasks.filter((task) => task.runningTimer);
  const completed = tasks.filter((task) => task.completed_at);

  res.render('dashboard', {
    title: 'Início',
    boards,
    tasks,
    todayTasks,
    overdue,
    running,
    completed,
    totalSecondsToday
  });
});

app.post('/boards', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/dashboard');

  const result = await db.run(
    'INSERT INTO boards (user_id,name,description) VALUES (?,?,?)',
    Number(req.session.user.id),
    name,
    String(req.body.description || '')
  );
  const boardId = Number(result.lastInsertRowid);
  const defaults = [
    ['A fazer', '#f59e0b'],
    ['Em andamento', '#3b82f6'],
    ['Aguardando', '#8b5cf6'],
    ['Concluído', '#22c55e']
  ];

  await db.batch(defaults.map(([columnName, color], index) => ({
    sql: 'INSERT INTO board_columns (board_id,name,position,color) VALUES (?,?,?,?)',
    args: [boardId, columnName, index, color]
  })));

  return res.redirect(`/boards/${boardId}`);
});

app.get('/boards/:id', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const boardId = Number(req.params.id);
  const selectedId = req.query.task ? Number(req.query.task) : 0;
  const snapshot = await loadBoardSnapshot(boardId, userId, selectedId);
  if (!snapshot) return res.status(404).send('Quadro não encontrado');

  const view = ['kanban', 'table', 'calendar', 'list'].includes(req.query.view) ? req.query.view : 'kanban';
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? String(req.query.month)
    : new Date().toISOString().slice(0, 7);

  return res.render('board', {
    title: snapshot.board.name,
    board: snapshot.board,
    columns: snapshot.columns,
    tasks: snapshot.tasks,
    view,
    selectedTask: snapshot.selectedTask,
    month
  });
});

app.post('/boards/:id/columns', requireAuth, async (req, res) => {
  const boardId = Number(req.params.id);
  const userId = Number(req.session.user.id);
  const inserted = await db.get(
    `INSERT INTO board_columns (board_id,name,position,color)
     SELECT b.id,?,COALESCE((SELECT MAX(position)+1 FROM board_columns WHERE board_id=b.id),0),'#64748b'
     FROM boards b
     WHERE b.id=? AND b.user_id=?
     RETURNING board_id`,
    String(req.body.name || 'Nova coluna').trim() || 'Nova coluna',
    boardId,
    userId
  );
  if (!inserted) return res.status(404).send('Quadro não encontrado');
  return res.redirect(`/boards/${boardId}`);
});

app.post('/tasks', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const boardId = Number(req.body.board_id);
  const columnId = Number(req.body.column_id);
  const inserted = await db.get(
    `INSERT INTO tasks
     (user_id,board_id,column_id,title,description,client,priority,due_date,estimated_minutes,position)
     SELECT ?,b.id,bc.id,?,?,?,?,?,?,0
     FROM boards b
     JOIN board_columns bc ON bc.board_id=b.id
     WHERE b.id=? AND b.user_id=? AND bc.id=?
     RETURNING id,board_id`,
    userId,
    String(req.body.title || 'Nova tarefa').trim() || 'Nova tarefa',
    String(req.body.description || ''),
    String(req.body.client || ''),
    String(req.body.priority || 'normal'),
    req.body.due_date || null,
    Number(req.body.estimated_minutes || 0),
    boardId,
    userId,
    columnId
  );
  if (!inserted) return res.status(400).send('Quadro ou coluna inválida');
  return res.redirect(`/boards/${Number(inserted.board_id)}?task=${Number(inserted.id)}`);
});

app.post('/tasks/:id/update', requireAuth, async (req, res) => {
  const taskId = Number(req.params.id);
  const updated = await db.get(
    `UPDATE tasks
     SET title=COALESCE(NULLIF(?,''),title),description=?,client=?,priority=?,due_date=?,estimated_minutes=?,updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND user_id=?
     RETURNING id,board_id`,
    String(req.body.title || '').trim(),
    String(req.body.description || ''),
    String(req.body.client || ''),
    String(req.body.priority || 'normal'),
    req.body.due_date || null,
    Number(req.body.estimated_minutes || 0),
    taskId,
    Number(req.session.user.id)
  );
  if (!updated) return res.status(404).send('Tarefa não encontrada');
  return res.redirect(`/boards/${Number(updated.board_id)}?task=${Number(updated.id)}`);
});

app.post('/tasks/:id/delete', requireAuth, async (req, res) => {
  const deleted = await db.get(
    'DELETE FROM tasks WHERE id=? AND user_id=? RETURNING board_id',
    Number(req.params.id),
    Number(req.session.user.id)
  );
  if (!deleted) return res.status(404).send('Tarefa não encontrada');
  return res.redirect(`/boards/${Number(deleted.board_id)}`);
});

app.post('/api/tasks/:id/move', requireAuth, async (req, res) => {
  const taskId = Number(req.params.id);
  const columnId = Number(req.body.column_id);
  const completedAt = new Date().toISOString();
  const updated = await db.get(
    `UPDATE tasks
     SET column_id=?,
         completed_at=CASE
           WHEN lower(COALESCE((SELECT name FROM board_columns WHERE id=?),'') ) LIKE '%conclu%'
             OR lower(COALESCE((SELECT name FROM board_columns WHERE id=?),'') ) LIKE '%finaliz%'
           THEN ?
           ELSE NULL
         END,
         updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND user_id=?
       AND EXISTS (
         SELECT 1 FROM board_columns bc
         WHERE bc.id=? AND bc.board_id=tasks.board_id
       )
     RETURNING id`,
    columnId,
    columnId,
    columnId,
    completedAt,
    taskId,
    Number(req.session.user.id),
    columnId
  );
  if (!updated) return res.status(400).json({ error: 'Tarefa ou coluna inválida' });
  return res.json({ ok: true });
});

app.post('/tasks/:id/checklist', requireAuth, async (req, res) => {
  const taskId = Number(req.params.id);
  const text = String(req.body.text || '').trim();
  if (!text) return res.redirect(req.get('referer') || '/dashboard');

  const inserted = await db.get(
    `INSERT INTO checklist_items (task_id,text,required,position)
     SELECT t.id,?,?,COALESCE((SELECT MAX(position)+1 FROM checklist_items WHERE task_id=t.id),0)
     FROM tasks t
     WHERE t.id=? AND t.user_id=?
     RETURNING task_id`,
    text,
    req.body.required ? 1 : 0,
    taskId,
    Number(req.session.user.id)
  );
  if (!inserted) return res.status(404).send('Tarefa não encontrada');
  return res.redirect(req.get('referer') || '/dashboard');
});

app.post('/checklist/:id/toggle', requireAuth, async (req, res) => {
  const updated = await db.get(
    `UPDATE checklist_items
     SET done=CASE done WHEN 1 THEN 0 ELSE 1 END
     WHERE id=? AND EXISTS (
       SELECT 1 FROM tasks t
       WHERE t.id=checklist_items.task_id AND t.user_id=?
     )
     RETURNING task_id`,
    Number(req.params.id),
    Number(req.session.user.id)
  );
  if (!updated) return res.status(404).send('Item não encontrado');
  return res.redirect(req.get('referer') || '/dashboard');
});

app.post('/tasks/:id/timer/start', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  await db.get(
    `INSERT INTO time_entries (task_id,user_id,started_at)
     SELECT t.id,?,?
     FROM tasks t
     WHERE t.id=? AND t.user_id=?
       AND NOT EXISTS (SELECT 1 FROM time_entries WHERE user_id=? AND ended_at IS NULL)
     RETURNING task_id`,
    userId,
    new Date().toISOString(),
    Number(req.params.id),
    userId,
    userId
  );
  return res.redirect(req.get('referer') || '/dashboard');
});

app.post('/tasks/:id/timer/stop', requireAuth, async (req, res) => {
  const end = new Date().toISOString();
  await db.get(
    `UPDATE time_entries
     SET ended_at=?,
         duration_seconds=MAX(1,CAST(strftime('%s',?) AS INTEGER)-CAST(strftime('%s',started_at) AS INTEGER))
     WHERE id=(
       SELECT te.id
       FROM time_entries te
       JOIN tasks t ON t.id=te.task_id
       WHERE t.id=? AND t.user_id=? AND te.user_id=? AND te.ended_at IS NULL
       ORDER BY te.id DESC
       LIMIT 1
     )
     RETURNING task_id`,
    end,
    end,
    Number(req.params.id),
    Number(req.session.user.id),
    Number(req.session.user.id)
  );
  return res.redirect(req.get('referer') || '/dashboard');
});

app.get('/obligations', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  await maybeGenerateRecurringForUser(userId);
  const snapshot = await loadObligationsSnapshot(userId);
  return res.render('obligations', {
    title: 'Obrigações mensais',
    templates: snapshot.templates,
    boards: snapshot.boards,
    columns: snapshot.columns
  });
});

app.post('/obligations', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const boardId = Number(req.body.board_id);
  const columnId = Number(req.body.column_id);
  const checklist = String(req.body.checklist || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  const inserted = await db.get(
    `INSERT INTO recurring_tasks
     (user_id,board_id,column_id,title,description,client,priority,day_of_month,create_days_before,checklist_json)
     SELECT ?,b.id,bc.id,?,?,?,?,?,?,?
     FROM boards b
     JOIN board_columns bc ON bc.board_id=b.id
     WHERE b.id=? AND b.user_id=? AND bc.id=?
     RETURNING id`,
    userId,
    String(req.body.title || 'Obrigação mensal').trim() || 'Obrigação mensal',
    String(req.body.description || ''),
    String(req.body.client || ''),
    String(req.body.priority || 'normal'),
    Math.min(31, Math.max(1, Number(req.body.day_of_month || 1))),
    Math.max(0, Number(req.body.create_days_before || 5)),
    JSON.stringify(checklist),
    boardId,
    userId,
    columnId
  );
  if (!inserted) return res.status(400).send('Quadro ou coluna inválida');

  await maybeGenerateRecurringForUser(userId, true);
  setFlash(req, 'success', 'Obrigação mensal criada.');
  return res.redirect('/obligations');
});

app.post('/obligations/:id/toggle', requireAuth, async (req, res) => {
  await db.run(
    'UPDATE recurring_tasks SET active=CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=? AND user_id=?',
    Number(req.params.id),
    Number(req.session.user.id)
  );
  return res.redirect('/obligations');
});

app.get('/integrations', requireAuth, async (req, res) => {
  const integrations = await db.all(
    'SELECT * FROM integrations WHERE user_id=?',
    Number(req.session.user.id)
  );
  const map = Object.fromEntries(integrations.map((item) => [item.provider, item]));
  return res.render('integrations', {
    title: 'Integrações',
    integrations: map,
    gmailConfigured: Boolean(process.env.GMAIL_CLIENT_ID),
    whatsappConfigured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN)
  });
});

app.post('/integrations/:provider/demo-connect', requireAuth, async (req, res) => {
  const provider = ['gmail', 'whatsapp'].includes(req.params.provider) ? req.params.provider : null;
  if (!provider) return res.status(400).send('Integração inválida');

  await db.run(
    `INSERT INTO integrations (user_id,provider,status,account_label,updated_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(user_id,provider)
     DO UPDATE SET status=excluded.status,account_label=excluded.account_label,updated_at=CURRENT_TIMESTAMP`,
    Number(req.session.user.id),
    provider,
    'demo',
    provider === 'gmail' ? 'Conta de demonstração' : 'WhatsApp Business de demonstração'
  );

  setFlash(req, 'success', `Modo de demonstração do ${provider === 'gmail' ? 'Gmail' : 'WhatsApp'} ativado.`);
  return res.redirect('/integrations');
});

app.post('/integrations/:provider/disconnect', requireAuth, async (req, res) => {
  await db.run(
    'DELETE FROM integrations WHERE user_id=? AND provider=?',
    Number(req.session.user.id),
    req.params.provider
  );
  return res.redirect('/integrations');
});

app.get('/health', async (req, res) => {
  const startedAt = Date.now();
  let databaseLatencyMs = null;
  if (db) {
    await db.get('SELECT 1 AS ok');
    databaseLatencyMs = Date.now() - startedAt;
  }
  res.json({
    ok: true,
    database: databaseMode,
    databaseLatencyMs,
    region: process.env.VERCEL_REGION || 'local',
    time: new Date().toISOString()
  });
});

app.use((req, res) => res.status(404).render('not-found', { title: 'Página não encontrada' }));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).send(`
    <!doctype html>
    <html lang="pt-BR">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Erro interno</title></head>
      <body style="font-family:Arial,sans-serif;background:#f8fafc;padding:40px;color:#0f172a">
        <div style="max-width:680px;margin:auto;background:white;border:1px solid #e2e8f0;border-radius:18px;padding:28px">
          <h1 style="margin-top:0">Não foi possível carregar esta página</h1>
          <p>Confira as variáveis do banco de dados e tente novamente.</p>
          <p><a href="/health">Verificar conexão</a></p>
        </div>
      </body>
    </html>
  `);
});

module.exports = app;

if (!IS_VERCEL && require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aurora disponível em http://localhost:${PORT}`);
    console.log(`Banco: ${databaseMode}`);
    console.log('Demonstração: demo@gestor.local / 123456');
  });
}
