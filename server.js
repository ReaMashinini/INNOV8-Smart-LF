require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');



app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], tags: [], orders: [], scans: [], emails: [] }, null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function publicUser(user) { const { password, ...safe } = user; return safe; }
function isAdmin(req) { return req.headers['x-role'] === 'admin'; }
function requireAdmin(req, res) { if (!isAdmin(req)) { res.status(403).json({ error: 'Admin access required' }); return false; } return true; }
function nowISO() { return new Date().toISOString(); }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString(); }

async function sendEmail(to, subject, html) {
  const emailRecord = { id: uuidv4(), to, subject, html, createdAt: nowISO(), status: 'logged-only' };
  const db = readDB();
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
  db.emails.unshift(emailRecord);
  writeDB(db);
  return emailRecord;
}

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password) return res.status(400).json({ error: 'Name, email, phone and password are required.' });
  const db = readDB();
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already exists.' });
  const user = { id: uuidv4(), name, email, phone, password, role: 'user', plan: 'Starter', subscriptionActive: false, createdAt: nowISO() };
  db.users.push(user);
  writeDB(db);
  await sendEmail(email, 'Welcome to INNOV8 SmartLF', `<h2>Welcome ${name}</h2><p>Your INNOV8 SmartLF account is ready. Admin can now assign QR/NFC equipment to you.</p>`).catch(() => null);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.json({ user: publicUser(user) });
});

app.get('/api/bootstrap', (req, res) => {
  const db = readDB();
  const userId = req.query.userId;
  const role = req.query.role;
  if (role === 'admin') return res.json(db);
  res.json({
    users: db.users.map(publicUser),
    tags: db.tags.filter(t => t.userId === userId),
    orders: db.orders.filter(o => o.userId === userId),
    scans: db.scans.filter(s => db.tags.find(t => t.id === s.tagId)?.userId === userId),
    emails: db.emails.filter(e => e.to === db.users.find(u => u.id === userId)?.email)
  });
});

app.post('/api/admin/users', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, email, phone, password, plan = 'Starter', subscriptionActive = false } = req.body;
  if (!name || !email || !phone || !password) return res.status(400).json({ error: 'All fields are required.' });
  const db = readDB();
  if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email already exists.' });
  const user = { id: uuidv4(), name, email, phone, password, role: 'user', plan, subscriptionActive, createdAt: nowISO() };
  db.users.push(user);
  writeDB(db);
  await sendEmail(email, 'Your INNOV8 SmartLF account details', `<h2>Your INNOV8 SmartLF account</h2><p>Email: <b>${email}</b></p><p>Password: <b>${password}</b></p><p>Plan: <b>${plan}</b></p>`).catch(() => null);
  res.json({ user: publicUser(user) });
});

app.put('/api/admin/users/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = readDB();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  ['name','email','phone','plan','subscriptionActive'].forEach(k => { if (req.body[k] !== undefined) user[k] = req.body[k]; });
  writeDB(db);
  await sendEmail(user.email, 'Your INNOV8 SmartLF details were updated', `<h2>Account updated</h2><p>Your details or subscription were updated.</p><p>Plan: <b>${user.plan}</b></p>`).catch(() => null);
  res.json({ user: publicUser(user) });
});

app.post('/api/admin/tags', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { userId, label, type = 'qr', itemName, publicInfo, privateNote } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const tag = {
    id: uuidv4(), code: 'SLF-' + Math.random().toString(36).slice(2, 8).toUpperCase(), userId,
    label: label || itemName || 'SmartLF Tag', type, itemName: itemName || 'My Item',
    publicInfo: publicInfo || 'Please contact the owner if found.', privateNote: privateNote || '',
    active: true, assignedAt: nowISO(), subscriptionRequiredForTracking: type.includes('nfc')
  };
  tag.url = `${BASE_URL}/scan/${tag.code}`;
  tag.qrDataUrl = await QRCode.toDataURL(tag.url, { margin: 1, width: 280 });
  db.tags.unshift(tag);
  writeDB(db);
  await sendEmail(user.email, 'A SmartLF tag has been assigned to you', `<h2>New SmartLF tag assigned</h2><p>Tag: <b>${tag.label}</b></p><p>Scan/NFC link: <a href="${tag.url}">${tag.url}</a></p>`).catch(() => null);
  res.json({ tag });
});

app.put('/api/tags/:id', (req, res) => {
  const db = readDB();
  const tag = db.tags.find(t => t.id === req.params.id);
  if (!tag) return res.status(404).json({ error: 'Tag not found.' });
  ['label','itemName','publicInfo','privateNote','active'].forEach(k => { if (req.body[k] !== undefined) tag[k] = req.body[k]; });
  writeDB(db);
  res.json({ tag });
});

app.post('/api/user/tags', async (req, res) => {
  const { userId, code, label, type = 'qr', itemName, publicInfo } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.id === userId && u.role === 'user');
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const tagCode = code || 'SLF-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  if (db.tags.some(t => t.code === tagCode)) return res.status(409).json({ error: 'This tag code is already linked.' });
  const tag = { id: uuidv4(), code: tagCode, userId, label: label || 'User added tag', type, itemName: itemName || 'My Item', publicInfo: publicInfo || 'Please contact the owner if found.', privateNote: '', active: true, assignedAt: nowISO(), subscriptionRequiredForTracking: type.includes('nfc') };
  tag.url = `${BASE_URL}/scan/${tag.code}`;
  tag.qrDataUrl = await QRCode.toDataURL(tag.url, { margin: 1, width: 280 });
  db.tags.unshift(tag);
  writeDB(db);
  res.json({ tag });
});

app.post('/api/orders', async (req, res) => {
  const { userId, items, total } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const order = { id: 'ORD-' + Date.now(), userId, items, total, status: 'Processing', userReceived: false, placedAt: nowISO(), expectedDate: tomorrowISO() };
  db.orders.unshift(order);
  writeDB(db);
  await sendEmail(user.email, 'INNOV8 SmartLF order confirmed', `<h2>Order confirmed</h2><p>Order <b>${order.id}</b> is now Processing.</p><p>Total: R${total}</p>`).catch(() => null);
  res.json({ order });
});

app.put('/api/admin/orders/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  order.status = req.body.status || order.status;
  order.updatedAt = nowISO();
  const user = db.users.find(u => u.id === order.userId);
  writeDB(db);
  if (user) await sendEmail(user.email, `Order ${order.id} updated`, `<h2>Order update</h2><p>Your order is now: <b>${order.status}</b>.</p>`).catch(() => null);
  res.json({ order });
});

app.put('/api/orders/:id/received', (req, res) => {
  const db = readDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  order.userReceived = true;
  order.status = 'Received by customer';
  order.receivedAt = nowISO();
  writeDB(db);
  res.json({ order });
});

app.get('/api/scan/:code', (req, res) => {
  const db = readDB();
  const tag = db.tags.find(t => t.code === req.params.code);
  if (!tag) return res.status(404).json({ error: 'Tag not found.' });
  const user = db.users.find(u => u.id === tag.userId);
  res.json({ tag, owner: user ? publicUser(user) : null });
});

app.post('/api/scan/:code/location', async (req, res) => {
  const db = readDB();
  const tag = db.tags.find(t => t.code === req.params.code);
  if (!tag) return res.status(404).json({ error: 'Tag not found.' });
  const owner = db.users.find(u => u.id === tag.userId);
  const trackingAllowed = tag.type.includes('nfc') && owner?.subscriptionActive;
  const scan = { id: uuidv4(), tagId: tag.id, code: tag.code, createdAt: nowISO(), trackingAllowed, lat: null, lng: null, accuracy: null, note: req.body.note || '' };
  if (trackingAllowed) {
    scan.lat = req.body.lat ?? null;
    scan.lng = req.body.lng ?? null;
    scan.accuracy = req.body.accuracy ?? null;
  }
  db.scans.unshift(scan);
  writeDB(db);
  if (owner) await sendEmail(owner.email, 'Your SmartLF tag was scanned', `<h2>Tag scanned</h2><p>${tag.label} was scanned.</p><p>Tracking allowed: <b>${trackingAllowed ? 'Yes' : 'No'}</b></p>`).catch(() => null);
  res.json({ scan, trackingAllowed });
});


app.post('/api/admin/email', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { to, subject, message } = req.body;
  if (!to || !subject || !message) return res.status(400).json({ error: 'To, subject and message are required.' });
  const email = await sendEmail(to, subject, `<h2>INNOV8 SmartLF</h2><p>${String(message).replace(/\n/g, '<br>')}</p>`);
  res.json({ email });
});

app.post('/api/contact-owner/:code', async (req, res) => {
  const db = readDB();
  const tag = db.tags.find(t => t.code === req.params.code);
  if (!tag) return res.status(404).json({ error: 'Tag not found.' });
  const owner = db.users.find(u => u.id === tag.userId);
  if (!owner) return res.status(404).json({ error: 'Owner not found.' });
  await sendEmail(owner.email, 'Someone found your SmartLF item', `<h2>Finder message</h2><p>${req.body.message || 'Someone scanned your tag and wants to return your item.'}</p><p>Reply contact: ${req.body.contact || 'Not provided'}</p>`).catch(() => null);
  res.json({ ok: true });
});

app.get('/scan/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`INNOV8 SmartLF running on ${BASE_URL}`));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
