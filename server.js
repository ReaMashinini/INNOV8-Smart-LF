require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT, email TEXT UNIQUE, phone TEXT, password TEXT,
      role TEXT DEFAULT 'user', plan TEXT DEFAULT 'Starter',
      subscription_active BOOLEAN DEFAULT false,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE, user_id TEXT, label TEXT, type TEXT,
      item_name TEXT, public_info TEXT, private_note TEXT,
      active BOOLEAN DEFAULT true, assigned_at TEXT,
      subscription_required_for_tracking BOOLEAN DEFAULT false,
      url TEXT, qr_data_url TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT, items JSONB, total NUMERIC,
      status TEXT DEFAULT 'Processing',
      user_received BOOLEAN DEFAULT false,
      placed_at TEXT, expected_date TEXT,
      updated_at TEXT, received_at TEXT
    );
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      tag_id TEXT, code TEXT, created_at TEXT,
      tracking_allowed BOOLEAN DEFAULT false,
      lat NUMERIC, lng NUMERIC, accuracy NUMERIC, note TEXT
    );
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      "to" TEXT, subject TEXT, html TEXT,
      created_at TEXT, status TEXT DEFAULT 'logged-only'
    );
  `);
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function publicUser(user) {
  const { password, ...safe } = user;
  return safe;
}
function isAdmin(req) { return req.headers['x-role'] === 'admin'; }
function requireAdmin(req, res) {
  if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return false; }
  return true;
}
function nowISO() { return new Date().toISOString(); }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString(); }

async function sendEmail(to, subject, html) {
  const emailRecord = { id: uuidv4(), to, subject, html, createdAt: nowISO(), status: 'logged-only' };
  const hasSmtp = process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS;
  if (hasSmtp) {
    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT || 587),
      secure: String(process.env.MAIL_SECURE).toLowerCase() === 'true',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });
    await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.MAIL_USER, to, subject, html });
    emailRecord.status = 'sent';
  }
  await pool.query(
    `INSERT INTO emails (id, "to", subject, html, created_at, status) VALUES ($1,$2,$3,$4,$5,$6)`,
    [emailRecord.id, to, subject, html, emailRecord.createdAt, emailRecord.status]
  );
  return emailRecord;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password) return res.status(400).json({ error: 'Name, email, phone and password are required.' });
  const existing = await pool.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [email]);
  if (existing.rows.length) return res.status(409).json({ error: 'Email already exists.' });
  const user = { id: uuidv4(), name, email, phone, password, role: 'user', plan: 'Starter', subscriptionActive: false, createdAt: nowISO() };
  await pool.query(
    `INSERT INTO users (id,name,email,phone,password,role,plan,subscription_active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user.id, name, email, phone, password, 'user', 'Starter', false, user.createdAt]
  );
  await sendEmail(email, 'Welcome to INNOV8 SmartLF', `<h2>Welcome ${name}</h2><p>Your INNOV8 SmartLF account is ready.</p>`).catch(() => null);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE LOWER(email)=LOWER($1) AND password=$2', [email || '', password]);
  if (!result.rows.length) return res.status(401).json({ error: 'Incorrect email or password.' });
  const user = dbUserToObj(result.rows[0]);
  res.json({ user: publicUser(user) });
});

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────────

app.get('/api/bootstrap', async (req, res) => {
  const { userId, role } = req.query;
  if (role === 'admin') {
    const [users, tags, orders, scans, emails] = await Promise.all([
      pool.query('SELECT * FROM users ORDER BY created_at DESC'),
      pool.query('SELECT * FROM tags ORDER BY assigned_at DESC'),
      pool.query('SELECT * FROM orders ORDER BY placed_at DESC'),
      pool.query('SELECT * FROM scans ORDER BY created_at DESC'),
      pool.query('SELECT * FROM emails ORDER BY created_at DESC')
    ]);
    return res.json({
      users: users.rows.map(r => publicUser(dbUserToObj(r))),
      tags: tags.rows.map(dbTagToObj),
      orders: orders.rows.map(dbOrderToObj),
      scans: scans.rows.map(dbScanToObj),
      emails: emails.rows.map(dbEmailToObj)
    });
  }
  const userRow = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  if (!userRow.rows.length) return res.json({ users: [], tags: [], orders: [], scans: [], emails: [] });
  const userEmail = userRow.rows[0].email;
  const [tags, orders, scans, emails] = await Promise.all([
    pool.query('SELECT * FROM tags WHERE user_id=$1 ORDER BY assigned_at DESC', [userId]),
    pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY placed_at DESC', [userId]),
    pool.query('SELECT s.* FROM scans s JOIN tags t ON s.tag_id=t.id WHERE t.user_id=$1 ORDER BY s.created_at DESC', [userId]),
    pool.query('SELECT * FROM emails WHERE "to"=$1 ORDER BY created_at DESC', [userEmail])
  ]);
  res.json({
    users: [publicUser(dbUserToObj(userRow.rows[0]))],
    tags: tags.rows.map(dbTagToObj),
    orders: orders.rows.map(dbOrderToObj),
    scans: scans.rows.map(dbScanToObj),
    emails: emails.rows.map(dbEmailToObj)
  });
});

// ── ADMIN USERS ───────────────────────────────────────────────────────────────

app.post('/api/admin/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, email, phone, password, plan = 'Starter', subscriptionActive = false } = req.body;
  if (!name || !email || !phone || !password) return res.status(400).json({ error: 'All fields are required.' });
  const existing = await pool.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [email]);
  if (existing.rows.length) return res.status(409).json({ error: 'Email already exists.' });
  const user = { id: uuidv4(), name, email, phone, password, role: 'user', plan, subscriptionActive, createdAt: nowISO() };
  await pool.query(
    `INSERT INTO users (id,name,email,phone,password,role,plan,subscription_active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user.id, name, email, phone, password, 'user', plan, subscriptionActive, user.createdAt]
  );
  await sendEmail(email, 'Your INNOV8 SmartLF account details', `<h2>Your INNOV8 SmartLF account</h2><p>Email: <b>${email}</b></p><p>Password: <b>${password}</b></p><p>Plan: <b>${plan}</b></p>`).catch(() => null);
  res.json({ user: publicUser(user) });
});

app.put('/api/admin/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
  const u = result.rows[0];
  const name = req.body.name ?? u.name;
  const email = req.body.email ?? u.email;
  const phone = req.body.phone ?? u.phone;
  const plan = req.body.plan ?? u.plan;
  const subscriptionActive = req.body.subscriptionActive ?? u.subscription_active;
  await pool.query(
    `UPDATE users SET name=$1,email=$2,phone=$3,plan=$4,subscription_active=$5 WHERE id=$6`,
    [name, email, phone, plan, subscriptionActive, req.params.id]
  );
  await sendEmail(email, 'Your INNOV8 SmartLF details were updated', `<h2>Account updated</h2><p>Plan: <b>${plan}</b></p>`).catch(() => null);
  res.json({ user: publicUser({ id: u.id, name, email, phone, plan, subscriptionActive, role: u.role, createdAt: u.created_at }) });
});

// ── TAGS ──────────────────────────────────────────────────────────────────────

app.post('/api/admin/tags', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { userId, label, type = 'qr', itemName, publicInfo, privateNote } = req.body;
  const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  if (!userResult.rows.length) return res.status(404).json({ error: 'User not found.' });
  const user = userResult.rows[0];
  const tag = {
    id: uuidv4(), code: 'SLF-' + Math.random().toString(36).slice(2, 8).toUpperCase(), userId,
    label: label || itemName || 'SmartLF Tag', type, itemName: itemName || 'My Item',
    publicInfo: publicInfo || 'Please contact the owner if found.', privateNote: privateNote || '',
    active: true, assignedAt: nowISO(), subscriptionRequiredForTracking: type.includes('nfc')
  };
  tag.url = `${BASE_URL}/scan/${tag.code}`;
  tag.qrDataUrl = await QRCode.toDataURL(tag.url, { margin: 1, width: 280 });
  await pool.query(
    `INSERT INTO tags (id,code,user_id,label,type,item_name,public_info,private_note,active,assigned_at,subscription_required_for_tracking,url,qr_data_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [tag.id, tag.code, userId, tag.label, type, tag.itemName, tag.publicInfo, tag.privateNote, true, tag.assignedAt, tag.subscriptionRequiredForTracking, tag.url, tag.qrDataUrl]
  );
  await sendEmail(user.email, 'A SmartLF tag has been assigned to you', `<h2>New SmartLF tag assigned</h2><p>Tag: <b>${tag.label}</b></p><p>Link: <a href="${tag.url}">${tag.url}</a></p>`).catch(() => null);
  res.json({ tag });
});

app.put('/api/tags/:id', async (req, res) => {
  const result = await pool.query('SELECT * FROM tags WHERE id=$1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Tag not found.' });
  const t = result.rows[0];
  const label = req.body.label ?? t.label;
  const itemName = req.body.itemName ?? t.item_name;
  const publicInfo = req.body.publicInfo ?? t.public_info;
  const privateNote = req.body.privateNote ?? t.private_note;
  const active = req.body.active ?? t.active;
  await pool.query(
    `UPDATE tags SET label=$1,item_name=$2,public_info=$3,private_note=$4,active=$5 WHERE id=$6`,
    [label, itemName, publicInfo, privateNote, active, req.params.id]
  );
  res.json({ tag: dbTagToObj({ ...t, label, item_name: itemName, public_info: publicInfo, private_note: privateNote, active }) });
});

app.post('/api/user/tags', async (req, res) => {
  const { userId, code, label, type = 'qr', itemName, publicInfo } = req.body;
  const userResult = await pool.query('SELECT * FROM users WHERE id=$1 AND role=$2', [userId, 'user']);
  if (!userResult.rows.length) return res.status(404).json({ error: 'User not found.' });
  const tagCode = code || 'SLF-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const existing = await pool.query('SELECT id FROM tags WHERE code=$1', [tagCode]);
  if (existing.rows.length) return res.status(409).json({ error: 'This tag code is already linked.' });
  const tag = {
    id: uuidv4(), code: tagCode, userId, label: label || 'User added tag', type,
    itemName: itemName || 'My Item', publicInfo: publicInfo || 'Please contact the owner if found.',
    privateNote: '', active: true, assignedAt: nowISO(), subscriptionRequiredForTracking: type.includes('nfc')
  };
  tag.url = `${BASE_URL}/scan/${tag.code}`;
  tag.qrDataUrl = await QRCode.toDataURL(tag.url, { margin: 1, width: 280 });
  await pool.query(
    `INSERT INTO tags (id,code,user_id,label,type,item_name,public_info,private_note,active,assigned_at,subscription_required_for_tracking,url,qr_data_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [tag.id, tag.code, userId, tag.label, type, tag.itemName, tag.publicInfo, tag.privateNote, true, tag.assignedAt, tag.subscriptionRequiredForTracking, tag.url, tag.qrDataUrl]
  );
  res.json({ tag });
});

// ── ORDERS ────────────────────────────────────────────────────────────────────

app.post('/api/orders', async (req, res) => {
  const { userId, items, total } = req.body;
  const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  if (!userResult.rows.length) return res.status(404).json({ error: 'User not found.' });
  const user = userResult.rows[0];
  const order = { id: 'ORD-' + Date.now(), userId, items, total, status: 'Processing', userReceived: false, placedAt: nowISO(), expectedDate: tomorrowISO() };
  await pool.query(
    `INSERT INTO orders (id,user_id,items,total,status,user_received,placed_at,expected_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [order.id, userId, JSON.stringify(items), total, 'Processing', false, order.placedAt, order.expectedDate]
  );
  await sendEmail(user.email, 'INNOV8 SmartLF order confirmed', `<h2>Order confirmed</h2><p>Order <b>${order.id}</b> is Processing.</p><p>Total: R${total}</p>`).catch(() => null);
  res.json({ order });
});

app.put('/api/admin/orders/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
  const order = result.rows[0];
  const status = req.body.status || order.status;
  await pool.query(`UPDATE orders SET status=$1, updated_at=$2 WHERE id=$3`, [status, nowISO(), req.params.id]);
  const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [order.user_id]);
  if (userResult.rows.length) await sendEmail(userResult.rows[0].email, `Order ${order.id} updated`, `<h2>Order update</h2><p>Your order is now: <b>${status}</b>.</p>`).catch(() => null);
  res.json({ order: dbOrderToObj({ ...order, status }) });
});

app.put('/api/orders/:id/received', async (req, res) => {
  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
  await pool.query(`UPDATE orders SET user_received=true, status='Received by customer', received_at=$1 WHERE id=$2`, [nowISO(), req.params.id]);
  res.json({ order: dbOrderToObj({ ...result.rows[0], user_received: true, status: 'Received by customer' }) });
});

// ── SCANS ─────────────────────────────────────────────────────────────────────

app.get('/api/scan/:code', async (req, res) => {
  const result = await pool.query('SELECT * FROM tags WHERE code=$1', [req.params.code]);
  if (!result.rows.length) return res.status(404).json({ error: 'Tag not found.' });
  const tag = dbTagToObj(result.rows[0]);
  const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [tag.userId]);
  const owner = userResult.rows.length ? publicUser(dbUserToObj(userResult.rows[0])) : null;
  res.json({ tag, owner });
});

app.post('/api/scan/:code/location', async (req, res) => {
  const result = await pool.query('SELECT * FROM tags WHERE code=$1', [req.params.code]);
  if (!result.rows.length) return res.status(404).json({ error: 'Tag not found.' });
  const tag = dbTagToObj(result.rows[0]);
  const ownerResult = await pool.query('SELECT * FROM users WHERE id=$1', [tag.userId]);
  const owner = ownerResult.rows.length ? dbUserToObj(ownerResult.rows[0]) : null;
  const trackingAllowed = tag.type.includes('nfc') && owner?.subscriptionActive;
  const scan = {
    id: uuidv4(), tagId: tag.id, code: tag.code, createdAt: nowISO(), trackingAllowed,
    lat: trackingAllowed ? (req.body.lat ?? null) : null,
    lng: trackingAllowed ? (req.body.lng ?? null) : null,
    accuracy: trackingAllowed ? (req.body.accuracy ?? null) : null,
    note: req.body.note || ''
  };
  await pool.query(
    `INSERT INTO scans (id,tag_id,code,created_at,tracking_allowed,lat,lng,accuracy,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [scan.id, scan.tagId, scan.code, scan.createdAt, trackingAllowed, scan.lat, scan.lng, scan.accuracy, scan.note]
  );
  if (owner) await sendEmail(owner.email, 'Your SmartLF tag was scanned', `<h2>Tag scanned</h2><p>${tag.label} was scanned.</p><p>Tracking: <b>${trackingAllowed ? 'Yes' : 'No'}</b></p>`).catch(() => null);
  res.json({ scan, trackingAllowed });
});

// ── EMAIL / CONTACT ───────────────────────────────────────────────────────────

app.post('/api/admin/email', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { to, subject, message } = req.body;
  if (!to || !subject || !message) return res.status(400).json({ error: 'To, subject and message are required.' });
  const email = await sendEmail(to, subject, `<h2>INNOV8 SmartLF</h2><p>${String(message).replace(/\n/g, '<br>')}</p>`);
  res.json({ email });
});

app.post('/api/contact-owner/:code', async (req, res) => {
  const result = await pool.query('SELECT * FROM tags WHERE code=$1', [req.params.code]);
  if (!result.rows.length) return res.status(404).json({ error: 'Tag not found.' });
  const tag = dbTagToObj(result.rows[0]);
  const ownerResult = await pool.query('SELECT * FROM users WHERE id=$1', [tag.userId]);
  if (!ownerResult.rows.length) return res.status(404).json({ error: 'Owner not found.' });
  const owner = ownerResult.rows[0];
  await sendEmail(owner.email, 'Someone found your SmartLF item', `<h2>Finder message</h2><p>${req.body.message || 'Someone scanned your tag.'}</p><p>Reply contact: ${req.body.contact || 'Not provided'}</p>`).catch(() => null);
  res.json({ ok: true });
});

// ── FRONTEND ROUTES ───────────────────────────────────────────────────────────

app.get('/scan/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── DB ROW MAPPERS ────────────────────────────────────────────────────────────

function dbUserToObj(r) {
  return { id: r.id, name: r.name, email: r.email, phone: r.phone, password: r.password, role: r.role, plan: r.plan, subscriptionActive: r.subscription_active, createdAt: r.created_at };
}
function dbTagToObj(r) {
  return { id: r.id, code: r.code, userId: r.user_id, label: r.label, type: r.type, itemName: r.item_name, publicInfo: r.public_info, privateNote: r.private_note, active: r.active, assignedAt: r.assigned_at, subscriptionRequiredForTracking: r.subscription_required_for_tracking, url: r.url, qrDataUrl: r.qr_data_url };
}
function dbOrderToObj(r) {
  return { id: r.id, userId: r.user_id, items: r.items, total: r.total, status: r.status, userReceived: r.user_received, placedAt: r.placed_at, expectedDate: r.expected_date, updatedAt: r.updated_at, receivedAt: r.received_at };
}
function dbScanToObj(r) {
  return { id: r.id, tagId: r.tag_id, code: r.code, createdAt: r.created_at, trackingAllowed: r.tracking_allowed, lat: r.lat, lng: r.lng, accuracy: r.accuracy, note: r.note };
}
function dbEmailToObj(r) {
  return { id: r.id, to: r.to, subject: r.subject, html: r.html, createdAt: r.created_at, status: r.status };
}

// ── START ─────────────────────────────────────────────────────────────────────

initDB()
  .then(() => app.listen(PORT, () => console.log(`INNOV8 SmartLF running on ${BASE_URL}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
