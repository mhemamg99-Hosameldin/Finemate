// server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.sqlite');

// ensure db file exists
const initDb = () => {
  const db = new sqlite3.Database(DB_FILE);
  // create tables if not exists
  db.serialize(() => {
    db.run(PRAGMA foreign_keys = ON;);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      reference TEXT NOT NULL,
      type TEXT NOT NULL,
      account TEXT NOT NULL,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      stock INTEGER DEFAULT 0,
      reorder_level INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ok'
    );`);
    db.run(`CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );`);
    db.run(`CREATE TABLE IF NOT EXISTS category_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
    );`);
  });
  db.close();
};

initDb();

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error('DB error', err);
  else console.log('Connected to SQLite DB:', DB_FILE);
});

// middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Allow CORS for local dev (adjust in production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // change in prod
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
  next();
});

// ---- Helpers ----
const runAsync = (sql, params=[]) => new Promise((res, rej) => {
  db.run(sql, params, function(err){
    if(err) return rej(err);
    res({ lastID: this.lastID, changes: this.changes });
  });
});
const allAsync = (sql, params=[]) => new Promise((res, rej) => {
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
});
const getAsync = (sql, params=[]) => new Promise((res, rej) => {
  db.get(sql, params, (err, row) => err ? rej(err) : res(row));
});

// ---- API: Stats ----
app.get('/api/stats', async (req, res) => {
  try {
    // Revenue = sum of debit where type = 'invoice' (you can adjust business logic)
    const revRow = await getAsync(SELECT IFNULL(SUM(debit),0) as revenue FROM transactions WHERE type = 'invoice');
    const expRow = await getAsync(SELECT IFNULL(SUM(debit),0) as expenses FROM transactions WHERE type = 'expense');
    const stockRow = await getAsync(SELECT IFNULL(SUM(stock),0) as total_stock FROM inventory);
    res.json({
      success: true,
      data: {
        revenue: revRow.revenue || 0,
        expenses: expRow.expenses || 0,
        profit: (revRow.revenue || 0) - (expRow.expenses || 0),
        stock: stockRow.total_stock || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message: 'Server error' });
  }
});

// ---- API: Revenue timeseries (last N months) ----
app.get('/api/revenue-series', async (req, res) => {
  // returns months[] and revenue[], expenses[] (based on category_sales or transactions)
  try {
    // Here we produce last 6 months months labels (YYYY-MM)
    const monthsCount = parseInt(req.query.months || '6', 10);
    const months = [];
    const now = new Date();
    for (let i = monthsCount-1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = d.toISOString().slice(0,7); // YYYY-MM
      months.push(ym);
    }

    // revenue: sum of transactions.debit where type='invoice' grouped by month(date)
    const revenueRows = await allAsync(
      `SELECT substr(date,1,7) as month, IFNULL(SUM(debit),0) as amount 
       FROM transactions 
       WHERE type = 'invoice' AND date >= ? 
       GROUP BY month`,
      [months[0] + '-01']
    );
    const expenseRows = await allAsync(
      `SELECT substr(date,1,7) as month, IFNULL(SUM(debit),0) as amount 
       FROM transactions 
       WHERE type = 'expense' AND date >= ? 
       GROUP BY month`,
      [months[0] + '-01']
    );

    const revMap = {}; revenueRows.forEach(r => revMap[r.month]=r.amount);
    const expMap = {}; expenseRows.forEach(r => expMap[r.month]=r.amount);

    const revenue = months.map(m => revMap[m] ? Math.round(revMap[m]) : 0);
    const expenses = months.map(m => expMap[m] ? Math.round(expMap[m]) : 0);

    // convert months to short labels like 'Mar'
    const labels = months.map(m => {
      const [y,mm] = m.split('-'); return new Date(y, parseInt(mm,10)-1).toLocaleString('en',{month:'short'});
    });

    res.json({ success:true, data: { labels, months, revenue, expenses }});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// ---- API: Category sales for donut ----
app.get('/api/category-sales', async (req, res) => {
  try {
    // optional month param YYYY-MM, default latest month in table or current month
    const month = req.query.month || (new Date()).toISOString().slice(0,7);
    const rows = await allAsync(
      `SELECT c.name, IFNULL(SUM(cs.amount),0) as total
       FROM categories c
       LEFT JOIN category_sales cs ON cs.category_id = c.id AND cs.month = ?
       GROUP BY c.id ORDER BY total DESC`, [month]
    );
    res.json({ success:true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message: 'Server error' });
  }
});

// ---- API: Transactions CRUD & list (with search & filter & export) ----

// list with optional q (search) and type filter and limit/offset
app.get('/api/transactions', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const type = (req.query.type || '').trim();
    const limit = parseInt(req.query.limit||'100',10);
    const offset = parseInt(req.query.offset||'0',10);

    let sql = SELECT * FROM transactions WHERE 1=1;
    const params = [];
    if (type) { sql += ` AND type = ?`; params.push(type); }
    if (q) {
      sql += ` AND (reference LIKE ? OR account LIKE ? OR date LIKE ?)`;
      const like = %${q}%;
      params.push(like, like, like);
    }
    sql += ` ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await allAsync(sql, params);
    res.json({ success:true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// create
app.post('/api/transactions', async (req, res) => {
  try {
    const { date, reference, type, account, debit = 0, credit = 0 } = req.body;
    if (!date || !reference || !type || !account) {
      return res.status(400).json({ success:false, message:'Missing required fields' });
    }
    const r = await runAsync(INSERT INTO transactions(date,reference,type,account,debit,credit) VALUES(?,?,?,?,?,?),
      [date, reference, type, account, debit, credit]);
    const newRow = await getAsync(SELECT * FROM transactions WHERE id = ?, [r.lastID]);
    res.json({ success:true, data: newRow });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// update
app.put('/api/transactions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id,10);
    const { date, reference, type, account, debit = 0, credit = 0 } = req.body;
    if (!date || !reference || !type || !account) {
      return res.status(400).json({ success:false, message:'Missing required fields' });
    }
    const r = await runAsync(UPDATE transactions SET date=?,reference=?,type=?,account=?,debit=?,credit=? WHERE id=?,
      [date,reference,type,account,debit,credit,id]);
    const row = await getAsync(SELECT * FROM transactions WHERE id = ?, [id]);
    res.json({ success:true, changes: r.changes, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// delete
app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id,10);
    const r = await runAsync(DELETE FROM transactions WHERE id=?, [id]);
    res.json({ success:true, changes: r.changes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// export CSV endpoint
app.get('/api/transactions/export', async (req, res) => {
  try {
    const rows = await allAsync(SELECT date,reference,type,account,debit,credit FROM transactions ORDER BY date DESC);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    // write header
    res.write(Date,Reference,Type,Account,Debit,Credit\n);
    rows.forEach(r => {
      // escape quotes if needed
      const line = [
        r.date,
        r.reference.replace(/"/g,'""'),
        r.type,
        r.account.replace(/"/g,'""'),
        r.debit,
        r.credit
      ].map(v => "${v}").join(',');
      res.write(line + '\n');
    });
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// ---- API: Inventory ----
app.get('/api/inventory', async (req, res) => {
  try {
    const rows = await allAsync(SELECT * FROM inventory ORDER BY stock ASC);
    res.json({ success:true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id,10);
    const { stock, reorder_level, status } = req.body;
    const r = await runAsync(UPDATE inventory SET stock = ?, reorder_level = ?, status = ? WHERE id = ?,
      [stock, reorder_level, status, id]);
    const row = await getAsync(SELECT * FROM inventory WHERE id = ?, [id]);
    res.json({ success:true, changes: r.changes, data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// ---- Serve front-end fallback ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); // if your HTML is dashboard.html
});

// start
app.listen(PORT, () => {
  console.log(Server started on http://localhost:${PORT});
});