// Bot Telegram untuk klaim produk. Long polling lewat fetch bawaan Node 18+, tanpa library tambahan.
const fs = require('fs'), path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CODE = /FD-[A-HJ-NP-Z2-9]{8}/i;

module.exports = function startBot({ token, adminId, find, claim, unclaim, nameOf }) {
  const base = `https://api.telegram.org/bot${token}`;
  const api = (m, body) => fetch(`${base}/${m}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());
  const send = (chat, text) => api('sendMessage', { chat_id: chat, text, disable_web_page_preview: true });
  async function sendFile(chat, file) {
    const fd = new FormData();
    fd.append('chat_id', String(chat));
    fd.append('document', new Blob([fs.readFileSync(file)]), path.basename(file));
    const r = await (await fetch(`${base}/sendDocument`, { method: 'POST', body: fd })).json();
    if (!r.ok) throw new Error(r.description || 'gagal kirim file');
  }
  const notify = text => (adminId ? send(adminId, text).catch(() => {}) : Promise.resolve());

  // batasi tebak-tebakan kode: maksimal 5 gagal per 10 menit per chat
  const fails = new Map(), recent = c => (fails.get(c) || []).filter(t => Date.now() - t < 6e5);
  const blocked = c => recent(c).length >= 5;
  const fail = c => fails.set(c, [...recent(c), Date.now()]);

  async function admin(chat, text) {
    const code = (text.match(CODE) || [])[0]?.toUpperCase();
    if (!code) return send(chat, 'Format: /cek FD-XXXXXXXX atau /selesai FD-XXXXXXXX');
    const o = find(code);
    if (!o) return send(chat, 'Kode tidak ditemukan.');
    if (/^\/cek/i.test(text)) {
      return send(chat, `Pesanan ${code}\nProduk: ${nameOf(o.product)} · ${o.variant}\nEmail: ${o.email}\nStatus: ${o.status}\n` +
        `Klaim: ${o.claimed_at ? 'sudah (via ' + o.claimed_via + ')' : 'belum'}`);
    }
    const r = claim(code, 'whatsapp'); // /selesai: tandai sudah dikirim manual lewat WhatsApp
    return send(chat, r.ok ? `Pesanan ${code} ditandai selesai (klaim via WhatsApp).` : r.message);
  }

  async function onMessage(m) {
    if (m.chat.type !== 'private') return;
    const chat = m.chat.id, text = (m.text || '').trim();
    if (String(chat) === String(adminId) && /^\/(cek|selesai)\b/i.test(text)) return admin(chat, text);
    const code = (text.match(CODE) || [])[0]?.toUpperCase();
    if (!code) return send(chat, 'Halo! Kirim kode klaim pesananmu untuk mengambil produk. Formatnya FD-XXXXXXXX.');
    if (blocked(chat)) return send(chat, 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.');

    const res = claim(code, 'telegram');
    if (!res.ok) { fail(chat); return send(chat, res.message); }
    try {
      await send(chat, res.delivery.text);
      for (const f of res.delivery.files) await sendFile(chat, f);
    } catch (e) {
      unclaim(code); // kode tetap aktif kalau pengiriman gagal
      console.error('kirim klaim gagal:', e.message);
      return send(chat, 'Maaf, pengiriman gagal. Kodemu masih aktif, coba kirim lagi sebentar lagi.');
    }
    const who = m.from?.username ? '@' + m.from.username : `${m.from?.first_name || 'pembeli'} (id ${chat})`;
    notify(`Klaim ${code}: ${nameOf(res.order.product)} · ${res.order.variant}\nOleh ${who} via Telegram\n` +
      (res.delivery.manual ? 'Perlu diproses manual, hubungi pembeli.' : 'Terkirim otomatis.'));
  }

  (async function loop() {
    try { const me = await api('getMe', {}); console.log('Bot Telegram aktif:', me.ok ? '@' + me.result.username : me.description); } catch {}
    let offset = 0;
    for (;;) {
      try {
        const r = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
        if (!r.ok) { console.error('getUpdates:', r.description); await sleep(5000); continue; }
        for (const u of r.result) {
          offset = u.update_id + 1;
          if (u.message) onMessage(u.message).catch(e => console.error('bot:', e.message));
        }
      } catch { await sleep(5000); }
    }
  })();

  return { notify };
};
