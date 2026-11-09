require('dotenv').config();
const express = require('express'), cookie = require('cookie-parser'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), crypto = require('crypto'), fs = require('fs'), path = require('path'),
  Database = require('better-sqlite3'), startBot = require('./bot');

const { PORT = 3000, JWT_SECRET, RAMA_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME,
  ADMIN_TELEGRAM_ID, ADMIN_WA_NUMBER, UPDATE_GROUP_LINK } = process.env;
if (!JWT_SECRET || !RAMA_API_KEY) { console.error('Isi JWT_SECRET dan RAMA_API_KEY di file .env'); process.exit(1); }

const RAMA = 'https://ramashop.my.id/api/public';

// ---------- Database (SQLite, satu file: fanzdigital.db) ----------
const db = new Database('fanzdigital.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  email TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, product TEXT NOT NULL, variant TEXT NOT NULL, email TEXT NOT NULL,
  amount INTEGER NOT NULL, deposit_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  checked_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
-- untuk tahap berikutnya: panel, VPS, dan script yang sudah dikirim ke pelanggan
CREATE TABLE IF NOT EXISTS services(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
  email TEXT NOT NULL, type TEXT NOT NULL, details TEXT, expires_at INTEGER, created_at INTEGER NOT NULL);
`);
// kolom untuk kode klaim (aman dijalankan ulang, juga untuk database lama)
const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
for (const c of ['claim_code TEXT', 'claimed_at INTEGER', 'claimed_via TEXT'])
  if (!cols.includes(c.split(' ')[0])) db.exec('ALTER TABLE orders ADD COLUMN ' + c);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_claim ON orders(claim_code)');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa I, O, 0, 1 supaya tidak membingungkan
const newCode = () => 'FD-' + Array.from(crypto.randomBytes(8), b => ALPHA[b % 32]).join('');

const q = {
  user: db.prepare('SELECT * FROM users WHERE email = ?'),
  addUser: db.prepare('INSERT INTO users(email,name,hash,created_at) VALUES(?,?,?,?)'),
  addOrder: db.prepare('INSERT INTO orders(id,product,variant,email,amount,deposit_id,created_at) VALUES(?,?,?,?,?,?,?)'),
  order: db.prepare('SELECT * FROM orders WHERE id = ?'),
  touch: db.prepare('UPDATE orders SET checked_at = ? WHERE id = ?'),
  markPaid: db.prepare("UPDATE orders SET status='paid', claim_code = ? WHERE id = ? AND status='pending'"),
  byCode: db.prepare('SELECT * FROM orders WHERE claim_code = ?'),
  claim: db.prepare("UPDATE orders SET claimed_at = ?, claimed_via = ? WHERE claim_code = ? AND status='paid' AND claimed_at IS NULL"),
  unclaim: db.prepare('UPDATE orders SET claimed_at = NULL, claimed_via = NULL WHERE claim_code = ?'),
  markExpired: db.prepare("UPDATE orders SET status='expired' WHERE id = ? AND status='pending'"),
};

// ---------- Produk ----------
// Harga dipegang server (jangan percaya harga dari browser). Samakan dengan public/index.html.
const PRODUCTS = {
  do: { name: 'Panel Pterodactyl (Digital Ocean)', vars: { '2GB': 4000, '3GB': 6000, '4GB': 8000, 'Unlimited': 20000 } },
  reseller: { name: 'Reseller Panel (Digital Ocean)', vars: { 'Reseller': 15000 } },
  vps: { name: 'VPS Digital Ocean', vars: { '1GB / 1 vCPU': 35000, '2GB / 1 vCPU': 50000, '2GB / 2 vCPU': 65000, '4GB / 2 vCPU': 100000, '8GB / 4 vCPU': 190000 } },
  otp: { name: 'Script Order OTP / Nokos', vars: { 'Tanpa update': 25000, 'Full update': 45000 } },
  auto: { name: 'Script Auto Order Lainnya', vars: { 'Tanpa update': 20000, 'Full update': 35000 } },
  jasa: { name: 'Jasa Script Bot Custom', vars: { 'Mulai dari': 35000 } },
};
const CODES = { HEMAT10: 0.1 };

// API key Rama hanya dipakai di sini (server), tidak pernah dikirim ke browser.
const rama = (path, opt = {}) =>
  fetch(RAMA + path, { ...opt, headers: { 'X-API-Key': RAMA_API_KEY, 'Content-Type': 'application/json' } }).then(r => r.json());

let notify = async () => {}; // diisi saat bot Telegram aktif
const nameOf = p => PRODUCTS[p]?.name || p;

// Dipanggil sekali saat pembayaran terkonfirmasi: kabari admin (Telegram) berikut kode klaim pembeli.
// Pembuatan panel/VPS otomatis belum ada; untuk itu admin memproses manual lewat notifikasi ini.
async function fulfill(o) {
  console.log('PAID', o.id, o.product, o.variant, o.email, o.claim_code);
  await notify(`Pesanan dibayar\n${nameOf(o.product)} · ${o.variant}\nEmail: ${o.email}\nKode klaim: ${o.claim_code}\n` +
    `Cek di bot: /cek ${o.claim_code}`);
}

// Isi kiriman saat pembeli klaim. File script ditaruh di private/scripts/ (lihat README di sana).
function deliveryFor(o) {
  const files = []; let manual = false;
  let text = `Pembayaran pesananmu dikonfirmasi: ${nameOf(o.product)} (${o.variant}).`;
  if (o.product === 'otp' || o.product === 'auto') {
    const f = path.join(__dirname, 'private', 'scripts', `${o.product}-${o.variant.toLowerCase().replace(/\s+/g, '-')}.zip`);
    if (fs.existsSync(f)) { files.push(f); text += '\nFile script ada di bawah ini.'; }
    else { manual = true; text += '\nFile script akan dikirim admin secara manual.'; }
    if (o.variant === 'Full update' && UPDATE_GROUP_LINK) text += `\nGabung grup update: ${UPDATE_GROUP_LINK}`;
  } else {
    manual = true;
    text += '\nAdmin akan mengirim detail akses dan memprosesnya lewat chat ini dalam waktu dekat.';
  }
  return { text, files, manual };
}

// Klaim sekali pakai; update atomik jadi kode yang sama tidak bisa dipakai dua kali.
function claim(code, via) {
  const o = q.byCode.get(code);
  if (!o) return { ok: false, message: 'Kode tidak ditemukan. Periksa lagi kodenya.' };
  if (o.status !== 'paid') return { ok: false, message: 'Pembayaran untuk kode ini belum terkonfirmasi.' };
  if (!q.claim.run(Date.now(), via, code).changes)
    return { ok: false, message: 'Kode ini sudah pernah diklaim. Hubungi admin jika ada masalah.' };
  return { ok: true, order: o, delivery: deliveryFor(o) };
}

// ---------- Server ----------
const app = express();
app.use(express.json(), cookie());
app.use(express.static('public'));

const EMAIL = /^\S+@\S+\.\S+$/;
const session = (res, email) => res.cookie('sid', jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' }),
  { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 });

app.post('/api/auth/register', async (req, res) => {
  const { name = '', email = '', password = '' } = req.body || {};
  const e = String(email).trim().toLowerCase(), n = String(name).trim().slice(0, 60);
  if (!n) return res.status(400).json({ success: false, message: 'Isi nama dulu.' });
  if (!EMAIL.test(e)) return res.status(400).json({ success: false, message: 'Email tidak valid.' });
  if (String(password).length < 6) return res.status(400).json({ success: false, message: 'Password minimal 6 karakter.' });
  if (q.user.get(e)) return res.status(409).json({ success: false, message: 'Email sudah terdaftar. Silakan masuk.' });
  q.addUser.run(e, n, await bcrypt.hash(String(password), 10), Date.now());
  session(res, e);
  res.json({ success: true, data: { name: n, email: e } });
});

app.post('/api/auth/login', async (req, res) => {
  const e = String(req.body?.email || '').trim().toLowerCase(), u = q.user.get(e);
  if (!u || !(await bcrypt.compare(String(req.body?.password || ''), u.hash)))
    return res.status(401).json({ success: false, message: 'Email atau password salah.' });
  session(res, e);
  res.json({ success: true, data: { name: u.name, email: e } });
});

app.post('/api/orders', async (req, res) => {
  const { product, variant, email, code } = req.body || {};
  const price = PRODUCTS[product]?.vars[variant];
  if (!price) return res.status(400).json({ success: false, message: 'Produk tidak valid.' });
  if (!EMAIL.test(email || '')) return res.status(400).json({ success: false, message: 'Email tidak valid.' });
  const amount = Math.max(100, Math.round(price * (1 - (CODES[String(code || '').toUpperCase()] || 0))));
  try {
    const j = await rama('/deposit/create', { method: 'POST', body: JSON.stringify({ amount, method: 'qris' }) });
    if (!j.success) return res.status(502).json({ success: false, message: 'Gagal membuat QRIS, coba lagi.' });
    const id = crypto.randomUUID();
    q.addOrder.run(id, product, variant, String(email).trim().toLowerCase(), amount, j.data.depositId, Date.now());
    res.json({ success: true, data: { orderId: id, totalAmount: j.data.totalAmount, qrImage: j.data.qrImage, expiredAt: j.data.expiredAt } });
  } catch { res.status(502).json({ success: false, message: 'Payment gateway tidak merespons.' }); }
});

app.get('/api/orders/:id', async (req, res) => {
  let o = q.order.get(req.params.id);
  if (!o) return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan.' });
  if (o.status === 'pending' && Date.now() - o.checked_at > 10000) { // Rama membatasi cek ~10 detik
    q.touch.run(Date.now(), o.id);
    try {
      const s = (await rama('/deposit/status/' + encodeURIComponent(o.deposit_id))).data?.status;
      if (s === 'success' || s === 'already') {
        if (q.markPaid.run(newCode(), o.id).changes) await fulfill(q.order.get(o.id)); // changes=1 hanya sekali, jadi tidak diproses dobel
      } else if (s === 'expired') q.markExpired.run(o.id);
    } catch {}
    o = q.order.get(o.id);
  }
  const data = { status: o.status };
  if (o.status === 'paid') {
    const bot = (TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''), wa = (ADMIN_WA_NUMBER || '').replace(/\D/g, '');
    data.claim = {
      code: o.claim_code,
      tg: bot ? `https://t.me/${bot}?start=${o.claim_code}` : '',
      wa: wa ? `https://wa.me/${wa}?text=${encodeURIComponent('Halo, saya mau klaim pesanan. Kode: ' + o.claim_code)}` : '',
    };
  }
  res.json({ success: true, data });
});

if (TELEGRAM_BOT_TOKEN) {
  ({ notify } = startBot({ token: TELEGRAM_BOT_TOKEN, adminId: ADMIN_TELEGRAM_ID, find: c => q.byCode.get(c),
    claim, unclaim: c => q.unclaim.run(c), nameOf }));
} else console.log('Bot Telegram nonaktif (isi TELEGRAM_BOT_TOKEN di .env untuk mengaktifkan klaim via Telegram)');

app.listen(PORT, () => console.log('Fanz Digital jalan di http://localhost:' + PORT));
