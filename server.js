const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_id);
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
  const columns = [];

  for (const [name, position, color] of columnDefinitions) {
    const result = await db.run(
      'INSERT INTO board_columns (board_id,name,position,color) VALUES (?,?,?,?)',
      boardId,
      name,
      position,
      color
    );
    columns.push(Number(result.lastInsertRowid));
  }

  if (withDemoTasks) {
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

    await db.run(
      `INSERT INTO tasks
       (user_id,board_id,column_id,title,description,client,priority,due_date,estimated_minutes,position)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      userId,
      boardId,
      columns[1],
      'Preparar relatório mensal',
      'Consolidar informações e revisar antes do envio.',
      'Empresa Modelo',
      'normal',
      iso(3),
      120,
      0
    );

    await db.run(
      `INSERT INTO tasks
       (user_id,board_id,column_id,title,description,client,priority,due_date,estimated_minutes,position)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      userId,
      boardId,
      columns[2],
      'Aguardar retorno sobre notas fiscais',
      'Cliente foi avisado e precisa enviar os arquivos faltantes.',
      'João da Silva',
      'urgent',
      iso(-1),
      30,
      0
    );

    const taskId = Number(firstTask.lastInsertRowid);
    await db.run('INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)', taskId, 'Verificar competência dos documentos', 1, 0);
    await db.run('INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)', taskId, 'Conferir valores e CNPJ', 1, 1);
    await db.run('INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)', taskId, 'Registrar pendências', 0, 2);
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
      bcrypt.hashSync('123456', 12)
    );
    await createDefaultWorkspace(Number(result.lastInsertRowid), true);
  } catch (error) {
    if (!String(error.message || '').toLowerCase().includes('unique')) throw error;
  }
}

let readyPromise = Promise.resolve();
if (db) {
  readyPromise = (async () => {
    await initDatabase();
    await seedDemo();
  })();
}

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

async function userBoard(boardId, userId) {
  return db.get('SELECT * FROM boards WHERE id = ? AND user_id = ?', boardId, userId);
}

async function userTask(taskId, userId) {
  return db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', taskId, userId);
}

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

    for (let index = 0; index < checklist.length; index += 1) {
      await db.run(
        'INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)',
        taskId,
        String(checklist[index]),
        1,
        index
      );
    }

    await db.run('UPDATE recurring_tasks SET last_generated_month = ? WHERE id = ?', currentMonth, item.id);
  }
}

async function durationForTask(taskId) {
  const entries = await db.all('SELECT * FROM time_entries WHERE task_id = ?', taskId);
  const now = Date.now();
  return entries.reduce((sum, entry) => {
    if (entry.ended_at) return sum + Number(entry.duration_seconds || 0);
    return sum + Math.max(0, Math.floor((now - new Date(entry.started_at).getTime()) / 1000));
  }, 0);
}

async function enrichTasks(tasks) {
  return Promise.all(tasks.map(async (task) => {
    const checklist = await db.all('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY position,id', task.id);
    const runningTimer = await db.get(
      'SELECT * FROM time_entries WHERE task_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
      task.id
    );
    const done = checklist.filter((item) => Number(item.done) === 1).length;

    return {
      ...task,
      checklist,
      checklistDone: done,
      checklistTotal: checklist.length,
      totalSeconds: await durationForTask(task.id),
      runningTimer: runningTimer || null
    };
  }));
}

async function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  await generateRecurringForUser(Number(req.session.user.id));
  return next();
}

app.get('/', (req, res) => res.redirect(req.session?.user ? '/dashboard' : '/login'));

app.get('/login', (req, res) => res.render('login', { title: 'Entrar' }));

app.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
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
      bcrypt.hashSync(password, 12)
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
  const boards = await db.all('SELECT * FROM boards WHERE user_id = ? ORDER BY id', userId);
  const rawTasks = await db.all(
    `SELECT t.*, bc.name column_name, b.name board_name
     FROM tasks t
     JOIN board_columns bc ON bc.id=t.column_id
     JOIN boards b ON b.id=t.board_id
     WHERE t.user_id=?
     ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date`,
    userId
  );
  const tasks = await enrichTasks(rawTasks);
  const today = new Date().toISOString().slice(0, 10);
  const todayTasks = tasks.filter((task) => task.due_date === today && !task.completed_at);
  const overdue = tasks.filter((task) => task.due_date && task.due_date < today && !task.completed_at);
  const running = tasks.filter((task) => task.runningTimer);
  const completed = tasks.filter((task) => task.completed_at);
  const totalRow = await db.get(
    `SELECT COALESCE(SUM(duration_seconds),0) total
     FROM time_entries
     WHERE user_id=? AND ended_at IS NOT NULL AND substr(started_at,1,10)=?`,
    userId,
    today
  );

  res.render('dashboard', {
    title: 'Início',
    boards,
    tasks,
    todayTasks,
    overdue,
    running,
    completed,
    totalSecondsToday: Number(totalRow?.total || 0)
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

  for (let index = 0; index < defaults.length; index += 1) {
    const [columnName, color] = defaults[index];
    await db.run(
      'INSERT INTO board_columns (board_id,name,position,color) VALUES (?,?,?,?)',
      boardId,
      columnName,
      index,
      color
    );
  }

  return res.redirect(`/boards/${boardId}`);
});

app.get('/boards/:id', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const board = await userBoard(Number(req.params.id), userId);
  if (!board) return res.status(404).send('Quadro não encontrado');

  const view = ['kanban', 'table', 'calendar', 'list'].includes(req.query.view) ? req.query.view : 'kanban';
  const columns = await db.all('SELECT * FROM board_columns WHERE board_id=? ORDER BY position,id', board.id);
  const rawTasks = await db.all(
    'SELECT * FROM tasks WHERE board_id=? AND user_id=? ORDER BY position,id DESC',
    board.id,
    userId
  );
  const tasks = await enrichTasks(rawTasks);
  const selected = req.query.task ? await userTask(Number(req.query.task), userId) : null;
  const selectedTask = selected ? (await enrichTasks([selected]))[0] : null;
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? String(req.query.month)
    : new Date().toISOString().slice(0, 7);

  return res.render('board', { title: board.name, board, columns, tasks, view, selectedTask, month });
});

app.post('/boards/:id/columns', requireAuth, async (req, res) => {
  const board = await userBoard(Number(req.params.id), Number(req.session.user.id));
  if (!board) return res.status(404).send('Quadro não encontrado');

  const positionRow = await db.get(
    'SELECT COALESCE(MAX(position),-1)+1 p FROM board_columns WHERE board_id=?',
    board.id
  );
  await db.run(
    'INSERT INTO board_columns (board_id,name,position,color) VALUES (?,?,?,?)',
    board.id,
    String(req.body.name || 'Nova coluna'),
    Number(positionRow.p),
    '#64748b'
  );
  return res.redirect(`/boards/${board.id}`);
});

app.post('/tasks', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const board = await userBoard(Number(req.body.board_id), userId);
  if (!board) return res.status(400).send('Quadro inválido');

  const column = await db.get(
    'SELECT * FROM board_columns WHERE id=? AND board_id=?',
    Number(req.body.column_id),
    board.id
  );
  if (!column) return res.status(400).send('Coluna inválida');

  const result = await db.run(
    `INSERT INTO tasks
     (user_id,board_id,column_id,title,description,client,priority,due_date,estimated_minutes,position)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    userId,
    board.id,
    column.id,
    String(req.body.title || 'Nova tarefa').trim(),
    String(req.body.description || ''),
    String(req.body.client || ''),
    String(req.body.priority || 'normal'),
    req.body.due_date || null,
    Number(req.body.estimated_minutes || 0),
    0
  );

  return res.redirect(`/boards/${board.id}?task=${Number(result.lastInsertRowid)}`);
});

app.post('/tasks/:id/update', requireAuth, async (req, res) => {
  const task = await userTask(Number(req.params.id), Number(req.session.user.id));
  if (!task) return res.status(404).send('Tarefa não encontrada');

  await db.run(
    `UPDATE tasks
     SET title=?,description=?,client=?,priority=?,due_date=?,estimated_minutes=?,updated_at=CURRENT_TIMESTAMP
     WHERE id=?`,
    String(req.body.title || task.title),
    String(req.body.description || ''),
    String(req.body.client || ''),
    String(req.body.priority || 'normal'),
    req.body.due_date || null,
    Number(req.body.estimated_minutes || 0),
    task.id
  );
  return res.redirect(`/boards/${task.board_id}?task=${task.id}`);
});

app.post('/tasks/:id/delete', requireAuth, async (req, res) => {
  const task = await userTask(Number(req.params.id), Number(req.session.user.id));
  if (!task) return res.status(404).send('Tarefa não encontrada');

  await db.run('DELETE FROM tasks WHERE id=?', task.id);
  return res.redirect(`/boards/${task.board_id}`);
});

app.post('/api/tasks/:id/move', requireAuth, async (req, res) => {
  const task = await userTask(Number(req.params.id), Number(req.session.user.id));
  if (!task) return res.status(404).json({ error: 'Tarefa não encontrada' });

  const column = await db.get(
    'SELECT * FROM board_columns WHERE id=? AND board_id=?',
    Number(req.body.column_id),
    task.board_id
  );
  if (!column) return res.status(400).json({ error: 'Coluna inválida' });

  const isDone = /conclu|finaliz/i.test(column.name);
  await db.run(
    'UPDATE tasks SET column_id=?,completed_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
    column.id,
    isDone ? new Date().toISOString() : null,
    task.id
  );
  return res.json({ ok: true });
});

app.post('/tasks/:id/checklist', requireAuth, async (req, res) => {
  const task = await userTask(Number(req.params.id), Number(req.session.user.id));
  if (!task) return res.status(404).send('Tarefa não encontrada');

  const positionRow = await db.get(
    'SELECT COALESCE(MAX(position),-1)+1 p FROM checklist_items WHERE task_id=?',
    task.id
  );
  const text = String(req.body.text || '').trim();
  if (text) {
    await db.run(
      'INSERT INTO checklist_items (task_id,text,required,position) VALUES (?,?,?,?)',
      task.id,
      text,
      req.body.required ? 1 : 0,
      Number(positionRow.p)
    );
  }
  return res.redirect(`/boards/${task.board_id}?task=${task.id}`);
});

app.post('/checklist/:id/toggle', requireAuth, async (req, res) => {
  const item = await db.get(
    `SELECT ci.*,t.user_id,t.board_id
     FROM checklist_items ci
     JOIN tasks t ON t.id=ci.task_id
     WHERE ci.id=?`,
    Number(req.params.id)
  );
  if (!item || Number(item.user_id) !== Number(req.session.user.id)) {
    return res.status(404).send('Item não encontrado');
  }

  await db.run(
    'UPDATE checklist_items SET done=CASE done WHEN 1 THEN 0 ELSE 1 END WHERE id=?',
    item.id
  );
  return res.redirect(`/boards/${item.board_id}?task=${item.task_id}`);
});

app.post('/tasks/:id/timer/start', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const task = await userTask(Number(req.params.id), userId);
  if (!task) return res.status(404).send('Tarefa não encontrada');

  const running = await db.get(
    'SELECT id FROM time_entries WHERE user_id=? AND ended_at IS NULL',
    userId
  );
  if (!running) {
    await db.run(
      'INSERT INTO time_entries (task_id,user_id,started_at) VALUES (?,?,?)',
      task.id,
      userId,
      new Date().toISOString()
    );
  }
  return res.redirect(req.get('referer') || `/boards/${task.board_id}?task=${task.id}`);
});

app.post('/tasks/:id/timer/stop', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const task = await userTask(Number(req.params.id), userId);
  if (!task) return res.status(404).send('Tarefa não encontrada');

  const running = await db.get(
    `SELECT * FROM time_entries
     WHERE task_id=? AND user_id=? AND ended_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    task.id,
    userId
  );

  if (running) {
    const end = new Date();
    const seconds = Math.max(1, Math.floor((end.getTime() - new Date(running.started_at).getTime()) / 1000));
    await db.run(
      'UPDATE time_entries SET ended_at=?,duration_seconds=? WHERE id=?',
      end.toISOString(),
      seconds,
      running.id
    );
  }

  return res.redirect(req.get('referer') || `/boards/${task.board_id}?task=${task.id}`);
});

app.get('/obligations', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const templates = await db.all(
    `SELECT r.*,b.name board_name,bc.name column_name
     FROM recurring_tasks r
     JOIN boards b ON b.id=r.board_id
     JOIN board_columns bc ON bc.id=r.column_id
     WHERE r.user_id=?
     ORDER BY r.day_of_month`,
    userId
  );
  const boards = await db.all('SELECT * FROM boards WHERE user_id=? ORDER BY name', userId);
  const columns = await db.all(
    `SELECT bc.*
     FROM board_columns bc
     JOIN boards b ON b.id=bc.board_id
     WHERE b.user_id=?
     ORDER BY bc.board_id,bc.position`,
    userId
  );
  return res.render('obligations', { title: 'Obrigações mensais', templates, boards, columns });
});

app.post('/obligations', requireAuth, async (req, res) => {
  const userId = Number(req.session.user.id);
  const board = await userBoard(Number(req.body.board_id), userId);
  const column = board
    ? await db.get('SELECT * FROM board_columns WHERE id=? AND board_id=?', Number(req.body.column_id), board.id)
    : null;
  if (!board || !column) return res.status(400).send('Quadro ou coluna inválida');

  const checklist = String(req.body.checklist || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  await db.run(
    `INSERT INTO recurring_tasks
     (user_id,board_id,column_id,title,description,client,priority,day_of_month,create_days_before,checklist_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    userId,
    board.id,
    column.id,
    String(req.body.title || 'Obrigação mensal'),
    String(req.body.description || ''),
    String(req.body.client || ''),
    String(req.body.priority || 'normal'),
    Math.min(31, Math.max(1, Number(req.body.day_of_month || 1))),
    Math.max(0, Number(req.body.create_days_before || 5)),
    JSON.stringify(checklist)
  );

  await generateRecurringForUser(userId);
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

app.get('/health', (req, res) => {
  res.json({ ok: true, database: databaseMode, time: new Date().toISOString() });
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
