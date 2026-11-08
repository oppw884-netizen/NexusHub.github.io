'use strict';
/* =========================================================================
   HI GARDEN — ไฟล์เดียวจบ (Website + Donation System + Admin + Discord Bot)

   วิธีใช้
     1) npm i express helmet express-rate-limit cookie-parser multer bcryptjs jsonwebtoken better-sqlite3 dotenv
     2) สร้างไฟล์ .env (ดูตัวอย่างท้ายคอมเมนต์นี้)
     3) node server.js     →  เปิด http://localhost:3000   (แอดมินที่ /admin, โดเนทที่ /donate)
     (ต้องใช้ Node.js >= 20)

   ตัวอย่าง .env
     PORT=3000
     NODE_ENV=production
     TRUST_PROXY=1                 # ใส่เมื่ออยู่หลัง Nginx/Cloudflare
     JWT_SECRET=                   # สุ่ม 32+ ตัวอักษร: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ADMIN_USERNAME=               # แอดมินคนแรก (สร้างครั้งเดียว)
     ADMIN_PASSWORD=               # >= 10 ตัวอักษร
     DISCORD_BOT_TOKEN=            # ฝั่งเซิร์ฟเวอร์เท่านั้น ห้ามใส่ในหน้าเว็บ
     DISCORD_GUILD_ID=
     DISCORD_STAFF_CHANNEL_ID=     # ห้องแจ้งทีมงานเมื่อมีรายการใหม่
     DISCORD_ANNOUNCE_CHANNEL_ID=  # ห้องประกาศผู้สนับสนุน
     # DATA_DIR=/var/data/higarden # ที่เก็บฐานข้อมูล + หลักฐาน (ค่าเริ่มต้น ./data)

   Discord Bot ต้องมีสิทธิ์ Manage Roles, Send Messages, Embed Links และยศบอทต้องอยู่เหนือยศ Donator
   ========================================================================= */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

/* =========================================================
   1) DATABASE (SQLite)
   ========================================================= */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'higarden.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#00d4ff',
  perks TEXT NOT NULL DEFAULT '[]',
  discord_role_id TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  instructions TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS supporters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  discord_id TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,
  status_token TEXT NOT NULL UNIQUE,
  supporter_id INTEGER NOT NULL REFERENCES supporters(id),
  package_id INTEGER REFERENCES packages(id),
  method_id INTEGER REFERENCES payment_methods(id),
  claimed_amount REAL NOT NULL DEFAULT 0,
  verified_amount REAL,
  reference TEXT NOT NULL DEFAULT '',
  proof_file TEXT NOT NULL DEFAULT '',
  proof_hash TEXT UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reject_reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'web',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  role_status TEXT NOT NULL DEFAULT '',
  notify_status TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
CREATE INDEX IF NOT EXISTS idx_donations_supporter ON donations(supporter_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_donations_reference
  ON donations(method_id, reference) WHERE reference <> '' AND status <> 'rejected';

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* ---------- Seed (config only — never donation amounts or supporters) ---------- */
const hasPackages = db.prepare('SELECT COUNT(*) c FROM packages').get().c;
if (!hasPackages) {
  const ins = db.prepare('INSERT INTO packages (name,emoji,description,price,color,perks,sort_order) VALUES (?,?,?,?,?,?,?)');
  ins.run('Supporter', '🌱', 'ผู้สนับสนุนทั่วไป', 0, '#4ade80', JSON.stringify(['ยศ Supporter ใน Discord', 'ชื่อในหน้า Supporters']), 1);
  ins.run('Donator', '💎', 'ผู้สนับสนุน', 0, '#00d4ff', JSON.stringify(['ยศ Donator ใน Discord', 'ชื่อในหน้า Supporters']), 2);
  ins.run('Premium Donator', '👑', 'ผู้สนับสนุนระดับสูง', 0, '#a78bfa', JSON.stringify(['ยศ Premium Donator ใน Discord', 'ชื่อในหน้า Supporters']), 3);
  ins.run('Legendary Supporter', '🏆', 'ผู้สนับสนุนพิเศษ', 0, '#fbbf24', JSON.stringify(['ยศ Legendary Supporter ใน Discord', 'ชื่อในหน้า Supporters']), 4);
}
const hasMethods = db.prepare('SELECT COUNT(*) c FROM payment_methods').get().c;
if (!hasMethods) {
  const ins = db.prepare('INSERT INTO payment_methods (name,kind,instructions,link,sort_order) VALUES (?,?,?,?,?)');
  ins.run('Roblox', 'roblox', 'สนับสนุนผ่านเกม HI Garden บน Roblox แล้วแนบภาพหลักฐานการซื้อ', 'https://www.roblox.com/games/84130588253982/HI-Garden', 1);
  ins.run('Discord Server Boost', 'boost', 'บูสต์เซิร์ฟเวอร์ HI GARDEN บน Discord แล้วแนบภาพหลักฐาน', 'https://dc.gg/higarden', 2);
}
const defaults = { goal_title: 'Donation Goal', goal_amount: '0', currency: '฿' };
const insSet = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(defaults)) insSet.run(k, v);

const getSetting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const audit = (admin, action, target = '', detail = '') =>
  db.prepare('INSERT INTO audit_log (admin,action,target,detail) VALUES (?,?,?,?)').run(admin, action, String(target), String(detail).slice(0, 500));

/* =========================================================
   2) DISCORD (server-side only)
   ========================================================= */
const discord = (() => {
  /* Discord integration — runs ONLY on the server. Token never reaches the browser. */
  const API = 'https://discord.com/api/v10';
  const NO_MENTIONS = { parse: [] };

  const cfg = () => ({
    token: process.env.DISCORD_BOT_TOKEN || '',
    guild: process.env.DISCORD_GUILD_ID || '',
    staffCh: process.env.DISCORD_STAFF_CHANNEL_ID || '',
    announceCh: process.env.DISCORD_ANNOUNCE_CHANNEL_ID || ''
  });
  const enabled = () => { const c = cfg(); return !!(c.token && c.guild); };

  async function call(method, route, body) {
    const { token } = cfg();
    const res = await fetch(API + route, {
      method,
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'HIGardenBackend (higarden, 1.0)' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await new Promise(r => setTimeout(r, Math.min((j.retry_after || 1) * 1000, 5000)));
      return call(method, route, body);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Discord ${res.status}: ${t.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  const clip = (s, n) => String(s ?? '').slice(0, n);
  const money = (n, cur) => `${Number(n).toLocaleString('en-US')} ${cur}`;

  /* Find guild member by Discord User ID, or by username search */
  async function findMember({ discordId, username }) {
    const { guild } = cfg();
    if (/^\d{15,25}$/.test(discordId || '')) {
      try { return await call('GET', `/guilds/${guild}/members/${discordId}`); } catch { /* fall through */ }
    }
    if (username) {
      const clean = username.replace(/^@/, '').split('#')[0];
      const list = await call('GET', `/guilds/${guild}/members/search?query=${encodeURIComponent(clean)}&limit=5`);
      const exact = list.find(m => m.user.username.toLowerCase() === clean.toLowerCase());
      return exact || null;
    }
    return null;
  }

  const avatarUrl = user => user?.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : '';

  /* New submission → notify staff */
  async function notifyStaffNewDonation(d) {
    const { staffCh } = cfg();
    if (!enabled() || !staffCh) return 'skipped';
    await call('POST', `/channels/${staffCh}/messages`, {
      allowed_mentions: NO_MENTIONS,
      embeds: [{
        title: '🔔 มีรายการสนับสนุนใหม่รอตรวจสอบ',
        color: 0x00d4ff,
        fields: [
          { name: 'ผู้สนับสนุน', value: clip(d.username, 100), inline: true },
          { name: 'แพ็กเกจ', value: clip(d.package_name || '-', 100), inline: true },
          { name: 'ช่องทาง', value: clip(d.method_name || '-', 100), inline: true },
          { name: 'ยอดที่แจ้ง', value: money(d.claimed_amount, d.currency), inline: true },
          { name: 'รายการ #', value: String(d.id), inline: true }
        ],
        footer: { text: 'ตรวจสอบและอนุมัติที่ Admin Dashboard' },
        timestamp: new Date().toISOString()
      }]
    });
    return 'sent';
  }

  /* Approved → give role, announce. Returns { role_status, notify_status, discord_id, avatar_url } */
  async function onApproved(d) {
    const out = { role_status: 'skipped', notify_status: 'skipped', discord_id: d.discord_id || '', avatar_url: d.avatar_url || '' };
    if (!enabled()) return out;
    const { guild, announceCh } = cfg();

    try {
      const member = await findMember({ discordId: d.discord_id, username: d.username });
      if (!member) {
        out.role_status = 'member-not-found';
      } else {
        out.discord_id = member.user.id;
        out.avatar_url = avatarUrl(member.user) || out.avatar_url;
        if (d.role_id) {
          await call('PUT', `/guilds/${guild}/members/${member.user.id}/roles/${d.role_id}`);
          out.role_status = 'granted';
        } else out.role_status = 'no-role-configured';
      }
    } catch (e) {
      out.role_status = 'error: ' + clip(e.message, 120);
    }

    try {
      if (announceCh) {
        const who = d.public ? (out.discord_id ? `<@${out.discord_id}>` : clip(d.username, 80)) : 'ผู้สนับสนุนท่านหนึ่ง';
        await call('POST', `/channels/${announceCh}/messages`, {
          allowed_mentions: out.discord_id && d.public ? { users: [out.discord_id] } : NO_MENTIONS,
          embeds: [{
            title: '💎 ขอบคุณที่สนับสนุน HI GARDEN!',
            description: `${who} ได้รับการอนุมัติเป็น **${clip(d.package_name || 'Supporter', 60)}** แล้ว`,
            color: 0x1556ff,
            timestamp: new Date().toISOString()
          }]
        });
        out.notify_status = 'sent';
      }
    } catch (e) {
      out.notify_status = 'error: ' + clip(e.message, 120);
    }
    return out;
  }

  return { enabled, notifyStaffNewDonation, onApproved };
})();

/* =========================================================
   3) FRONTEND ASSETS (ฝังไว้ในไฟล์นี้ — แก้หน้าเว็บ/CSS/JS ได้ตรงนี้เลย)
   ========================================================= */
const ASSETS = {
  "index.html": { type: 'text/html; charset=utf-8', body: `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HI GARDEN — Discord Community & Roblox Game</title>
  <meta name="description" content="HI GARDEN ชุมชน Discord และเกม Roblox สุดล้ำ เข้าร่วมเพื่อเล่นเกม ร่วมกิจกรรม และรับ Giveaways กับเพื่อนๆ">
  <meta name="theme-color" content="#04060f">
  <link rel="canonical" href="https://YOUR-DOMAIN.com/">
  <meta property="og:type" content="website">
  <meta property="og:title" content="HI GARDEN — Discord Community & Roblox Game">
  <meta property="og:description" content="เข้าร่วมชุมชน HI GARDEN และเล่นเกมบน Roblox ได้เลย">
  <meta property="og:url" content="https://YOUR-DOMAIN.com/">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%2304060f'/%3E%3Ctext x='50' y='66' font-size='54' font-weight='900' text-anchor='middle' fill='%2300d4ff' font-family='Arial'%3EHG%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Kanit:wght@300;400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="style.css">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Organization","name":"HI GARDEN","sameAs":["https://dc.gg/higarden","https://www.roblox.com/games/84130588253982/HI-Garden"]}
  </script>
</head>
<body>
  <!-- Loader -->
  <div id="loader" aria-hidden="true">
    <div class="loader-logo">HI <span>GARDEN</span></div>
    <div class="loader-bar"><i></i></div>
  </div>

  <canvas id="particles" aria-hidden="true"></canvas>
  <div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="grid-bg" aria-hidden="true"></div>
  <div id="cursor" aria-hidden="true"></div>
  <div id="cursor-dot" aria-hidden="true"></div>

  <!-- Navbar -->
  <header class="nav" id="nav">
    <a href="#home" class="brand">HI <span>GARDEN</span></a>
    <button class="burger" id="burger" aria-label="เปิดเมนู" aria-expanded="false"><i></i><i></i><i></i></button>
    <nav class="links" id="links">
      <a href="#home">Home</a>
      <a href="#about">About</a>
      <a href="#features">Features</a>
      <a href="#team">Team</a>
      <a href="#support">Support</a>
      <a href="https://dc.gg/higarden" target="_blank" rel="noopener" class="btn btn-sm">Discord</a>
    </nav>
  </header>

  <main>
    <!-- 1. Home -->
    <section class="hero" id="home">
      <div class="hero-inner">
        <p class="eyebrow reveal">// WELCOME TO THE FUTURE OF PLAY</p>
        <h1 class="logo reveal">HI <span>GARDEN</span></h1>
        <p class="tagline reveal">ชุมชนเกมเมอร์สายล้ำ ที่ซึ่งทุกคนคือส่วนหนึ่งของสวน<br>เข้ามาเล่น เข้ามาคุย แล้วเติบโตไปด้วยกัน</p>
        <div class="cta reveal">
          <a class="btn" href="https://dc.gg/higarden" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.2.5a18.3 18.3 0 0 0-6.4 0L8.6 3a19.8 19.8 0 0 0-4.9 1.4C.6 9 0 13.5.3 18a19.9 19.9 0 0 0 6 3l.8-1.3c-.8-.3-1.6-.7-2.3-1.200l.5-.4a14.200 14.200 0 0 0 12.200 0l.5.400c-.7.500-1.500.900-2.300 1.200l.8 1.300a19.900 19.900 0 0 0 6-3c.4-5.200-.7-9.700-3.400-13.600zM8.500 15.300c-1.200 0-2.100-1.100-2.100-2.400s.9-2.400 2.100-2.400 2.100 1.100 2.100 2.400-.9 2.400-2.100 2.400zm7 0c-1.200 0-2.100-1.100-2.100-2.400s.9-2.400 2.100-2.400 2.100 1.100 2.100 2.400-.9 2.400-2.100 2.400z"/></svg>
            JOIN DISCORD
          </a>
          <a class="btn btn-ghost" href="https://www.roblox.com/games/84130588253982/HI-Garden" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M5 2 2 19l17 3 3-17L5 2zm7.600 11.600-3.700-.7.7-3.700 3.700.7-.7 3.700z"/></svg>
            PLAY ROBLOX
          </a>
        </div>
        <!-- Live stats: shown only when real data loads -->
        <div class="stats reveal" id="stats" hidden>
          <div class="stat" id="stat-members" hidden><b data-count>0</b><span>Discord Members</span></div>
          <div class="stat" id="stat-online" hidden><b data-count>0</b><span>Online on Discord</span></div>
          <div class="stat" id="stat-playing" hidden><b data-count>0</b><span>Playing Now</span></div>
          <div class="stat" id="stat-visits" hidden><b data-count>0</b><span>Game Visits</span></div>
        </div>
      </div>
      <a href="#about" class="scroll-hint" aria-label="เลื่อนลง"><i></i></a>
    </section>

    <!-- About -->
    <section id="about" class="section">
      <div class="container two-col">
        <div class="reveal">
          <p class="eyebrow">// ABOUT</p>
          <h2>เกี่ยวกับ <span class="neon">HI GARDEN</span></h2>
          <p class="lead">HI GARDEN คือชุมชนบน Discord และเกมบน Roblox ที่สร้างขึ้นเพื่อให้ผู้เล่นได้มาสนุกด้วยกัน พูดคุย แลกเปลี่ยน และร่วมกิจกรรมสุดพิเศษอย่างต่อเนื่อง</p>
          <p class="lead">ไม่ว่าคุณจะเป็นผู้เล่นหน้าใหม่หรือสายเก๋า ที่นี่มีที่ให้คุณเสมอ</p>
        </div>
        <div class="glass about-card reveal">
          <div class="about-row"><span class="dot"></span><div><h3>Friendly Community</h3><p>บรรยากาศเป็นกันเอง ทีมงานดูแลใกล้ชิด</p></div></div>
          <div class="about-row"><span class="dot"></span><div><h3>Always Evolving</h3><p>อัปเดตเกมและกิจกรรมใหม่ๆ อย่างสม่ำเสมอ</p></div></div>
          <div class="about-row"><span class="dot"></span><div><h3>Play Together</h3><p>หาเพื่อนเล่น ตั้งปาร์ตี้ และสนุกไปด้วยกัน</p></div></div>
        </div>
      </div>
    </section>

    <!-- 3. Features -->
    <section id="features" class="section">
      <div class="container">
        <div class="section-head reveal">
          <p class="eyebrow">// FEATURES</p>
          <h2>ทำไมต้อง <span class="neon">HI GARDEN</span></h2>
        </div>
        <div class="cards">
          <article class="card glass tilt reveal"><div class="icon">💬</div><h3>Community</h3><p>พูดคุย แชร์เรื่องราว และทำความรู้จักเพื่อนใหม่ในชุมชนที่อบอุ่น</p></article>
          <article class="card glass tilt reveal"><div class="icon">🎮</div><h3>Gaming</h3><p>เล่นเกม HI Garden บน Roblox พร้อมเพื่อนๆ และรับอัปเดตใหม่ๆ ก่อนใคร</p></article>
          <article class="card glass tilt reveal"><div class="icon">🎉</div><h3>Events</h3><p>กิจกรรมและอีเวนต์สุดสนุกที่จัดขึ้นเป็นประจำ พร้อมรางวัลมากมาย</p></article>
          <article class="card glass tilt reveal"><div class="icon">🛟</div><h3>Support</h3><p>ทีมงานพร้อมช่วยเหลือทุกปัญหา ตอบเร็ว ดูแลทุกคนอย่างเท่าเทียม</p></article>
          <article class="card glass tilt reveal"><div class="icon">🎁</div><h3>Giveaways</h3><p>ลุ้นรับของรางวัลพิเศษจากกิจกรรมแจกของในเซิร์ฟเวอร์</p></article>
        </div>
      </div>
    </section>

    <!-- 6. Roblox -->
    <section id="game" class="section">
      <div class="container">
        <div class="section-head reveal">
          <p class="eyebrow">// THE GAME</p>
          <h2>HI <span class="neon">GARDEN</span> on Roblox</h2>
        </div>
        <div class="game glass reveal">
          <div class="thumb" id="game-thumb">
            <img id="game-img" alt="HI Garden game thumbnail" hidden width="512" height="512">
            <div class="thumb-fallback" id="thumb-fallback">HI<br><span>GARDEN</span></div>
          </div>
          <div class="game-info">
            <h3 id="game-title">HI Garden</h3>
            <p>เข้าสู่โลกของ HI Garden บน Roblox สำรวจ เล่น และสนุกไปกับเพื่อนๆ ในชุมชน คลิกปุ่มด้านล่างเพื่อเริ่มเล่นได้ทันที</p>
            <ul class="game-meta" id="game-meta"></ul>
            <div class="cta left">
              <a class="btn" href="https://www.roblox.com/games/84130588253982/HI-Garden" target="_blank" rel="noopener">PLAY NOW</a>
              <a class="btn btn-ghost" href="https://www.roblox.com/games/84130588253982/HI-Garden" target="_blank" rel="noopener">Game Page ↗</a>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 4. Team -->
    <section id="team" class="section">
      <div class="container">
        <div class="section-head reveal">
          <p class="eyebrow">// STAFF TEAM</p>
          <h2>ทีมงาน <span class="neon">HI GARDEN</span></h2>
        </div>
        <div class="team" id="team-grid"></div>
      </div>
    </section>

    <!-- 5. Support / Donator -->
    <section id="support" class="section">
      <div class="container">
        <div class="section-head reveal">
          <p class="eyebrow">// SUPPORT & DONATOR</p>
          <h2>สนับสนุน <span class="neon">HI GARDEN</span></h2>
          <p class="lead center">ทุกการสนับสนุนช่วยให้เราพัฒนาเกมและชุมชนต่อไปได้</p>
        </div>
        <div class="support-grid">
          <div class="glass perks reveal">
            <h3>สิทธิพิเศษของ Donator</h3>
            <ul id="perks-list"></ul>
            <a class="btn" id="support-btn" href="/donate">SUPPORT US</a>
          </div>
          <div class="glass donors reveal">
            <h3>ผู้สนับสนุน</h3>
            <div id="donor-list"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="section final">
      <div class="container center reveal">
        <h2>พร้อมจะ <span class="neon">เติบโต</span> ไปกับเราหรือยัง?</h2>
        <div class="cta">
          <a class="btn" href="https://dc.gg/higarden" target="_blank" rel="noopener">JOIN DISCORD</a>
          <a class="btn btn-ghost" href="https://www.roblox.com/games/84130588253982/HI-Garden" target="_blank" rel="noopener">PLAY ROBLOX</a>
        </div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="brand">HI <span>GARDEN</span></div>
    <div class="foot-links">
      <a href="/donate">Donate</a>
      <a href="https://dc.gg/higarden" target="_blank" rel="noopener">Discord</a>
      <a href="https://www.roblox.com/games/84130588253982/HI-Garden" target="_blank" rel="noopener">Roblox</a>
    </div>
    <p>© <span id="year"></span> HI GARDEN. All rights reserved. ไม่ได้เกี่ยวข้องกับ Roblox Corporation</p>
  </footer>

  <script src="main.js" defer></script>
</body>
</html>
` },
  "donate.html": { type: 'text/html; charset=utf-8', body: `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Support HI GARDEN — Donation & Supporters</title>
  <meta name="description" content="สนับสนุน HI GARDEN รับยศ Donator สิทธิพิเศษ และขึ้นแท่นอันดับ Supporters">
  <meta name="theme-color" content="#04060f">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%2304060f'/%3E%3Ctext x='50' y='66' font-size='54' font-weight='900' text-anchor='middle' fill='%2300d4ff' font-family='Arial'%3EHG%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Kanit:wght@300;400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/donate.css">
</head>
<body>
  <div id="loader" aria-hidden="true">
    <div class="loader-logo">HI <span>GARDEN</span></div>
    <div class="loader-bar"><i></i></div>
  </div>

  <canvas id="particles" aria-hidden="true"></canvas>
  <canvas id="fx" aria-hidden="true"></canvas>
  <div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="grid-bg" aria-hidden="true"></div>
  <div id="cursor" aria-hidden="true"></div>
  <div id="cursor-dot" aria-hidden="true"></div>

  <header class="nav" id="nav">
    <a href="/#home" class="brand">HI <span>GARDEN</span></a>
    <button class="burger" id="burger" aria-label="เปิดเมนู" aria-expanded="false"><i></i><i></i><i></i></button>
    <nav class="links" id="links">
      <a href="/#home">Home</a>
      <a href="/#about">About</a>
      <a href="/#features">Features</a>
      <a href="/#team">Team</a>
      <a href="/donate" class="active">Support</a>
      <a href="https://dc.gg/higarden" target="_blank" rel="noopener" class="btn btn-sm">Discord</a>
    </nav>
  </header>

  <button id="sound-toggle" class="sound" aria-pressed="true" title="เปิด/ปิดเสียงและเอฟเฟกต์">🔊</button>
  <div id="toasts" aria-live="polite"></div>

  <main>
    <!-- Hero + totals -->
    <section class="d-hero">
      <p class="eyebrow reveal">// SUPPORT & DONATION</p>
      <h1 class="d-title reveal">SUPPORT <span class="neon">HI GARDEN</span></h1>
      <p class="tagline reveal">ทุกการสนับสนุนช่วยให้เราพัฒนาเกมและชุมชนต่อไป รับยศ สิทธิพิเศษ และชื่อของคุณบนอันดับ Supporters</p>

      <div class="totals glass reveal" id="totals">
        <div class="t-item"><b id="t-total">—</b><span>ยอดสนับสนุนทั้งหมด</span></div>
        <div class="t-item"><b id="t-supporters">—</b><span>ผู้สนับสนุน</span></div>
        <div class="goal" id="goal" hidden>
          <div class="goal-top"><span id="goal-title">Donation Goal</span><span id="goal-text"></span></div>
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="goal-bar"><i id="goal-fill"></i></div>
        </div>
      </div>
      <a href="#donate-form" class="btn reveal">สนับสนุนเลย</a>
    </section>

    <!-- Packages -->
    <section class="section" id="packages">
      <div class="container">
        <div class="section-head reveal"><p class="eyebrow">// PACKAGES</p><h2>เลือก <span class="neon">แพ็กเกจ</span></h2></div>
        <div class="pkgs" id="pkg-grid"><p class="muted center">กำลังโหลด…</p></div>
      </div>
    </section>

    <!-- Methods + Form -->
    <section class="section" id="donate-form">
      <div class="container">
        <div class="section-head reveal"><p class="eyebrow">// HOW TO SUPPORT</p><h2>ส่ง <span class="neon">หลักฐานการสนับสนุน</span></h2>
          <p class="lead center">สนับสนุนผ่านช่องทางด้านล่าง แล้วส่งหลักฐานให้ทีมงานตรวจสอบ เมื่ออนุมัติแล้วระบบจะมอบยศใน Discord ให้อัตโนมัติ</p></div>

        <div class="form-grid">
          <div class="glass methods reveal">
            <h3>ช่องทางการสนับสนุน</h3>
            <div id="method-list"></div>
          </div>

          <form class="glass dform reveal" id="dform" novalidate>
            <h3>แบบฟอร์มแจ้งการสนับสนุน</h3>
            <label>Discord Username *
              <input name="username" required maxlength="40" autocomplete="off" placeholder="เช่น higarden_user">
            </label>
            <label>Discord User ID <small>(ไม่บังคับ — ช่วยให้มอบยศได้แม่นยำ)</small>
              <input name="discord_id" inputmode="numeric" maxlength="25" autocomplete="off" placeholder="ตัวเลข 17–19 หลัก">
            </label>
            <div class="row2">
              <label>แพ็กเกจ *
                <select name="package_id" id="f-package" required></select>
              </label>
              <label>ช่องทาง *
                <select name="method_id" id="f-method" required></select>
              </label>
            </div>
            <label id="amount-wrap">ยอดที่สนับสนุน <small id="amount-hint"></small>
              <input name="amount" id="f-amount" type="number" min="0" step="0.01" placeholder="0">
            </label>
            <label>เลขอ้างอิงรายการ <small>(ไม่บังคับ)</small>
              <input name="reference" maxlength="80" autocomplete="off">
            </label>
            <label>ภาพหลักฐาน * <small>(JPG/PNG/WEBP/GIF ไม่เกิน 5MB)</small>
              <input name="proof" id="f-proof" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required>
            </label>
            <img id="proof-preview" alt="ตัวอย่างหลักฐาน" hidden>
            <label>หมายเหตุ <small>(ไม่บังคับ)</small>
              <textarea name="note" maxlength="300" rows="2"></textarea>
            </label>
            <label class="check"><input type="checkbox" name="consent" value="1"> อนุญาตให้แสดงชื่อของฉันในหน้า Supporters และใน Discord</label>
            <p class="form-msg" id="form-msg" role="alert" hidden></p>
            <button class="btn" type="submit" id="submit-btn">ส่งรายการ</button>
            <p class="muted small">เราไม่เก็บข้อมูลบัตรเครดิต · ยอดและยศจะมีผลเมื่อทีมงานตรวจสอบและอนุมัติเท่านั้น</p>
          </form>
        </div>

        <div class="glass mystatus reveal" id="mystatus" hidden>
          <h3>สถานะรายการของฉัน <small>(บนอุปกรณ์นี้)</small></h3>
          <div id="status-list"></div>
        </div>
      </div>
    </section>

    <!-- Leaderboard -->
    <section class="section" id="leaderboard">
      <div class="container">
        <div class="section-head reveal"><p class="eyebrow">// LEADERBOARD</p><h2>Supporters <span class="neon">Leaderboard</span></h2></div>
        <div class="podium" id="podium"></div>
        <div class="glass board reveal" id="board" hidden>
          <table>
            <thead><tr><th>Rank</th><th>Supporter</th><th>Level</th><th class="r">Total</th></tr></thead>
            <tbody id="board-body"></tbody>
          </table>
        </div>
        <p class="muted center" id="board-empty" hidden>ยังไม่มีผู้สนับสนุนที่เปิดเผยชื่อ — เป็นคนแรกเลย! 💙</p>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="brand">HI <span>GARDEN</span></div>
    <div class="foot-links">
      <a href="/">Home</a>
      <a href="https://dc.gg/higarden" target="_blank" rel="noopener">Discord</a>
      <a href="https://www.roblox.com/games/84130588253982/HI-Garden" target="_blank" rel="noopener">Roblox</a>
    </div>
    <p>© <span id="year"></span> HI GARDEN. All rights reserved.</p>
  </footer>

  <script src="/main.js" defer></script>
  <script src="/donate.js" defer></script>
</body>
</html>
` },
  "admin.html": { type: 'text/html; charset=utf-8', body: `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>HI GARDEN — Admin</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%2304060f'/%3E%3Ctext x='50' y='66' font-size='54' font-weight='900' text-anchor='middle' fill='%2300d4ff' font-family='Arial'%3EHG%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Kanit:wght@300;400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="admin">
  <div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="grid-bg" aria-hidden="true"></div>

  <!-- Login -->
  <main id="login-view" class="login" hidden>
    <form class="glass login-card" id="login-form">
      <div class="brand">HI <span>GARDEN</span></div>
      <p class="muted">Admin Dashboard</p>
      <label>Username<input name="username" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="form-msg" id="login-msg" hidden></p>
      <button class="btn" type="submit">เข้าสู่ระบบ</button>
    </form>
  </main>

  <!-- App -->
  <div id="app-view" class="shell" hidden>
    <aside class="side">
      <div class="brand">HI <span>GARDEN</span></div>
      <nav id="tabs">
        <button data-tab="overview" class="on">📊 ภาพรวม</button>
        <button data-tab="donations">💎 รายการโดเนท <em id="pending-badge" hidden></em></button>
        <button data-tab="packages">📦 แพ็กเกจ</button>
        <button data-tab="methods">💳 ช่องทางชำระ</button>
        <button data-tab="supporters">👑 ผู้สนับสนุน</button>
        <button data-tab="settings">⚙️ ตั้งค่า</button>
        <button data-tab="audit">🕘 ประวัติ</button>
      </nav>
      <div class="side-foot"><span id="who" class="muted small"></span><button class="btn btn-ghost btn-sm" id="logout">ออกจากระบบ</button></div>
    </aside>
    <main class="content"><div id="view"></div></main>
  </div>

  <div id="modal" class="modal" hidden><div class="glass modal-box" id="modal-box"></div></div>
  <div id="toasts" aria-live="polite"></div>

  <script src="/admin.js" defer></script>
</body>
</html>
` },
  "style.css": { type: 'text/css; charset=utf-8', body: `:root{
  --bg:#04060f; --bg2:#070b1c; --navy:#0a1f5c; --blue:#1556ff; --neon:#00d4ff;
  --text:#e8f1ff; --muted:#8fa3c7; --glass:rgba(12,22,52,.55); --line:rgba(0,212,255,.22);
  --r:18px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;scroll-padding-top:80px}
body{background:var(--bg);color:var(--text);font-family:'Kanit',system-ui,sans-serif;line-height:1.65;overflow-x:hidden;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
ul{list-style:none}
img{max-width:100%;display:block}
.container{width:min(1140px,92%);margin-inline:auto}
.center{text-align:center}
.section{padding:110px 0;position:relative;z-index:2}
.neon{color:var(--neon);text-shadow:0 0 18px rgba(0,212,255,.65)}

/* Backgrounds */
#particles{position:fixed;inset:0;z-index:0;pointer-events:none}
.aurora{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.aurora i{position:absolute;width:55vmax;height:55vmax;border-radius:50%;filter:blur(110px);opacity:.28;animation:float 22s ease-in-out infinite}
.aurora i:nth-child(1){background:var(--blue);top:-20%;left:-10%}
.aurora i:nth-child(2){background:var(--neon);bottom:-30%;right:-15%;animation-delay:-8s;opacity:.18}
.aurora i:nth-child(3){background:var(--navy);top:30%;left:40%;animation-delay:-14s;opacity:.5}
@keyframes float{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(6vmax,4vmax) scale(1.15)}}
.grid-bg{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.35;
  background-image:linear-gradient(rgba(0,212,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,.06) 1px,transparent 1px);
  background-size:60px 60px;mask-image:radial-gradient(ellipse at center,#000 20%,transparent 75%)}

/* Loader */
#loader{position:fixed;inset:0;z-index:9999;background:var(--bg);display:grid;place-content:center;justify-items:center;gap:22px;transition:opacity .6s,visibility .6s}
#loader.done{opacity:0;visibility:hidden}
.loader-logo{font-family:'Orbitron',sans-serif;font-weight:900;font-size:clamp(28px,6vw,48px);letter-spacing:.12em;animation:pulse 1.4s ease-in-out infinite}
.loader-logo span,.brand span{color:var(--neon);text-shadow:0 0 16px var(--neon)}
.loader-bar{width:min(260px,70vw);height:3px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
.loader-bar i{display:block;height:100%;width:40%;background:linear-gradient(90deg,var(--blue),var(--neon));box-shadow:0 0 14px var(--neon);animation:load 1.1s ease-in-out infinite}
@keyframes load{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
@keyframes pulse{50%{opacity:.6}}

/* Cursor (desktop only) */
#cursor,#cursor-dot{display:none}
@media (hover:hover) and (pointer:fine){
  body.has-cursor,body.has-cursor a,body.has-cursor button{cursor:none}
  body.has-cursor #cursor,body.has-cursor #cursor-dot{display:block;position:fixed;top:0;left:0;pointer-events:none;z-index:10000;border-radius:50%}
  #cursor{width:36px;height:36px;border:1.5px solid var(--neon);margin:-18px 0 0 -18px;transition:width .2s,height .2s,margin .2s,background .2s;box-shadow:0 0 14px rgba(0,212,255,.5)}
  #cursor.hover{width:60px;height:60px;margin:-30px 0 0 -30px;background:rgba(0,212,255,.1)}
  #cursor-dot{width:6px;height:6px;margin:-3px 0 0 -3px;background:var(--neon);box-shadow:0 0 10px var(--neon)}
}

/* Nav */
.nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:16px 4%;transition:.3s}
.nav.scrolled{background:rgba(4,6,15,.75);backdrop-filter:blur(16px);border-bottom:1px solid var(--line);padding:10px 4%}
.brand{font-family:'Orbitron',sans-serif;font-weight:900;letter-spacing:.1em;font-size:20px}
.links{display:flex;align-items:center;gap:28px}
.links a:not(.btn){font-size:15px;color:var(--muted);position:relative;transition:color .2s}
.links a:not(.btn)::after{content:"";position:absolute;left:0;bottom:-4px;height:2px;width:0;background:var(--neon);box-shadow:0 0 8px var(--neon);transition:width .25s}
.links a:not(.btn):hover,.links a.active{color:#fff}
.links a:not(.btn):hover::after,.links a.active::after{width:100%}
.burger{display:none;background:none;border:0;width:32px;height:24px;position:relative}
.burger i{position:absolute;left:0;width:100%;height:2px;background:var(--neon);transition:.3s}
.burger i:nth-child(1){top:2px}.burger i:nth-child(2){top:11px}.burger i:nth-child(3){top:20px}
.burger[aria-expanded=true] i:nth-child(1){top:11px;transform:rotate(45deg)}
.burger[aria-expanded=true] i:nth-child(2){opacity:0}
.burger[aria-expanded=true] i:nth-child(3){top:11px;transform:rotate(-45deg)}

/* Buttons */
.btn{display:inline-flex;align-items:center;gap:10px;justify-content:center;padding:14px 30px;border-radius:12px;font-family:'Orbitron',sans-serif;font-weight:600;font-size:14px;letter-spacing:.08em;color:#02121c;background:linear-gradient(135deg,var(--neon),#4aa3ff);box-shadow:0 0 24px rgba(0,212,255,.45);border:1px solid transparent;transition:transform .2s,box-shadow .2s,background .2s;position:relative;overflow:hidden}
.btn:hover{transform:translateY(-3px);box-shadow:0 0 40px rgba(0,212,255,.8)}
.btn-ghost{background:rgba(0,212,255,.06);color:var(--text);border-color:var(--neon);box-shadow:inset 0 0 18px rgba(0,212,255,.12)}
.btn-ghost:hover{background:rgba(0,212,255,.18)}
.btn-sm{padding:9px 20px;font-size:12px}

/* Hero */
.hero{min-height:100svh;display:grid;place-items:center;text-align:center;position:relative;z-index:2;padding:120px 4% 80px}
.eyebrow{font-family:'Orbitron',sans-serif;font-size:12px;letter-spacing:.35em;color:var(--neon);margin-bottom:18px}
.logo{font-family:'Orbitron',sans-serif;font-weight:900;font-size:clamp(48px,12vw,150px);line-height:1;letter-spacing:.06em;text-shadow:0 0 40px rgba(21,86,255,.7);animation:glow 4s ease-in-out infinite}
.logo span{background:linear-gradient(180deg,#9ff0ff,var(--neon) 55%,var(--blue));-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 22px rgba(0,212,255,.7))}
@keyframes glow{50%{text-shadow:0 0 70px rgba(21,86,255,1)}}
.tagline{margin:26px auto 36px;max-width:620px;color:var(--muted);font-size:clamp(16px,2.2vw,20px)}
.cta{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.cta.left{justify-content:flex-start;margin-top:22px}
.stats{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin-top:56px}
.stat{background:var(--glass);border:1px solid var(--line);backdrop-filter:blur(14px);padding:16px 28px;border-radius:var(--r);min-width:160px}
.stat b{display:block;font-family:'Orbitron',sans-serif;font-size:28px;color:var(--neon);text-shadow:0 0 14px rgba(0,212,255,.6)}
.stat span{font-size:13px;color:var(--muted)}
.scroll-hint{position:absolute;bottom:28px;left:50%;width:24px;height:40px;border:2px solid var(--line);border-radius:14px;transform:translateX(-50%)}
.scroll-hint i{position:absolute;top:7px;left:50%;width:4px;height:8px;margin-left:-2px;border-radius:2px;background:var(--neon);animation:wheel 1.6s infinite}
@keyframes wheel{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(14px)}}

/* Section heads */
.section-head{text-align:center;margin-bottom:56px}
h2{font-family:'Orbitron',sans-serif;font-weight:800;font-size:clamp(26px,4.5vw,44px);letter-spacing:.04em;line-height:1.25}
h3{font-weight:600;font-size:20px;margin-bottom:6px}
.lead{color:var(--muted);font-size:17px;margin-top:16px}
.lead.center{max-width:560px;margin-inline:auto}

/* Glass */
.glass{background:var(--glass);border:1px solid var(--line);border-radius:var(--r);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 10px 40px rgba(0,0,0,.4),inset 0 0 30px rgba(21,86,255,.06)}

/* About */
.two-col{display:grid;grid-template-columns:1.1fr 1fr;gap:56px;align-items:center}
.about-card{padding:34px;display:grid;gap:26px}
.about-row{display:flex;gap:18px;align-items:flex-start}
.about-row p{color:var(--muted);font-size:15px}
.dot{flex:none;width:12px;height:12px;margin-top:9px;border-radius:50%;background:var(--neon);box-shadow:0 0 14px var(--neon)}

/* Features */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:22px}
.card{padding:32px 26px;transition:border-color .3s,box-shadow .3s;transform-style:preserve-3d}
.card:hover{border-color:var(--neon);box-shadow:0 0 36px rgba(0,212,255,.3),0 10px 40px rgba(0,0,0,.4)}
.card p{color:var(--muted);font-size:15px}
.icon{font-size:34px;width:64px;height:64px;display:grid;place-items:center;border-radius:16px;margin-bottom:18px;background:rgba(0,212,255,.08);border:1px solid var(--line);box-shadow:0 0 20px rgba(0,212,255,.15)}

/* Game */
.game{display:grid;grid-template-columns:minmax(240px,420px) 1fr;gap:34px;padding:26px;align-items:center}
.thumb{aspect-ratio:1;border-radius:14px;overflow:hidden;background:linear-gradient(135deg,var(--navy),#02040c);border:1px solid var(--line);position:relative}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb-fallback{position:absolute;inset:0;display:grid;place-content:center;text-align:center;font-family:'Orbitron',sans-serif;font-weight:900;font-size:clamp(32px,6vw,56px);line-height:1.05;letter-spacing:.08em}
.thumb-fallback span{color:var(--neon);text-shadow:0 0 18px var(--neon)}
.game-info p{color:var(--muted)}
.game-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.game-meta li{padding:6px 14px;border-radius:99px;font-size:13px;border:1px solid var(--line);background:rgba(0,212,255,.06)}
.game-meta b{color:var(--neon);font-weight:500}

/* Team */
.team{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:24px}
.member{padding:30px 22px;text-align:center;transition:.35s}
.member:hover{transform:translateY(-8px);border-color:var(--neon);box-shadow:0 0 38px rgba(0,212,255,.3)}
.avatar{width:110px;height:110px;margin:0 auto 18px;border-radius:50%;padding:3px;background:linear-gradient(135deg,var(--neon),var(--blue));box-shadow:0 0 26px rgba(0,212,255,.5)}
.avatar img,.avatar div{width:100%;height:100%;border-radius:50%;object-fit:cover;background:var(--bg2);display:grid;place-items:center;font-family:'Orbitron',sans-serif;font-size:30px;font-weight:800;color:var(--neon)}
.role{display:inline-block;margin-top:8px;padding:3px 14px;border-radius:99px;font-size:13px;color:var(--neon);border:1px solid var(--line);background:rgba(0,212,255,.07)}
.empty{grid-column:1/-1;text-align:center;padding:44px 24px;color:var(--muted)}
.empty .btn{margin-top:18px}

/* Support */
.support-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:26px}
.perks,.donors{padding:34px}
.perks ul{margin:18px 0 26px;display:grid;gap:12px}
.perks li{padding-left:30px;position:relative;color:var(--muted)}
.perks li::before{content:"✦";position:absolute;left:0;color:var(--neon);text-shadow:0 0 10px var(--neon)}
.donor{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.donor:last-child{border:0}
.donor .avatar{width:44px;height:44px;margin:0;padding:2px;box-shadow:none}
.donor .avatar div{font-size:14px}
.donors p.note{color:var(--muted);font-size:15px;margin-top:10px}

.final{padding-bottom:140px}
.final h2{margin-bottom:34px}

/* Footer */
.footer{position:relative;z-index:2;text-align:center;padding:44px 4% 36px;border-top:1px solid var(--line);background:rgba(4,6,15,.7);backdrop-filter:blur(10px)}
.foot-links{display:flex;gap:26px;justify-content:center;margin:16px 0;color:var(--muted)}
.foot-links a:hover{color:var(--neon)}
.footer p{color:#5d6f94;font-size:13px}

/* Reveal */
.reveal{opacity:0;transform:translateY(34px);transition:opacity .8s ease,transform .8s ease}
.reveal.in{opacity:1;transform:none}

/* Responsive */
@media (max-width:900px){
  .two-col,.support-grid,.game{grid-template-columns:1fr}
  .section{padding:80px 0}
  .burger{display:block}
  .links{position:fixed;top:0;right:0;height:100svh;width:min(300px,80vw);flex-direction:column;justify-content:center;gap:30px;background:rgba(4,6,15,.96);backdrop-filter:blur(20px);border-left:1px solid var(--line);transform:translateX(100%);transition:transform .35s}
  .links.open{transform:none}
  .burger{z-index:101}
  .cta.left{justify-content:center}
  .game-info{text-align:center}
  .game-meta{justify-content:center}
}
@media (max-width:480px){
  .btn{width:100%}
  .cta{width:100%}
  .stat{min-width:140px;padding:14px 18px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
  .reveal{opacity:1;transform:none}
  html{scroll-behavior:auto}
}
` },
  "donate.css": { type: 'text/css; charset=utf-8', body: `#fx{position:fixed;inset:0;z-index:9000;pointer-events:none}
.muted{color:var(--muted)}.small{font-size:13px}
.d-hero{min-height:84svh;display:grid;place-content:center;justify-items:center;text-align:center;gap:6px;padding:130px 4% 60px;position:relative;z-index:2}
.d-title{font-family:'Orbitron',sans-serif;font-weight:900;font-size:clamp(34px,8vw,84px);line-height:1.05;letter-spacing:.05em;text-shadow:0 0 40px rgba(21,86,255,.7)}
.totals{margin:34px 0 30px;padding:26px 30px;display:grid;grid-template-columns:1fr 1fr;gap:18px 30px;width:min(680px,100%);text-align:center}
.t-item b{display:block;font-family:'Orbitron',sans-serif;font-size:clamp(24px,4.5vw,38px);color:var(--neon);text-shadow:0 0 16px rgba(0,212,255,.6)}
.t-item span{color:var(--muted);font-size:14px}
.goal{grid-column:1/-1;text-align:left}
.goal-top{display:flex;justify-content:space-between;gap:10px;font-size:14px;margin-bottom:8px;flex-wrap:wrap}
.goal-top span:last-child{color:var(--neon);font-family:'Orbitron',sans-serif;font-size:13px}
.bar{height:14px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden;border:1px solid var(--line)}
.bar i{display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,var(--blue),var(--neon));box-shadow:0 0 18px var(--neon);transition:width 1.4s cubic-bezier(.2,.8,.2,1);position:relative;overflow:hidden}
.bar i::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.45) 50%,transparent 70%);transform:translateX(-100%);animation:shine 2.8s infinite}
@keyframes shine{to{transform:translateX(100%)}}
.bump{animation:bump .7s ease}
@keyframes bump{40%{transform:scale(1.12);text-shadow:0 0 34px #fff}}

/* packages */
.pkgs{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:22px}
.pkg{--c:#00d4ff;padding:30px 24px;display:flex;flex-direction:column;gap:10px;text-align:center;position:relative;overflow:hidden;transition:transform .3s,box-shadow .3s,border-color .3s}
.pkg::before{content:"";position:absolute;inset:0 0 auto;height:3px;background:var(--c);box-shadow:0 0 20px var(--c)}
.pkg:hover{transform:translateY(-8px);border-color:var(--c);box-shadow:0 0 40px color-mix(in srgb,var(--c) 45%,transparent),0 10px 40px rgba(0,0,0,.4)}
.pkg .emoji{font-size:44px;filter:drop-shadow(0 0 14px var(--c))}
.pkg h3{margin:0;color:var(--c)}
.pkg .price{font-family:'Orbitron',sans-serif;font-size:22px}
.pkg .price.tbd{font-family:'Kanit',sans-serif;font-size:15px;color:var(--muted)}
.pkg ul{text-align:left;display:grid;gap:8px;margin:10px 0 18px;color:var(--muted);font-size:14px;flex:1}
.pkg li{padding-left:24px;position:relative}
.pkg li::before{content:"✦";position:absolute;left:0;color:var(--c)}
.pkg .btn{background:var(--c);box-shadow:0 0 22px color-mix(in srgb,var(--c) 55%,transparent)}

/* form */
.form-grid{display:grid;grid-template-columns:1fr 1.25fr;gap:26px;align-items:start}
.methods,.dform,.mystatus{padding:30px}
.methods h3,.dform h3,.mystatus h3{margin-bottom:16px}
.method{padding:16px 0;border-bottom:1px solid rgba(255,255,255,.07)}
.method:last-child{border:0}
.method b{color:var(--neon)}
.method p{color:var(--muted);font-size:14px;margin:6px 0 10px;white-space:pre-line}
.method a{font-size:13px;color:var(--neon);border-bottom:1px dashed var(--neon)}
.dform{display:grid;gap:16px}
.dform label{display:grid;gap:6px;font-size:14px}
.dform small{color:var(--muted)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
input,select,textarea{width:100%;font:inherit;color:var(--text);background:rgba(4,10,30,.7);border:1px solid var(--line);border-radius:10px;padding:11px 14px;outline:none;transition:border-color .2s,box-shadow .2s}
input:focus,select:focus,textarea:focus{border-color:var(--neon);box-shadow:0 0 0 3px rgba(0,212,255,.15)}
input[type=file]{padding:9px}
select option{background:#070b1c}
.check{display:flex!important;grid-template-columns:none;gap:10px;align-items:flex-start;color:var(--muted)}
.check input{width:18px;height:18px;margin-top:3px;accent-color:var(--neon);flex:none}
#proof-preview{max-height:180px;width:auto;border-radius:10px;border:1px solid var(--line)}
.form-msg{padding:12px 14px;border-radius:10px;font-size:14px;background:rgba(255,80,100,.1);border:1px solid rgba(255,80,100,.45);color:#ff9aa8}
.form-msg.ok{background:rgba(60,220,140,.1);border-color:rgba(60,220,140,.5);color:#8ff0bd}
.mystatus{margin-top:26px}
.st-row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.07);font-size:14px;flex-wrap:wrap}
.st-row:last-child{border:0}
.badge{padding:3px 12px;border-radius:99px;font-size:12px;border:1px solid}
.badge.pending{color:#fbbf24;border-color:#fbbf2466;background:#fbbf2414}
.badge.approved{color:#4ade80;border-color:#4ade8066;background:#4ade8014}
.badge.rejected{color:#fb7185;border-color:#fb718566;background:#fb718514}

/* podium */
.podium{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;align-items:end;margin-bottom:34px;max-width:900px;margin-inline:auto}
.pod{--c:#fbbf24;padding:26px 14px 24px;text-align:center;position:relative;border-color:color-mix(in srgb,var(--c) 55%,transparent);box-shadow:0 0 40px color-mix(in srgb,var(--c) 28%,transparent),inset 0 0 30px color-mix(in srgb,var(--c) 8%,transparent)}
.pod.r1{--c:#fbbf24;order:2;padding-top:44px;padding-bottom:36px}
.pod.r2{--c:#cbd5e1;order:1}
.pod.r3{--c:#d97706;order:3}
.pod .medal{position:absolute;top:-16px;left:50%;transform:translateX(-50%);width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-family:'Orbitron',sans-serif;font-weight:800;color:#06101c;background:var(--c);box-shadow:0 0 20px var(--c)}
.pod .crown{position:absolute;top:-42px;left:50%;transform:translateX(-50%);font-size:30px;animation:float2 3s ease-in-out infinite;filter:drop-shadow(0 0 12px var(--c))}
@keyframes float2{50%{transform:translateX(-50%) translateY(-6px)}}
.pod .avatar{width:84px;height:84px;background:linear-gradient(135deg,var(--c),var(--blue));box-shadow:0 0 28px var(--c)}
.pod.r1 .avatar{width:104px;height:104px}
.pod h3{font-size:17px;word-break:break-word;margin-bottom:4px}
.pod .amt{font-family:'Orbitron',sans-serif;color:var(--c);font-size:18px;text-shadow:0 0 14px var(--c)}
.pod .tier{display:inline-block;margin-top:8px;font-size:12px;padding:2px 12px;border-radius:99px;border:1px solid var(--line);background:rgba(0,0,0,.25)}
.board{padding:10px 20px;overflow-x:auto;max-width:900px;margin-inline:auto}
.board table{width:100%;border-collapse:collapse;min-width:420px}
.board th{font-family:'Orbitron',sans-serif;font-size:12px;letter-spacing:.12em;color:var(--muted);text-align:left;padding:14px 10px;font-weight:600}
.board td{padding:12px 10px;border-top:1px solid rgba(255,255,255,.06);font-size:15px}
.board .r{text-align:right;font-family:'Orbitron',sans-serif;color:var(--neon);font-size:14px}
.board .who{display:flex;align-items:center;gap:12px}
.board .avatar{width:36px;height:36px;margin:0;padding:2px;box-shadow:none;flex:none}
.board .avatar div{font-size:13px}
.board tr:hover td{background:rgba(0,212,255,.05)}

/* sound + toasts */
.sound{position:fixed;right:18px;bottom:18px;z-index:150;width:46px;height:46px;border-radius:50%;border:1px solid var(--line);background:var(--glass);backdrop-filter:blur(12px);font-size:20px;color:var(--text);box-shadow:0 0 20px rgba(0,212,255,.25);transition:.2s}
.sound:hover{border-color:var(--neon);transform:scale(1.08)}
.sound[aria-pressed=false]{opacity:.6}
#toasts{position:fixed;top:78px;right:16px;z-index:160;display:grid;gap:10px;width:min(340px,calc(100vw - 32px))}
.toast{padding:14px 18px;border-radius:14px;background:rgba(8,18,48,.92);border:1px solid var(--neon);box-shadow:0 0 30px rgba(0,212,255,.45);animation:tin .5s cubic-bezier(.2,.9,.3,1.2);font-size:15px}
.toast.out{animation:tout .4s forwards}
@keyframes tin{from{transform:translateX(120%);opacity:0}}
@keyframes tout{to{transform:translateX(120%);opacity:0}}

@media (max-width:900px){
  .form-grid{grid-template-columns:1fr}
  .podium{grid-template-columns:1fr;gap:34px}
  .pod.r1{order:1}.pod.r2{order:2}.pod.r3{order:3}
  .row2{grid-template-columns:1fr}
  .totals{grid-template-columns:1fr 1fr;padding:20px}
}
` },
  "admin.css": { type: 'text/css; charset=utf-8', body: `body.admin{cursor:auto}
.muted{color:var(--muted)}.small{font-size:13px}.r{text-align:right}
.login{min-height:100svh;display:grid;place-items:center;padding:20px;position:relative;z-index:2}
.login-card{width:min(400px,100%);padding:36px;display:grid;gap:16px;text-align:center}
.login-card label{display:grid;gap:6px;text-align:left;font-size:14px}
.shell{display:grid;grid-template-columns:240px 1fr;min-height:100svh;position:relative;z-index:2}
.side{position:sticky;top:0;height:100svh;padding:22px 16px;border-right:1px solid var(--line);background:rgba(4,6,15,.82);backdrop-filter:blur(16px);display:flex;flex-direction:column;gap:22px}
.side nav{display:grid;gap:6px}
.side nav button{text-align:left;padding:11px 14px;border-radius:10px;border:1px solid transparent;background:none;color:var(--muted);font:inherit;transition:.2s;display:flex;justify-content:space-between;align-items:center}
.side nav button:hover{color:#fff;background:rgba(0,212,255,.07)}
.side nav button.on{color:#fff;background:rgba(0,212,255,.12);border-color:var(--line);box-shadow:inset 0 0 18px rgba(0,212,255,.1)}
.side em{font-style:normal;background:var(--neon);color:#02121c;border-radius:99px;font-size:12px;font-weight:600;padding:0 8px}
.side-foot{margin-top:auto;display:grid;gap:10px}
.content{padding:30px clamp(16px,3vw,40px) 60px;min-width:0}
h1.pg{font-family:'Orbitron',sans-serif;font-size:24px;margin-bottom:22px;letter-spacing:.05em}
.cards4{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:22px}
.kpi{padding:20px 22px}
.kpi b{display:block;font-family:'Orbitron',sans-serif;font-size:26px;color:var(--neon);text-shadow:0 0 14px rgba(0,212,255,.5)}
.kpi span{color:var(--muted);font-size:13px}
.panel{padding:22px;margin-bottom:22px}
.panel h3{margin-bottom:14px}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
.toolbar input,.toolbar select{width:auto;min-width:180px}
.toolbar .grow{flex:1}
.tbl-wrap{overflow-x:auto}
table.t{width:100%;border-collapse:collapse;min-width:640px}
table.t th{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:left;padding:12px 10px;font-weight:500;white-space:nowrap}
table.t td{padding:11px 10px;border-top:1px solid rgba(255,255,255,.06);font-size:14px;vertical-align:middle}
table.t tr:hover td{background:rgba(0,212,255,.04)}
.badge{padding:3px 12px;border-radius:99px;font-size:12px;border:1px solid;white-space:nowrap}
.badge.pending{color:#fbbf24;border-color:#fbbf2466;background:#fbbf2414}
.badge.approved{color:#4ade80;border-color:#4ade8066;background:#4ade8014}
.badge.rejected{color:#fb7185;border-color:#fb718566;background:#fb718514}
.btn-sm{padding:8px 16px;font-size:12px}
.btn-danger{background:linear-gradient(135deg,#fb7185,#e11d48);box-shadow:0 0 18px rgba(251,113,133,.4);color:#fff}
.btn-ok{background:linear-gradient(135deg,#4ade80,#16a34a);box-shadow:0 0 18px rgba(74,222,128,.4);color:#04150a}
.acts{display:flex;gap:8px;flex-wrap:wrap}
input,select,textarea{width:100%;font:inherit;color:var(--text);background:rgba(4,10,30,.7);border:1px solid var(--line);border-radius:10px;padding:10px 13px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--neon);box-shadow:0 0 0 3px rgba(0,212,255,.15)}
select option{background:#070b1c}
input[type=checkbox]{width:18px;height:18px;accent-color:var(--neon)}
input[type=color]{padding:2px;height:42px}
form.f{display:grid;gap:14px}
form.f label{display:grid;gap:6px;font-size:14px}
form.f label.inline{display:flex;gap:10px;align-items:center}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.form-msg{padding:11px 14px;border-radius:10px;font-size:14px;background:rgba(255,80,100,.1);border:1px solid rgba(255,80,100,.45);color:#ff9aa8}
.modal{position:fixed;inset:0;z-index:500;background:rgba(2,4,12,.78);backdrop-filter:blur(6px);display:grid;place-items:center;padding:16px;overflow-y:auto}
.modal[hidden]{display:none}
.modal-box{width:min(620px,100%);padding:28px;max-height:92svh;overflow-y:auto;position:relative}
.modal-box h2{font-size:20px;margin-bottom:16px}
.modal-x{position:absolute;top:14px;right:16px;background:none;border:0;color:var(--muted);font-size:22px}
.kv{display:grid;grid-template-columns:130px 1fr;gap:8px 14px;font-size:14px;margin-bottom:16px}
.kv dt{color:var(--muted)}.kv dd{word-break:break-word}
.proof{max-width:100%;max-height:360px;border-radius:12px;border:1px solid var(--line);margin:6px 0 16px;background:#000}
.pickrow{display:flex;gap:6px;align-items:center}
.sw{width:14px;height:14px;border-radius:50%;display:inline-block;box-shadow:0 0 10px currentColor}
#toasts{position:fixed;top:16px;right:16px;z-index:600;display:grid;gap:10px;width:min(340px,calc(100vw - 32px))}
.toast{padding:13px 18px;border-radius:12px;background:rgba(8,18,48,.95);border:1px solid var(--neon);box-shadow:0 0 24px rgba(0,212,255,.4);font-size:14px}
.toast.err{border-color:#fb7185;box-shadow:0 0 24px rgba(251,113,133,.4)}
.bar{height:12px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden;border:1px solid var(--line)}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--neon));box-shadow:0 0 14px var(--neon)}
@media (max-width:860px){
  .shell{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;padding:12px}
  .side nav{display:flex;flex-wrap:wrap;order:3;width:100%}
  .side-foot{margin:0 0 0 auto;display:flex;align-items:center}
  .row2{grid-template-columns:1fr}
  .kv{grid-template-columns:1fr}
}
` },
  "main.js": { type: 'text/javascript; charset=utf-8', body: `/* =========================================================
   HI GARDEN — main.js
   ========================================================= */

/* ---------- CONFIG (แก้ตรงนี้) ---------- */
const CONFIG = {
  discordInvite: 'https://dc.gg/higarden',
  discordInviteCode: 'higarden',          // โค้ดท้ายลิงก์ invite — ใช้ดึงจำนวนสมาชิกจริงจาก Discord
  robloxPlaceId: '84130588253982',
  // ปุ่ม Support Us (ใส่ลิงก์โดเนทจริงที่นี่ ถ้าไม่ใส่จะพาไป Discord)
  supportUrl: '/donate',

  // ทีมงาน — ใส่ข้อมูลจริงเท่านั้น  ตัวอย่าง:
  // { name: 'ชื่อ', role: 'Owner', avatar: 'img/owner.png' }   (avatar ไม่ใส่ก็ได้ จะแสดงตัวอักษรแรก)
  staff: [],

  // สิทธิพิเศษของ Donator — แก้ไขให้ตรงกับที่ให้จริง
  perks: [
    'ยศ Donator พิเศษใน Discord',
    'ห้องแชทเฉพาะผู้สนับสนุน',
    'สิทธิ์ลุ้นกิจกรรมและ Giveaways พิเศษ',
    'ได้รับข่าวสารและอัปเดตก่อนใคร'
  ],

  // รายชื่อผู้สนับสนุน — ใส่เฉพาะคนที่อนุญาตให้แสดงชื่อ  { name: 'ชื่อ', avatar: '' }
  donors: []
};

/* ---------- Helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = n => new Intl.NumberFormat('en-US').format(n);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- Loader ---------- */
window.addEventListener('load', () => setTimeout(() => $('#loader').classList.add('done'), 600));
setTimeout(() => $('#loader')?.classList.add('done'), 4000); // safety

/* ---------- Year ---------- */
$('#year').textContent = new Date().getFullYear();

/* ---------- Navbar ---------- */
const nav = $('#nav'), burger = $('#burger'), links = $('#links');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 30), { passive: true });
burger.addEventListener('click', () => {
  const open = links.classList.toggle('open');
  burger.setAttribute('aria-expanded', open);
});
$$('a', links).forEach(a => a.addEventListener('click', () => {
  links.classList.remove('open'); burger.setAttribute('aria-expanded', false);
}));
// active link on scroll
const sections = ['home', 'about', 'features', 'team', 'support'].map(id => document.getElementById(id));
const spy = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) $$('a', links).forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
}), { rootMargin: '-45% 0px -50% 0px' });
sections.forEach(s => s && spy.observe(s));

/* ---------- Scroll reveal ---------- */
const io = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}), { threshold: .12 });
const observeReveal = () => $$('.reveal:not(.in)').forEach(el => io.observe(el));
observeReveal();

/* ---------- Custom cursor (desktop only) ---------- */
if (matchMedia('(hover:hover) and (pointer:fine)').matches && !reduced) {
  document.body.classList.add('has-cursor');
  const c = $('#cursor'), d = $('#cursor-dot');
  let x = 0, y = 0, cx = 0, cy = 0;
  addEventListener('mousemove', e => { x = e.clientX; y = e.clientY; d.style.transform = \`translate(\${x}px,\${y}px)\`; });
  (function loop() { cx += (x - cx) * .18; cy += (y - cy) * .18; c.style.transform = \`translate(\${cx}px,\${cy}px)\`; requestAnimationFrame(loop); })();
  document.addEventListener('mouseover', e => c.classList.toggle('hover', !!e.target.closest('a,button,.card,.member')));
}

/* ---------- Card tilt (desktop) ---------- */
if (matchMedia('(hover:hover) and (pointer:fine)').matches && !reduced) {
  $$('.tilt').forEach(el => {
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
      el.style.transform = \`perspective(700px) rotateY(\${px * 10}deg) rotateX(\${-py * 10}deg) translateY(-6px)\`;
    });
    el.addEventListener('mouseleave', () => el.style.transform = '');
  });
}

/* ---------- Particles ---------- */
(function particles() {
  const cv = $('#particles'), ctx = cv.getContext('2d');
  let w, h, pts = [], dpr = Math.min(devicePixelRatio || 1, 2);
  const mouse = { x: -999, y: -999 };
  function resize() {
    w = cv.width = innerWidth * dpr; h = cv.height = innerHeight * dpr;
    cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    const n = Math.min(90, Math.floor(innerWidth / 16));
    pts = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - .5) * .35 * dpr, vy: (Math.random() - .5) * .35 * dpr,
      r: (Math.random() * 1.6 + .5) * dpr
    }));
  }
  resize(); addEventListener('resize', resize);
  addEventListener('mousemove', e => { mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr; });
  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) draw(); });
  function draw() {
    if (!running) return;
    ctx.clearRect(0, 0, w, h);
    const maxD = 130 * dpr;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283);
      ctx.fillStyle = 'rgba(0,212,255,.8)'; ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 8 * dpr; ctx.fill();
      ctx.shadowBlur = 0;
      for (let j = i + 1; j < pts.length; j++) {
        const q = pts[j], dx = p.x - q.x, dy = p.y - q.y, dist = Math.hypot(dx, dy);
        if (dist < maxD) {
          ctx.strokeStyle = \`rgba(21,120,255,\${(1 - dist / maxD) * .35})\`;
          ctx.lineWidth = dpr * .8; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
      const mx = p.x - mouse.x, my = p.y - mouse.y, md = Math.hypot(mx, my);
      if (md < 160 * dpr) { p.x += mx / md * .6; p.y += my / md * .6; }
    }
    requestAnimationFrame(draw);
  }
  if (reduced) { draw(); running = false; } else draw();
})();

/* ---------- Count-up ---------- */
function showStat(id, value) {
  const el = $('#' + id);
  if (!el || !Number.isFinite(value)) return;
  el.hidden = false; $('#stats').hidden = false;
  const num = $('[data-count]', el);
  if (reduced) { num.textContent = fmt(value); return; }
  const t0 = performance.now(), dur = 1400;
  (function tick(t) {
    const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
    num.textContent = fmt(Math.round(value * e));
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}

/* ---------- REAL data: Discord (official invite API) ---------- */
async function loadDiscord() {
  try {
    const r = await fetch(\`https://discord.com/api/v9/invites/\${CONFIG.discordInviteCode}?with_counts=true\`);
    if (!r.ok) throw 0;
    const j = await r.json();
    showStat('stat-members', j.approximate_member_count);
    showStat('stat-online', j.approximate_presence_count);
  } catch (e) { /* ไม่แสดงตัวเลขถ้าดึงข้อมูลจริงไม่ได้ */ }
}

/* ---------- REAL data: Roblox (via RoProxy — Roblox API ไม่รองรับ CORS) ---------- */
async function loadRoblox() {
  try {
    const u = await fetch(\`https://apis.roproxy.com/universes/v1/places/\${CONFIG.robloxPlaceId}/universe\`).then(r => r.json());
    const uid = u.universeId; if (!uid) throw 0;
    const [g, ic] = await Promise.all([
      fetch(\`https://games.roproxy.com/v1/games?universeIds=\${uid}\`).then(r => r.json()),
      fetch(\`https://thumbnails.roproxy.com/v1/games/icons?universeIds=\${uid}&size=512x512&format=Png&isCircular=false\`).then(r => r.json())
    ]);
    const game = g.data?.[0];
    if (game) {
      $('#game-title').textContent = game.name || 'HI Garden';
      showStat('stat-playing', game.playing);
      showStat('stat-visits', game.visits);
      const meta = $('#game-meta');
      const add = (k, v) => meta.insertAdjacentHTML('beforeend', \`<li>\${esc(k)}: <b>\${esc(v)}</b></li>\`);
      if (Number.isFinite(game.playing)) add('Playing', fmt(game.playing));
      if (Number.isFinite(game.visits)) add('Visits', fmt(game.visits));
      if (Number.isFinite(game.favoritedCount)) add('Favorites', fmt(game.favoritedCount));
    }
    const url = ic.data?.[0]?.imageUrl;
    if (url) {
      const img = $('#game-img');
      img.onload = () => { img.hidden = false; $('#thumb-fallback').hidden = true; };
      img.src = url;
    }
  } catch (e) { /* ใช้ fallback ที่ไม่มีข้อมูลปลอม */ }
}

/* ---------- Team ---------- */
function renderTeam() {
  const grid = $('#team-grid');
  if (!CONFIG.staff.length) {
    grid.innerHTML = \`<div class="glass empty reveal"><h3>ทีมงานกำลังจะมาเร็วๆ นี้</h3><p>เข้าร่วม Discord เพื่อพบกับทีมงานของ HI GARDEN</p><a class="btn" href="\${CONFIG.discordInvite}" target="_blank" rel="noopener">JOIN DISCORD</a></div>\`;
    return;
  }
  grid.innerHTML = CONFIG.staff.map(s => \`
    <article class="member glass tilt reveal">
      <div class="avatar">\${s.avatar ? \`<img src="\${esc(s.avatar)}" alt="\${esc(s.name)}" loading="lazy" width="110" height="110">\` : \`<div>\${esc(s.name.charAt(0).toUpperCase())}</div>\`}</div>
      <h3>\${esc(s.name)}</h3>
      <span class="role">\${esc(s.role)}</span>
    </article>\`).join('');
}

/* ---------- Support ---------- */
function renderSupport() {
  $('#perks-list').innerHTML = CONFIG.perks.map(p => \`<li>\${esc(p)}</li>\`).join('');
  $('#support-btn').href = CONFIG.supportUrl;
  const box = $('#donor-list');
  const draw = list => {
    if (!list.length) {
      box.innerHTML = \`<p class="note">รายชื่อผู้สนับสนุนจะแสดงที่นี่เมื่อได้รับอนุญาตจากผู้สนับสนุนเท่านั้น 💙</p>\`;
      return;
    }
    box.innerHTML = list.map(d => \`
      <div class="donor"><div class="avatar">\${d.avatar ? \`<img src="\${esc(d.avatar)}" alt="" loading="lazy" width="44" height="44" referrerpolicy="no-referrer">\` : \`<div>\${esc(d.name.charAt(0).toUpperCase())}</div>\`}</div><span>\${esc(d.name)}\${d.tier ? \` <small>\${esc(d.tier)}</small>\` : ''}</span></div>\`).join('')
      + \`<p class="note"><a class="neon" href="\${esc(CONFIG.supportUrl)}">ดูอันดับทั้งหมด →</a></p>\`;
  };
  draw(CONFIG.donors);
  // real supporters from the backend (only those who consented to be shown)
  fetch('/api/public/leaderboard').then(r => r.ok ? r.json() : Promise.reject()).then(rows => {
    if (rows.length) draw(rows.slice(0, 5).map(r => ({ name: r.username, avatar: r.avatar, tier: r.tier ? \`\${r.tier.emoji} \${r.tier.name}\` : '' })));
  }).catch(() => {});
}

/* ---------- Init ---------- */
if ($('#team-grid')) {          // index page only
  renderTeam();
  renderSupport();
  loadDiscord();
  loadRoblox();
}
observeReveal();
` },
  "donate.js": { type: 'text/javascript; charset=utf-8', body: `/* =========================================================
   HI GARDEN — donate.js  (uses helpers from main.js: $, $$, fmt, esc, reduced, observeReveal)
   ========================================================= */
(() => {
  const state = { packages: [], methods: [], currency: '฿', sound: localStorage.getItem('hg_sound') !== '0' };
  const money = n => \`\${state.currency}\${fmt(n)}\`;

  /* ---------- Sound + confetti (toggleable) ---------- */
  let actx;
  const unlock = () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume?.(); } catch {} };
  addEventListener('pointerdown', unlock, { once: true });
  function chime() {
    if (!state.sound || !actx) return;
    const t = actx.currentTime;
    [660, 880, 1318].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * .11); g.gain.linearRampToValueAtTime(.12, t + i * .11 + .02); g.gain.exponentialRampToValueAtTime(.0001, t + i * .11 + .5);
      o.connect(g).connect(actx.destination); o.start(t + i * .11); o.stop(t + i * .11 + .55);
    });
  }
  const fx = $('#fx'), fctx = fx.getContext('2d'); let bits = [], raf = 0;
  function sizeFx() { fx.width = innerWidth; fx.height = innerHeight; }
  sizeFx(); addEventListener('resize', sizeFx);
  function confetti() {
    if (!state.sound || reduced) return;
    const cols = ['#00d4ff', '#1556ff', '#9ff0ff', '#a78bfa', '#fbbf24'];
    for (let i = 0; i < 120; i++) bits.push({ x: innerWidth / 2, y: innerHeight * .35, vx: (Math.random() - .5) * 16, vy: Math.random() * -14 - 3, s: Math.random() * 6 + 3, c: cols[i % 5], r: Math.random() * 6, life: 1 });
    if (!raf) loop();
  }
  function loop() {
    fctx.clearRect(0, 0, fx.width, fx.height);
    bits = bits.filter(b => b.life > 0);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.vy += .35; b.vx *= .99; b.r += .2; b.life -= .008;
      fctx.save(); fctx.globalAlpha = Math.max(b.life, 0); fctx.translate(b.x, b.y); fctx.rotate(b.r);
      fctx.fillStyle = b.c; fctx.shadowColor = b.c; fctx.shadowBlur = 8; fctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * .6); fctx.restore();
    }
    raf = bits.length ? requestAnimationFrame(loop) : 0;
    if (!bits.length) fctx.clearRect(0, 0, fx.width, fx.height);
  }
  const soundBtn = $('#sound-toggle');
  const paintSound = () => { soundBtn.textContent = state.sound ? '🔊' : '🔇'; soundBtn.setAttribute('aria-pressed', state.sound); };
  soundBtn.addEventListener('click', () => { state.sound = !state.sound; localStorage.setItem('hg_sound', state.sound ? '1' : '0'); paintSound(); unlock(); if (state.sound) chime(); });
  paintSound();

  function toast(html) {
    const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = html;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, 6000);
  }

  /* ---------- Summary ---------- */
  let shown = { total: 0, supporters: 0 };
  function countTo(el, from, to, fmtFn) {
    if (reduced || from === to) { el.textContent = fmtFn(to); return; }
    const t0 = performance.now(), dur = 1200;
    (function tick(t) { const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3); el.textContent = fmtFn(Math.round(from + (to - from) * e)); if (p < 1) requestAnimationFrame(tick); })(t0);
  }
  function renderSummary(s, bump) {
    state.currency = s.currency || '฿';
    countTo($('#t-total'), shown.total, s.total, money);
    countTo($('#t-supporters'), shown.supporters, s.supporters, fmt);
    if (bump) { $('#t-total').classList.remove('bump'); void $('#t-total').offsetWidth; $('#t-total').classList.add('bump'); }
    shown = { total: s.total, supporters: s.supporters };
    const g = $('#goal');
    if (s.goal > 0) {
      g.hidden = false;
      $('#goal-title').textContent = s.goalTitle;
      $('#goal-text').textContent = \`\${money(s.total)} / \${money(s.goal)} · \${s.progress}%\`;
      $('#goal-bar').setAttribute('aria-valuenow', s.progress);
      requestAnimationFrame(() => requestAnimationFrame(() => { $('#goal-fill').style.width = s.progress + '%'; }));
    } else g.hidden = true;
  }

  /* ---------- Packages ---------- */
  function renderPackages() {
    const grid = $('#pkg-grid');
    if (!state.packages.length) { grid.innerHTML = '<p class="muted center">ยังไม่มีแพ็กเกจที่เปิดให้สนับสนุน</p>'; return; }
    grid.innerHTML = state.packages.map(p => \`
      <article class="pkg glass tilt reveal" data-color="\${esc(p.color)}">
        <div class="emoji">\${esc(p.emoji)}</div>
        <h3>\${esc(p.name)}</h3>
        <p class="muted small">\${esc(p.description)}</p>
        <div class="price \${p.price > 0 ? '' : 'tbd'}">\${p.price > 0 ? money(p.price) : 'ตามที่ทีมงานกำหนด'}</div>
        <ul>\${p.perks.map(x => \`<li>\${esc(x)}</li>\`).join('')}</ul>
        <button class="btn" type="button" data-pick="\${p.id}">เลือกแพ็กเกจนี้</button>
      </article>\`).join('');
    $$('.pkg', grid).forEach(el => el.style.setProperty('--c', el.dataset.color));
    $$('[data-pick]', grid).forEach(b => b.addEventListener('click', () => {
      $('#f-package').value = b.dataset.pick; syncAmount();
      $('#donate-form').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
      setTimeout(() => $('#dform [name=username]').focus({ preventScroll: true }), 500);
    }));
    $('#f-package').innerHTML = state.packages.map(p => \`<option value="\${p.id}">\${esc(p.emoji)} \${esc(p.name)}\${p.price > 0 ? ' — ' + money(p.price) : ''}</option>\`).join('');
    observeReveal();
  }

  function renderMethods() {
    const box = $('#method-list');
    if (!state.methods.length) { box.innerHTML = '<p class="muted">ยังไม่มีช่องทางที่เปิดใช้งาน</p>'; return; }
    box.innerHTML = state.methods.map(m => \`
      <div class="method"><b>\${esc(m.name)}</b>
        \${m.instructions ? \`<p>\${esc(m.instructions)}</p>\` : ''}
        \${/^https?:\\/\\//i.test(m.link) ? \`<a href="\${esc(m.link)}" target="_blank" rel="noopener noreferrer">เปิดลิงก์ ↗</a>\` : ''}
      </div>\`).join('');
    $('#f-method').innerHTML = state.methods.map(m => \`<option value="\${m.id}">\${esc(m.name)}</option>\`).join('');
  }

  function syncAmount() {
    const p = state.packages.find(x => String(x.id) === $('#f-package').value);
    const wrap = $('#amount-wrap'), inp = $('#f-amount');
    if (!p) return;
    if (p.price > 0) { wrap.hidden = true; inp.required = false; inp.value = ''; }
    else { wrap.hidden = false; $('#amount-hint').textContent = '(ทีมงานจะยืนยันยอดจริงจากหลักฐาน)'; }
  }
  $('#f-package').addEventListener('change', syncAmount);

  /* ---------- Leaderboard ---------- */
  function avatarHTML(r) {
    return r.avatar
      ? \`<div class="avatar"><img src="\${esc(r.avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy" width="84" height="84" data-fb="\${esc(r.username.charAt(0).toUpperCase())}"></div>\`
      : \`<div class="avatar"><div>\${esc(r.username.charAt(0).toUpperCase())}</div></div>\`;
  }
  const tierHTML = t => t ? \`\${esc(t.emoji)} \${esc(t.name)}\` : '—';
  function renderBoard(rows) {
    const pod = $('#podium'), board = $('#board'), empty = $('#board-empty');
    if (!rows.length) { pod.innerHTML = ''; board.hidden = true; empty.hidden = false; return; }
    empty.hidden = true;
    pod.innerHTML = rows.slice(0, 3).map(r => \`
      <article class="pod r\${r.rank} glass reveal">
        \${r.rank === 1 ? '<div class="crown">👑</div>' : ''}<div class="medal">\${r.rank}</div>
        \${avatarHTML(r)}
        <h3>\${esc(r.username)}</h3>
        <div class="amt">\${money(r.total)}</div>
        <span class="tier">\${tierHTML(r.tier)}</span>
      </article>\`).join('');
    const rest = rows.slice(3);
    board.hidden = !rest.length;
    $('#board-body').innerHTML = rest.map(r => \`
      <tr><td>#\${r.rank}</td><td><div class="who">\${avatarHTML(r)}<span>\${esc(r.username)}</span></div></td><td>\${tierHTML(r.tier)}</td><td class="r">\${money(r.total)}</td></tr>\`).join('');
    $$('img[data-fb]').forEach(img => img.addEventListener('error', () => {
      const d = document.createElement('div'); d.textContent = img.dataset.fb; img.replaceWith(d);
    }, { once: true }));
    observeReveal();
  }

  /* ---------- Form ---------- */
  const form = $('#dform'), msg = $('#form-msg');
  let idem = crypto.randomUUID().replace(/-/g, '') ;
  const showMsg = (t, ok) => { msg.hidden = false; msg.textContent = t; msg.classList.toggle('ok', !!ok); };

  $('#f-proof').addEventListener('change', e => {
    const f = e.target.files[0], pv = $('#proof-preview');
    if (!f) { pv.hidden = true; return; }
    if (f.size > 5 * 1024 * 1024) { showMsg('ไฟล์ใหญ่เกิน 5MB'); e.target.value = ''; pv.hidden = true; return; }
    pv.src = URL.createObjectURL(f); pv.hidden = false; msg.hidden = true;
  });

  form.addEventListener('submit', async e => {
    e.preventDefault(); msg.hidden = true;
    const fd = new FormData(form);
    if (!/^[A-Za-z0-9_.\\-#@]{2,41}$/.test(fd.get('username') || '')) return showMsg('Username ไม่ถูกต้อง (ใช้ได้เฉพาะ a-z 0-9 _ . - #)');
    if (!fd.get('proof') || !fd.get('proof').size) return showMsg('กรุณาแนบภาพหลักฐาน');
    fd.set('idem_key', idem);
    fd.set('consent', form.consent.checked ? '1' : '0');
    const btn = $('#submit-btn'); btn.disabled = true; btn.textContent = 'กำลังส่ง…';
    try {
      const r = await fetch('/api/donations', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'ส่งรายการไม่สำเร็จ');
      saveToken(j.token);
      showMsg(j.duplicate ? 'รายการนี้ถูกส่งไปแล้ว' : 'ส่งรายการสำเร็จ! ทีมงานจะตรวจสอบและแจ้งผลผ่าน Discord 💙', true);
      chime(); confetti();
      form.reset(); $('#proof-preview').hidden = true; syncAmount();
      idem = crypto.randomUUID().replace(/-/g, '');
      renderStatuses();
    } catch (err) { showMsg(err.message); }
    finally { btn.disabled = false; btn.textContent = 'ส่งรายการ'; }
  });

  /* ---------- My status (tokens kept on this device only) ---------- */
  const tokens = () => { try { return JSON.parse(localStorage.getItem('hg_tokens') || '[]'); } catch { return []; } };
  function saveToken(t) { const l = tokens().filter(x => x !== t); l.unshift(t); localStorage.setItem('hg_tokens', JSON.stringify(l.slice(0, 5))); }
  const label = { pending: 'รอตรวจสอบ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' };
  async function renderStatuses() {
    const list = tokens(); if (!list.length) return;
    const rows = await Promise.all(list.map(t => fetch('/api/donations/status/' + t).then(r => r.ok ? r.json() : null).catch(() => null)));
    const ok = rows.filter(Boolean);
    if (!ok.length) return;
    $('#mystatus').hidden = false;
    $('#status-list').innerHTML = ok.map(s => \`
      <div class="st-row"><span>\${esc(s.package || '')} · <span class="muted">\${esc(new Date(s.created_at.replace(' ', 'T') + 'Z').toLocaleString('th-TH'))}</span>\${s.reason ? \`<br><small class="muted">เหตุผล: \${esc(s.reason)}</small>\` : ''}</span>
      <span class="badge \${esc(s.status)}">\${label[s.status] || ''}</span></div>\`).join('');
  }

  /* ---------- Live updates ---------- */
  function live() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/public/stream');
    es.onmessage = ev => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d.summary) renderSummary(d.summary, d.type === 'supporter');
      if (d.type === 'supporter') {
        toast(\`🎉 <b>\${esc(d.name || 'ผู้สนับสนุนท่านหนึ่ง')}</b> เพิ่งเป็น \${esc(d.emoji || '')} \${esc(d.tier || 'Supporter')}!\`);
        chime(); confetti(); loadBoard(); renderStatuses();
      }
    };
  }

  const getJSON = u => fetch(u).then(r => { if (!r.ok) throw new Error(u); return r.json(); });
  const loadBoard = () => getJSON('/api/public/leaderboard').then(renderBoard).catch(() => {});

  (async function init() {
    try {
      const [s, p, m] = await Promise.all([getJSON('/api/public/summary'), getJSON('/api/public/packages'), getJSON('/api/public/methods')]);
      state.packages = p; state.methods = m;
      renderSummary(s); renderPackages(); renderMethods(); syncAmount();
    } catch {
      $('#pkg-grid').innerHTML = '<p class="muted center">ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ในขณะนี้</p>';
    }
    loadBoard(); renderStatuses(); live();
    setInterval(renderStatuses, 60_000);
  })();
})();
` },
  "admin.js": { type: 'text/javascript; charset=utf-8', body: `/* =========================================================
   HI GARDEN — Admin Dashboard (all DOM built with textContent — no HTML injection)
   ========================================================= */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  let cur = 'overview', cfg = { currency: '฿' };
  const pendingFilter = { supporter_id: null };

  /* ---- tiny DOM helper ---- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  const money = n => \`\${cfg.currency}\${Number(n || 0).toLocaleString('en-US')}\`;
  const when = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('th-TH') : '—';
  const stLabel = { pending: 'รอตรวจสอบ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' };

  function toast(t, err) {
    const el = h('div', { class: 'toast' + (err ? ' err' : '') }, t);
    $('#toasts').append(el); setTimeout(() => el.remove(), 4500);
  }

  async function api(method, url, body) {
    const r = await fetch('/api/admin' + url, {
      method, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'hg', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && !url.startsWith('/login')) { showLogin(); throw new Error('เซสชันหมดอายุ'); }
    if (!r.ok) throw new Error(j.error || 'เกิดข้อผิดพลาด');
    return j;
  }
  const run = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); } };

  /* ---- modal ---- */
  function openModal(title, ...content) {
    const box = $('#modal-box'); box.replaceChildren(h('button', { class: 'modal-x', 'aria-label': 'ปิด', onclick: closeModal }, '×'), h('h2', {}, title), ...content);
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; }
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  /* ---- auth ---- */
  function showLogin() { $('#app-view').hidden = true; $('#login-view').hidden = false; }
  function showApp() { $('#login-view').hidden = true; $('#app-view').hidden = false; }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target, m = $('#login-msg'); m.hidden = true;
    try { await api('POST', '/login', { username: f.username.value, password: f.password.value }); f.password.value = ''; await boot(); }
    catch (err) { m.textContent = err.message; m.hidden = false; }
  });
  $('#logout').addEventListener('click', async () => { await api('POST', '/logout').catch(() => {}); showLogin(); });

  async function boot() {
    try { const me = await api('GET', '/me'); cfg = me; $('#who').textContent = '👤 ' + me.username; showApp(); go(cur); }
    catch { showLogin(); }
  }

  /* ---- tabs ---- */
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { pendingFilter.supporter_id = null; go(b.dataset.tab); } });
  function go(tab) {
    cur = tab;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    ({ overview, donations, packages, methods, supporters, settings, audit }[tab])();
    refreshBadge();
  }
  async function refreshBadge() {
    try { const o = await api('GET', '/overview'); const b = $('#pending-badge'); b.hidden = !o.pending; b.textContent = o.pending; } catch {}
  }

  /* =============== Overview =============== */
  async function overview() {
    view.replaceChildren(h('h1', { class: 'pg' }, 'ภาพรวม'));
    const o = await run(() => api('GET', '/overview')); if (!o) return;
    const kpi = (v, l) => h('div', { class: 'glass kpi' }, h('b', {}, v), h('span', {}, l));
    view.append(
      h('div', { class: 'cards4' },
        kpi(money(o.total), 'ยอดโดเนทรวม (อนุมัติแล้ว)'), kpi(o.supporters, 'ผู้สนับสนุน'),
        kpi(o.pending, 'รอตรวจสอบ'), kpi(o.approved, 'อนุมัติแล้ว'), kpi(o.rejected, 'ไม่อนุมัติ')),
      h('div', { class: 'glass panel' }, h('h3', {}, o.goalTitle),
        o.goal > 0 ? [h('div', { class: 'bar' }, h('i', { style: \`width:\${o.progress}%\` })), h('p', { class: 'muted small' }, \`\${money(o.total)} / \${money(o.goal)} (\${o.progress}%)\`)]
          : h('p', { class: 'muted' }, 'ยังไม่ได้ตั้งเป้าหมาย — ตั้งได้ที่แท็บ "ตั้งค่า"')),
      h('div', { class: 'glass panel' }, h('h3', {}, 'Discord Integration'),
        h('p', { class: o.discord ? '' : 'muted' }, o.discord ? '✅ เชื่อมต่อ Bot แล้ว (มอบยศ/แจ้งเตือนอัตโนมัติ)' : '⚠️ ยังไม่ได้ตั้งค่า DISCORD_BOT_TOKEN / DISCORD_GUILD_ID ใน .env — ระบบจะอนุมัติได้ แต่ไม่มอบยศอัตโนมัติ')));
  }

  /* =============== Donations =============== */
  async function donations() {
    const status = h('select', {}, h('option', { value: '' }, 'ทุกสถานะ'), ...['pending', 'approved', 'rejected'].map(s => h('option', { value: s }, stLabel[s])));
    status.value = donations.last !== undefined ? donations.last : 'pending';
    const q = h('input', { type: 'search', placeholder: 'ค้นหา Username…' });
    const body = h('tbody');
    const load = async () => {
      donations.last = status.value;
      const qs = new URLSearchParams({ status: status.value, q: q.value.trim() });
      if (pendingFilter.supporter_id) qs.set('supporter_id', pendingFilter.supporter_id);
      const rows = await run(() => api('GET', '/donations?' + qs)); if (!rows) return;
      body.replaceChildren(...(rows.length ? rows.map(d => h('tr', {},
        h('td', {}, '#' + d.id), h('td', {}, d.username), h('td', {}, \`\${d.package_emoji || ''} \${d.package_name || '-'}\`), h('td', {}, d.method_name || '-'),
        h('td', {}, money(d.claimed_amount)), h('td', {}, d.verified_amount == null ? '—' : money(d.verified_amount)),
        h('td', {}, h('span', { class: 'badge ' + d.status }, stLabel[d.status])), h('td', { class: 'small muted' }, when(d.created_at)),
        h('td', {}, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => donationModal(d, load) }, 'ตรวจสอบ'))))
        : [h('tr', {}, h('td', { colspan: 9, class: 'muted' }, 'ไม่มีรายการ'))]));
    };
    status.addEventListener('change', load); let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
    view.replaceChildren(h('h1', { class: 'pg' }, 'รายการโดเนท'),
      h('div', { class: 'toolbar' }, status, q, pendingFilter.supporter_id ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { pendingFilter.supporter_id = null; donations(); } }, '✕ ล้างตัวกรองสมาชิก') : null,
        h('button', { class: 'btn btn-sm btn-ghost', onclick: load }, '↻ รีเฟรช')),
      h('div', { class: 'glass panel tbl-wrap' }, h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ...['#', 'Username', 'แพ็กเกจ', 'ช่องทาง', 'ยอดที่แจ้ง', 'ยอดยืนยัน', 'สถานะ', 'วันที่', ''].map(x => h('th', {}, x)))), body)));
    load();
  }

  async function donationModal(d, reload) {
    const pk = await run(() => api('GET', '/packages')) || [];
    const verified = h('input', { type: 'number', min: 0, step: '0.01', value: d.verified_amount ?? d.claimed_amount });
    const pkgSel = h('select', {}, ...pk.map(p => h('option', { value: p.id }, \`\${p.emoji} \${p.name}\`))); pkgSel.value = d.package_id;
    const reason = h('input', { placeholder: 'เหตุผลที่ไม่อนุมัติ (แสดงให้ผู้ใช้เห็น)', maxlength: 200 });
    const done = () => { closeModal(); reload(); refreshBadge(); };

    const info = h('dl', { class: 'kv' },
      h('dt', {}, 'รายการ'), h('dd', {}, '#' + d.id), h('dt', {}, 'Username'), h('dd', {}, d.username),
      h('dt', {}, 'Discord ID'), h('dd', {}, d.discord_id || '—'), h('dt', {}, 'แพ็กเกจ'), h('dd', {}, d.package_name || '-'),
      h('dt', {}, 'ช่องทาง'), h('dd', {}, d.method_name || '-'), h('dt', {}, 'ยอดที่แจ้ง'), h('dd', {}, money(d.claimed_amount)),
      h('dt', {}, 'เลขอ้างอิง'), h('dd', {}, d.reference || '—'), h('dt', {}, 'หมายเหตุ'), h('dd', {}, d.note || '—'),
      h('dt', {}, 'แสดงชื่อสาธารณะ'), h('dd', {}, d.public ? 'อนุญาต' : 'ไม่อนุญาต'), h('dt', {}, 'ที่มา'), h('dd', {}, d.source === 'manual' ? 'เพิ่มโดยทีมงาน' : 'ฟอร์มเว็บ'),
      h('dt', {}, 'สถานะ'), h('dd', {}, h('span', { class: 'badge ' + d.status }, stLabel[d.status])),
      d.status !== 'pending' ? [h('dt', {}, 'ตรวจโดย'), h('dd', {}, \`\${d.reviewed_by} · \${when(d.reviewed_at)}\`)] : null,
      d.reject_reason ? [h('dt', {}, 'เหตุผล'), h('dd', {}, d.reject_reason)] : null,
      d.status === 'approved' ? [h('dt', {}, 'มอบยศ Discord'), h('dd', {}, d.role_status || '—'), h('dt', {}, 'แจ้งเตือน Discord'), h('dd', {}, d.notify_status || '—')] : null);

    const actions = d.status === 'pending' ? h('div', {},
      h('div', { class: 'row2' }, h('label', {}, 'ยอดที่ตรวจสอบแล้ว', verified), h('label', {}, 'ระดับแพ็กเกจ', pkgSel)),
      h('p', { class: 'muted small' }, 'ยอดที่นับเข้าระบบคือ "ยอดที่ตรวจสอบแล้ว" ที่คุณกรอกเท่านั้น ไม่ใช่ยอดที่ผู้ใช้แจ้ง'),
      h('div', { class: 'acts' },
        h('button', { class: 'btn btn-ok btn-sm', onclick: () => run(() => api('POST', \`/donations/\${d.id}/approve\`, { verified_amount: verified.value, package_id: pkgSel.value }).then(r => { toast('Discord: ' + (r.role_status || '-')); done(); }), 'อนุมัติแล้ว') }, '✓ อนุมัติ')),
      h('hr', { style: 'border:0;border-top:1px solid rgba(255,255,255,.08);margin:16px 0' }),
      h('label', {}, 'ปฏิเสธรายการ', reason),
      h('div', { class: 'acts', style: 'margin-top:10px' }, h('button', { class: 'btn btn-danger btn-sm', onclick: () => run(() => api('POST', \`/donations/\${d.id}/reject\`, { reason: reason.value }).then(done), 'ปฏิเสธแล้ว') }, '✕ ไม่อนุมัติ')))
      : d.status === 'approved' ? h('div', { class: 'acts' }, h('button', { class: 'btn btn-ghost btn-sm', onclick: () => run(() => api('POST', \`/donations/\${d.id}/retry-discord\`).then(r => { toast('Discord: ' + r.role_status); done(); })) }, '↻ ลองมอบยศ/แจ้งเตือน Discord ใหม่')) : null;

    openModal('ตรวจสอบรายการ #' + d.id, info,
      d.has_proof ? [h('p', { class: 'muted small' }, 'หลักฐาน'), h('img', { class: 'proof', src: \`/api/admin/donations/\${d.id}/proof\`, alt: 'หลักฐานการชำระเงิน' })] : h('p', { class: 'muted' }, 'ไม่มีไฟล์หลักฐาน (รายการที่ทีมงานเพิ่มเอง)'),
      actions);
  }

  /* =============== Packages =============== */
  async function packages() {
    view.replaceChildren(h('h1', { class: 'pg' }, 'แพ็กเกจ'));
    const list = await run(() => api('GET', '/packages')); if (!list) return;
    view.append(h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-sm', onclick: () => packageForm() }, '+ เพิ่มแพ็กเกจ')),
      h('div', { class: 'glass panel tbl-wrap' }, h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ...['ลำดับ', 'แพ็กเกจ', 'ราคา', 'Role ID', 'สิทธิพิเศษ', 'สถานะ', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, list.map(p => h('tr', {},
          h('td', {}, p.sort_order), h('td', {}, h('span', { class: 'pickrow' }, h('i', { class: 'sw', style: \`background:\${p.color};color:\${p.color}\` }), \`\${p.emoji} \${p.name}\`)),
          h('td', {}, p.price > 0 ? money(p.price) : 'ไม่กำหนด'), h('td', { class: 'small muted' }, p.discord_role_id || '—'),
          h('td', { class: 'small' }, p.perks.length + ' รายการ'), h('td', {}, p.active ? '✅ เปิด' : '⛔ ปิด'),
          h('td', {}, h('div', { class: 'acts' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => packageForm(p) }, 'แก้ไข'),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirm(\`ลบแพ็กเกจ "\${p.name}" ?\`) && run(() => api('DELETE', '/packages/' + p.id).then(packages), 'ลบแล้ว') }, 'ลบ')))))))));
  }
  function packageForm(p = {}) {
    const f = {
      name: h('input', { value: p.name || '', maxlength: 40, required: true }), emoji: h('input', { value: p.emoji || '', maxlength: 8 }),
      description: h('input', { value: p.description || '', maxlength: 120 }), price: h('input', { type: 'number', min: 0, step: '0.01', value: p.price ?? 0 }),
      color: h('input', { type: 'color', value: p.color || '#00d4ff' }), sort_order: h('input', { type: 'number', value: p.sort_order ?? 0 }),
      role: h('input', { value: p.discord_role_id || '', placeholder: 'Discord Role ID (ตัวเลข)', inputmode: 'numeric' }),
      perks: h('textarea', { rows: 5, placeholder: 'หนึ่งบรรทัดต่อหนึ่งสิทธิพิเศษ' }), active: h('input', { type: 'checkbox', checked: p.active ?? 1 })
    };
    f.perks.value = (p.perks || []).join('\\n');
    const msg = h('p', { class: 'form-msg', hidden: true });
    const form = h('form', { class: 'f', onsubmit: async e => {
      e.preventDefault(); msg.hidden = true;
      const body = { name: f.name.value, emoji: f.emoji.value, description: f.description.value, price: f.price.value, color: f.color.value, sort_order: f.sort_order.value, discord_role_id: f.role.value, perks: f.perks.value, active: f.active.checked };
      try { await api(p.id ? 'PUT' : 'POST', '/packages' + (p.id ? '/' + p.id : ''), body); closeModal(); toast('บันทึกแล้ว'); packages(); } catch (er) { msg.textContent = er.message; msg.hidden = false; }
    } },
      h('div', { class: 'row2' }, h('label', {}, 'ชื่อ *', f.name), h('label', {}, 'Emoji', f.emoji)),
      h('label', {}, 'คำอธิบายสั้น', f.description),
      h('div', { class: 'row2' }, h('label', {}, 'ราคา (0 = ไม่กำหนดตายตัว)', f.price), h('label', {}, 'สี', f.color)),
      h('div', { class: 'row2' }, h('label', {}, 'Discord Role ID (ยศที่จะมอบ)', f.role), h('label', {}, 'ลำดับ/ระดับ (เลขมาก = ระดับสูง)', f.sort_order)),
      h('label', {}, 'สิทธิพิเศษ', f.perks), h('label', { class: 'inline' }, f.active, 'เปิดให้สนับสนุน'), msg,
      h('button', { class: 'btn', type: 'submit' }, 'บันทึก'));
    openModal(p.id ? 'แก้ไขแพ็กเกจ' : 'เพิ่มแพ็กเกจ', form);
  }

  /* =============== Payment methods =============== */
  async function methods() {
    view.replaceChildren(h('h1', { class: 'pg' }, 'ช่องทางชำระเงิน'));
    const list = await run(() => api('GET', '/methods')); if (!list) return;
    view.append(h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-sm', onclick: () => methodForm() }, '+ เพิ่มช่องทาง')),
      h('div', { class: 'glass panel tbl-wrap' }, h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ...['ลำดับ', 'ช่องทาง', 'ประเภท', 'ลิงก์', 'สถานะ', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, list.map(m => h('tr', {}, h('td', {}, m.sort_order), h('td', {}, m.name), h('td', {}, m.kind), h('td', { class: 'small muted' }, m.link || '—'), h('td', {}, m.active ? '✅ เปิด' : '⛔ ปิด'),
          h('td', {}, h('div', { class: 'acts' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => methodForm(m) }, 'แก้ไข'),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirm(\`ลบช่องทาง "\${m.name}" ?\`) && run(() => api('DELETE', '/methods/' + m.id).then(methods), 'ลบแล้ว') }, 'ลบ')))))))));
  }
  function methodForm(m = {}) {
    const f = { name: h('input', { value: m.name || '', maxlength: 40, required: true }), kind: h('select', {}, ...['roblox', 'boost', 'other'].map(k => h('option', { value: k }, k))),
      link: h('input', { value: m.link || '', placeholder: 'https://…' }), sort: h('input', { type: 'number', value: m.sort_order ?? 0 }),
      ins: h('textarea', { rows: 5, maxlength: 800 }), active: h('input', { type: 'checkbox', checked: m.active ?? 1 }) };
    f.kind.value = m.kind || 'other'; f.ins.value = m.instructions || '';
    const msg = h('p', { class: 'form-msg', hidden: true });
    openModal(m.id ? 'แก้ไขช่องทาง' : 'เพิ่มช่องทาง', h('form', { class: 'f', onsubmit: async e => {
      e.preventDefault(); msg.hidden = true;
      try { await api(m.id ? 'PUT' : 'POST', '/methods' + (m.id ? '/' + m.id : ''), { name: f.name.value, kind: f.kind.value, link: f.link.value, sort_order: f.sort.value, instructions: f.ins.value, active: f.active.checked }); closeModal(); toast('บันทึกแล้ว'); methods(); }
      catch (er) { msg.textContent = er.message; msg.hidden = false; }
    } },
      h('div', { class: 'row2' }, h('label', {}, 'ชื่อ *', f.name), h('label', {}, 'ประเภท', f.kind)),
      h('label', {}, 'ลิงก์', f.link), h('label', {}, 'วิธีการ/คำแนะนำสำหรับผู้สนับสนุน', f.ins),
      h('div', { class: 'row2' }, h('label', {}, 'ลำดับ', f.sort), h('label', { class: 'inline' }, f.active, 'เปิดใช้งาน')), msg,
      h('button', { class: 'btn', type: 'submit' }, 'บันทึก')));
  }

  /* =============== Supporters =============== */
  async function supporters() {
    const q = h('input', { type: 'search', placeholder: 'ค้นหา Username…' }); const body = h('tbody');
    const load = async () => {
      const rows = await run(() => api('GET', '/supporters?q=' + encodeURIComponent(q.value.trim()))); if (!rows) return;
      body.replaceChildren(...(rows.length ? rows.map(s => h('tr', {},
        h('td', {}, s.username), h('td', { class: 'small muted' }, s.discord_id || '—'), h('td', {}, s.tier ? \`\${s.tier.emoji} \${s.tier.name}\` : '—'),
        h('td', {}, money(s.total)), h('td', {}, \`\${s.approved || 0}/\${s.submissions}\`),
        h('td', {}, h('input', { type: 'checkbox', checked: s.public, title: 'แสดงชื่อสาธารณะ', onchange: e => run(() => api('PATCH', '/supporters/' + s.id, { public: e.target.checked }), 'อัปเดตแล้ว') })),
        h('td', {}, h('div', { class: 'acts' },
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { pendingFilter.supporter_id = s.id; donations.last = ''; go('donations'); } }, 'ประวัติ'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { const v = prompt('Discord User ID ของ ' + s.username, s.discord_id); if (v !== null) run(() => api('PATCH', '/supporters/' + s.id, { discord_id: v.trim() }).then(load), 'บันทึกแล้ว'); } }, 'ตั้ง ID'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: () => confirm(\`ลบ \${s.username} และประวัติโดเนททั้งหมด? (ย้อนกลับไม่ได้)\`) && run(() => api('DELETE', '/supporters/' + s.id).then(load), 'ลบแล้ว') }, 'ลบ')))))
        : [h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'ยังไม่มีผู้สนับสนุน'))]));
    };
    let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
    view.replaceChildren(h('h1', { class: 'pg' }, 'ผู้สนับสนุน'),
      h('div', { class: 'toolbar' }, q, h('button', { class: 'btn btn-sm', onclick: manualForm }, '+ เพิ่มรายการด้วยตนเอง')),
      h('div', { class: 'glass panel tbl-wrap' }, h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ...['Username', 'Discord ID', 'ระดับ', 'ยอดรวม', 'อนุมัติ/ส่ง', 'แสดงชื่อ', ''].map(x => h('th', {}, x)))), body)));
    load();
  }
  async function manualForm() {
    const [pk, mt] = await Promise.all([run(() => api('GET', '/packages')), run(() => api('GET', '/methods'))]); if (!pk || !mt) return;
    const f = { user: h('input', { required: true, maxlength: 40 }), did: h('input', { inputmode: 'numeric', placeholder: 'ไม่บังคับ' }), pkg: h('select', {}, ...pk.map(p => h('option', { value: p.id }, \`\${p.emoji} \${p.name}\`))),
      mth: h('select', {}, ...mt.map(m => h('option', { value: m.id }, m.name))), amt: h('input', { type: 'number', min: 0, step: '0.01', required: true }), note: h('input', { maxlength: 300 }), pub: h('input', { type: 'checkbox' }) };
    const msg = h('p', { class: 'form-msg', hidden: true });
    openModal('เพิ่มรายการด้วยตนเอง', h('p', { class: 'muted small' }, 'สำหรับบันทึกการสนับสนุนจริงที่ได้รับนอกแบบฟอร์ม — รายการจะถูกอนุมัติทันที และมอบยศ Discord'),
      h('form', { class: 'f', onsubmit: async e => {
        e.preventDefault(); msg.hidden = true;
        try { const r = await api('POST', '/donations/manual', { username: f.user.value, discord_id: f.did.value, package_id: f.pkg.value, method_id: f.mth.value, amount: f.amt.value, note: f.note.value, public: f.pub.checked }); closeModal(); toast('เพิ่มแล้ว · Discord: ' + (r.role_status || '-')); supporters(); }
        catch (er) { msg.textContent = er.message; msg.hidden = false; }
      } },
        h('div', { class: 'row2' }, h('label', {}, 'Username *', f.user), h('label', {}, 'Discord User ID', f.did)),
        h('div', { class: 'row2' }, h('label', {}, 'แพ็กเกจ', f.pkg), h('label', {}, 'ช่องทาง', f.mth)),
        h('label', {}, 'ยอดที่ได้รับจริง *', f.amt), h('label', {}, 'หมายเหตุ', f.note),
        h('label', { class: 'inline' }, f.pub, 'ได้รับอนุญาตให้แสดงชื่อสาธารณะ'), msg, h('button', { class: 'btn', type: 'submit' }, 'บันทึก')));
  }

  /* =============== Settings =============== */
  async function settings() {
    view.replaceChildren(h('h1', { class: 'pg' }, 'ตั้งค่า'));
    const s = await run(() => api('GET', '/settings')); if (!s) return;
    const g = { title: h('input', { value: s.goal_title, maxlength: 60 }), amount: h('input', { type: 'number', min: 0, step: '0.01', value: s.goal_amount }), cur: h('input', { value: s.currency, maxlength: 6 }) };
    const p = { cur: h('input', { type: 'password', autocomplete: 'current-password' }), nxt: h('input', { type: 'password', autocomplete: 'new-password', minlength: 10 }) };
    view.append(
      h('form', { class: 'glass panel f', onsubmit: e => { e.preventDefault(); run(() => api('PUT', '/settings', { goal_title: g.title.value, goal_amount: g.amount.value, currency: g.cur.value }).then(() => { cfg.currency = g.cur.value || '฿'; }), 'บันทึกแล้ว'); } },
        h('h3', {}, 'เป้าหมายโดเนท (Donation Goal)'), h('div', { class: 'row2' }, h('label', {}, 'ชื่อเป้าหมาย', g.title), h('label', {}, 'เป้าหมายยอด (0 = ซ่อนแถบ)', g.amount)),
        h('label', {}, 'สัญลักษณ์สกุลเงิน', g.cur), h('button', { class: 'btn btn-sm', type: 'submit' }, 'บันทึก')),
      h('form', { class: 'glass panel f', onsubmit: e => { e.preventDefault(); run(() => api('POST', '/password', { current: p.cur.value, next: p.nxt.value }).then(() => { p.cur.value = p.nxt.value = ''; }), 'เปลี่ยนรหัสผ่านแล้ว'); } },
        h('h3', {}, 'เปลี่ยนรหัสผ่านแอดมิน'), h('div', { class: 'row2' }, h('label', {}, 'รหัสผ่านปัจจุบัน', p.cur), h('label', {}, 'รหัสผ่านใหม่ (≥10 ตัวอักษร)', p.nxt)),
        h('button', { class: 'btn btn-sm', type: 'submit' }, 'เปลี่ยนรหัสผ่าน')));
  }

  /* =============== Audit =============== */
  async function audit() {
    view.replaceChildren(h('h1', { class: 'pg' }, 'ประวัติการทำรายการ'));
    const rows = await run(() => api('GET', '/audit')); if (!rows) return;
    view.append(h('div', { class: 'glass panel tbl-wrap' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ...['เวลา', 'แอดมิน', 'การกระทำ', 'เป้าหมาย', 'รายละเอียด'].map(x => h('th', {}, x)))),
      h('tbody', {}, rows.map(r => h('tr', {}, h('td', { class: 'small muted' }, when(r.created_at)), h('td', {}, r.admin), h('td', {}, r.action), h('td', {}, r.target), h('td', { class: 'small muted' }, r.detail)))))));
  }

  boot();
  setInterval(() => { if (!$('#app-view').hidden) refreshBadge(); }, 60_000);
})();
` }
};

/* =========================================================
   4) SERVER
   ========================================================= */
const UPLOAD_DIR = path.join(DATA_DIR, 'proofs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/* ---------- JWT secret (env, or generated once and persisted with 0600) ---------- */
function loadSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, '.jwt_secret');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
    console.warn('[security] JWT_SECRET not set — generated one in data/.jwt_secret. Set JWT_SECRET in .env for production.');
  }
  return fs.readFileSync(f, 'utf8').trim();
}
const JWT_SECRET = loadSecret();

/* ---------- Bootstrap first admin from env ---------- */
(function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  if (count) return;
  const u = process.env.ADMIN_USERNAME, p = process.env.ADMIN_PASSWORD;
  if (!u || !p) { console.warn('[admin] No admin exists. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env then restart.'); return; }
  if (p.length < 10) { console.error('[admin] ADMIN_PASSWORD must be at least 10 characters.'); return; }
  db.prepare('INSERT INTO admins (username,password_hash) VALUES (?,?)').run(u, bcrypt.hashSync(p, 12));
  audit('system', 'admin.bootstrap', u);
  console.log(`[admin] Created admin "${u}". You may now remove ADMIN_PASSWORD from .env.`);
})();

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://discord.com', 'https://apis.roproxy.com', 'https://games.roproxy.com', 'https://thumbnails.roproxy.com'],
      mediaSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  hsts: IS_PROD
}));
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null; };
const currency = () => getSetting('currency') || '฿';

/* =========================================================
   PUBLIC API
   ========================================================= */
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

function parsePerks(p) { try { const a = JSON.parse(p); return Array.isArray(a) ? a : []; } catch { return []; } }
const pubPackage = p => ({ id: p.id, name: p.name, emoji: p.emoji, description: p.description, price: p.price, color: p.color, perks: parsePerks(p.perks) });

function tierFor(supporterId) {
  return db.prepare(`SELECT p.name, p.emoji, p.color FROM donations d JOIN packages p ON p.id=d.package_id
    WHERE d.supporter_id=? AND d.status='approved' ORDER BY p.sort_order DESC LIMIT 1`).get(supporterId) || null;
}

function summary() {
  const t = db.prepare(`SELECT COALESCE(SUM(verified_amount),0) total, COUNT(DISTINCT supporter_id) supporters FROM donations WHERE status='approved'`).get();
  const goal = Number(getSetting('goal_amount')) || 0;
  return {
    total: t.total, supporters: t.supporters, goal, goalTitle: getSetting('goal_title') || 'Donation Goal',
    progress: goal > 0 ? Math.min(100, Math.round((t.total / goal) * 1000) / 10) : null,
    currency: currency()
  };
}

app.get('/api/public/summary', (req, res) => res.json(summary()));
app.get('/api/public/packages', (req, res) =>
  res.json(db.prepare('SELECT * FROM packages WHERE active=1 ORDER BY sort_order, id').all().map(pubPackage)));
app.get('/api/public/methods', (req, res) =>
  res.json(db.prepare('SELECT id,name,kind,instructions,link FROM payment_methods WHERE active=1 ORDER BY sort_order, id').all()));

app.get('/api/public/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.username, s.avatar_url, SUM(d.verified_amount) total, COUNT(d.id) donations
    FROM supporters s JOIN donations d ON d.supporter_id=s.id AND d.status='approved'
    WHERE s.public=1 GROUP BY s.id
    ORDER BY total DESC, donations DESC, MIN(d.reviewed_at) ASC LIMIT 50`).all();
  res.json(rows.map((r, i) => ({ rank: i + 1, username: r.username, avatar: r.avatar_url, total: r.total, donations: r.donations, tier: tierFor(r.id) })));
});

/* Live feed (SSE) for "new supporter" animation */
const clients = new Set();
app.get('/api/public/stream', (req, res) => {
  if (clients.size >= 500) return res.status(503).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000).unref();
function broadcast(event) { const msg = `data: ${JSON.stringify(event)}\n\n`; for (const c of clients) c.write(msg); }

/* ---------- Submit donation (with proof) ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 12 } });
const submitLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'ส่งรายการบ่อยเกินไป กรุณาลองใหม่ภายหลัง' } });

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'gif';
  return null;
}

app.post('/api/donations', submitLimiter, upload.single('proof'), ah(async (req, res) => {
  const b = req.body || {};
  const idem = str(b.idem_key, 64);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(idem)) return bad(res, 'คำขอไม่ถูกต้อง');

  // idempotent replay → return the original result
  const prev = db.prepare('SELECT status_token, status FROM donations WHERE idem_key=?').get(idem);
  if (prev) return res.json({ ok: true, token: prev.status_token, status: prev.status, duplicate: true });

  const username = str(b.username, 40).replace(/^@/, '');
  if (!/^[A-Za-z0-9_.\-#]{2,40}$/.test(username)) return bad(res, 'Username ไม่ถูกต้อง (ใช้ได้เฉพาะ a-z 0-9 _ . - #)');
  const discordId = str(b.discord_id, 25);
  if (discordId && !/^\d{15,25}$/.test(discordId)) return bad(res, 'Discord User ID ต้องเป็นตัวเลข 15–25 หลัก');

  const pkg = db.prepare('SELECT * FROM packages WHERE id=? AND active=1').get(Number(b.package_id));
  if (!pkg) return bad(res, 'ไม่พบแพ็กเกจที่เลือก');
  const method = db.prepare('SELECT * FROM payment_methods WHERE id=? AND active=1').get(Number(b.method_id));
  if (!method) return bad(res, 'ไม่พบช่องทางที่เลือก');

  // amount: server-side price wins; client number is only a claim when the package has no fixed price
  let claimed = pkg.price > 0 ? pkg.price : num(b.amount === undefined || b.amount === '' ? 0 : b.amount, 0, 1_000_000);
  if (claimed === null) return bad(res, 'ยอดเงินไม่ถูกต้อง');

  const reference = str(b.reference, 80);
  if (reference) {
    const dup = db.prepare(`SELECT id FROM donations WHERE method_id=? AND reference=? AND status<>'rejected'`).get(method.id, reference);
    if (dup) return bad(res, 'เลขอ้างอิงนี้ถูกใช้ส่งรายการแล้ว', 409);
  }

  if (!req.file) return bad(res, 'กรุณาแนบภาพหลักฐาน');
  const ext = sniffImage(req.file.buffer);
  if (!ext) return bad(res, 'รองรับเฉพาะไฟล์ภาพ JPG, PNG, WEBP, GIF');
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  if (db.prepare('SELECT 1 FROM donations WHERE proof_hash=?').get(hash)) return bad(res, 'หลักฐานนี้เคยถูกส่งมาแล้ว', 409);

  const file = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.file.buffer, { mode: 0o600 });
  const token = crypto.randomBytes(18).toString('hex');
  const consent = b.consent === '1' || b.consent === 'true' || b.consent === 'on' ? 1 : 0;

  let id;
  try {
    id = db.transaction(() => {
      let s = db.prepare('SELECT * FROM supporters WHERE username=?').get(username);
      if (!s) {
        const r = db.prepare('INSERT INTO supporters (username,discord_id,public) VALUES (?,?,?)').run(username, discordId, consent);
        s = { id: r.lastInsertRowid };
      } else {
        db.prepare('UPDATE supporters SET public=?, discord_id=CASE WHEN ?<>\'\' THEN ? ELSE discord_id END WHERE id=?').run(consent, discordId, discordId, s.id);
      }
      return db.prepare(`INSERT INTO donations (idem_key,status_token,supporter_id,package_id,method_id,claimed_amount,reference,proof_file,proof_hash,note)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(idem, token, s.id, pkg.id, method.id, claimed, reference, file, hash, str(b.note, 300)).lastInsertRowid;
    })();
  } catch (e) {
    fs.rmSync(path.join(UPLOAD_DIR, file), { force: true });
    if (String(e.message).includes('UNIQUE')) return bad(res, 'รายการนี้ถูกส่งซ้ำ', 409);
    throw e;
  }

  // fire-and-forget staff notification
  discord.notifyStaffNewDonation({ id, username, package_name: pkg.name, method_name: method.name, claimed_amount: claimed, currency: currency() })
    .then(r => db.prepare('UPDATE donations SET notify_status=? WHERE id=?').run(r, id))
    .catch(e => db.prepare('UPDATE donations SET notify_status=? WHERE id=?').run('error: ' + e.message.slice(0, 120), id));

  res.status(201).json({ ok: true, token, status: 'pending' });
}));

app.get('/api/donations/status/:token', (req, res) => {
  if (!/^[a-f0-9]{36}$/.test(req.params.token)) return bad(res, 'not found', 404);
  const d = db.prepare(`SELECT d.id, d.status, d.reject_reason, d.created_at, d.reviewed_at, p.name package FROM donations d
    LEFT JOIN packages p ON p.id=d.package_id WHERE d.status_token=?`).get(req.params.token);
  if (!d) return bad(res, 'not found', 404);
  res.json({ status: d.status, reason: d.status === 'rejected' ? d.reject_reason : '', package: d.package, created_at: d.created_at, reviewed_at: d.reviewed_at });
});

/* =========================================================
   ADMIN API
   ========================================================= */
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'พยายามเข้าสู่ระบบมากเกินไป ลองใหม่ใน 15 นาที' } });
const COOKIE = 'hg_admin';
const cookieOpts = () => ({ httpOnly: true, sameSite: 'strict', secure: IS_PROD || process.env.COOKIE_SECURE === '1', maxAge: 8 * 3600_000, path: '/' });

function requireAdmin(req, res, next) {
  // CSRF: custom header cannot be sent cross-site without CORS preflight; cookie is SameSite=Strict as well
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'hg') return bad(res, 'forbidden', 403);
  try {
    const p = jwt.verify(req.cookies[COOKIE] || '', JWT_SECRET, { algorithms: ['HS256'] });
    const a = db.prepare('SELECT id, username FROM admins WHERE id=?').get(p.id);
    if (!a) throw 0;
    req.admin = a; next();
  } catch { return bad(res, 'unauthorized', 401); }
}

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 12);
const adminApi = express.Router();
adminApi.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

adminApi.post('/login', loginLimiter, (req, res) => {
  if (req.get('x-requested-with') !== 'hg') return bad(res, 'forbidden', 403);
  const a = db.prepare('SELECT * FROM admins WHERE username=?').get(str(req.body.username, 60));
  // constant-ish time: always run a compare
  const ok = bcrypt.compareSync(String(req.body.password || ''), a ? a.password_hash : DUMMY_HASH);
  if (!a || !ok) { audit(str(req.body.username, 60) || '?', 'login.failed'); return bad(res, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 401); }
  const token = jwt.sign({ id: a.id }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '8h' });
  res.cookie(COOKIE, token, cookieOpts());
  audit(a.username, 'login');
  res.json({ ok: true, username: a.username });
});
adminApi.post('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

adminApi.use(requireAdmin);

adminApi.get('/me', (req, res) => res.json({ username: req.admin.username, discord: discord.enabled(), currency: currency() }));

adminApi.post('/password', (req, res) => {
  const a = db.prepare('SELECT * FROM admins WHERE id=?').get(req.admin.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), a.password_hash)) return bad(res, 'รหัสผ่านปัจจุบันไม่ถูกต้อง', 403);
  const np = String(req.body.next || '');
  if (np.length < 10) return bad(res, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 10 ตัวอักษร');
  db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(bcrypt.hashSync(np, 12), a.id);
  audit(a.username, 'password.change');
  res.json({ ok: true });
});

adminApi.get('/overview', (req, res) => {
  const s = summary();
  const pending = db.prepare(`SELECT COUNT(*) c FROM donations WHERE status='pending'`).get().c;
  const rejected = db.prepare(`SELECT COUNT(*) c FROM donations WHERE status='rejected'`).get().c;
  const approved = db.prepare(`SELECT COUNT(*) c FROM donations WHERE status='approved'`).get().c;
  res.json({ ...s, pending, approved, rejected, discord: discord.enabled() });
});

/* ---- Donations ---- */
const donationSelect = `
  SELECT d.*, s.username, s.discord_id, s.avatar_url, s.public, p.name package_name, p.emoji package_emoji, m.name method_name
  FROM donations d JOIN supporters s ON s.id=d.supporter_id
  LEFT JOIN packages p ON p.id=d.package_id LEFT JOIN payment_methods m ON m.id=d.method_id`;

adminApi.get('/donations', (req, res) => {
  const where = [], args = [];
  if (['pending', 'approved', 'rejected'].includes(req.query.status)) { where.push('d.status=?'); args.push(req.query.status); }
  if (req.query.q) { where.push('s.username LIKE ?'); args.push('%' + str(req.query.q, 40).replace(/[%_]/g, '') + '%'); }
  if (req.query.supporter_id) { where.push('d.supporter_id=?'); args.push(Number(req.query.supporter_id)); }
  const rows = db.prepare(`${donationSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id DESC LIMIT 200`).all(...args);
  res.json(rows.map(({ proof_hash, idem_key, status_token, ...r }) => ({ ...r, has_proof: !!r.proof_file })));
});

adminApi.get('/donations/:id/proof', (req, res) => {
  const d = db.prepare('SELECT proof_file FROM donations WHERE id=?').get(Number(req.params.id));
  if (!d || !d.proof_file || !/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(d.proof_file)) return res.status(404).end();
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' });
  res.sendFile(path.join(UPLOAD_DIR, d.proof_file));
});

async function runDiscordForDonation(id) {
  const d = db.prepare(`${donationSelect} WHERE d.id=?`).get(id);
  const pkg = d.package_id ? db.prepare('SELECT discord_role_id FROM packages WHERE id=?').get(d.package_id) : null;
  const r = await discord.onApproved({ ...d, role_id: pkg?.discord_role_id || '' });
  db.prepare('UPDATE donations SET role_status=?, notify_status=? WHERE id=?').run(r.role_status, r.notify_status, id);
  db.prepare('UPDATE supporters SET discord_id=?, avatar_url=? WHERE id=?').run(r.discord_id, r.avatar_url, d.supporter_id);
  return r;
}

adminApi.post('/donations/:id/approve', ah(async (req, res) => {
  const id = Number(req.params.id);
  const d = db.prepare('SELECT * FROM donations WHERE id=?').get(id);
  if (!d) return bad(res, 'ไม่พบรายการ', 404);
  const amount = num(req.body.verified_amount, 0, 1_000_000);
  if (amount === null) return bad(res, 'ยอดที่ยืนยันไม่ถูกต้อง');
  let pkgId = d.package_id;
  if (req.body.package_id) {
    const p = db.prepare('SELECT id FROM packages WHERE id=?').get(Number(req.body.package_id));
    if (!p) return bad(res, 'ไม่พบแพ็กเกจ'); pkgId = p.id;
  }
  // atomic: only a pending row can be approved (prevents double approve / race)
  const r = db.prepare(`UPDATE donations SET status='approved', verified_amount=?, package_id=?, reviewed_by=?, reviewed_at=datetime('now'), reject_reason=''
    WHERE id=? AND status='pending'`).run(amount, pkgId, req.admin.username, id);
  if (!r.changes) return bad(res, 'รายการนี้ถูกดำเนินการไปแล้ว', 409);
  audit(req.admin.username, 'donation.approve', id, `amount=${amount}`);

  const out = await runDiscordForDonation(id).catch(e => ({ role_status: 'error: ' + e.message.slice(0, 100), notify_status: '' }));
  const full = db.prepare(`${donationSelect} WHERE d.id=?`).get(id);
  broadcast({ type: 'supporter', name: full.public ? full.username : null, tier: full.package_name, emoji: full.package_emoji, summary: summary() });
  res.json({ ok: true, role_status: out.role_status, notify_status: out.notify_status });
}));

adminApi.post('/donations/:id/reject', (req, res) => {
  const reason = str(req.body.reason, 200);
  const r = db.prepare(`UPDATE donations SET status='rejected', reject_reason=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=? AND status='pending'`)
    .run(reason, req.admin.username, Number(req.params.id));
  if (!r.changes) return bad(res, 'รายการนี้ถูกดำเนินการไปแล้ว', 409);
  audit(req.admin.username, 'donation.reject', req.params.id, reason);
  res.json({ ok: true });
});

adminApi.post('/donations/:id/retry-discord', ah(async (req, res) => {
  const d = db.prepare('SELECT status FROM donations WHERE id=?').get(Number(req.params.id));
  if (!d || d.status !== 'approved') return bad(res, 'ใช้ได้กับรายการที่อนุมัติแล้วเท่านั้น');
  const r = await runDiscordForDonation(Number(req.params.id));
  audit(req.admin.username, 'donation.retry-discord', req.params.id, r.role_status);
  res.json({ ok: true, ...r });
}));

/* Manual record (real, entered by staff — e.g. donation received outside the form) */
adminApi.post('/donations/manual', ah(async (req, res) => {
  const username = str(req.body.username, 40).replace(/^@/, '');
  if (!/^[A-Za-z0-9_.\-#]{2,40}$/.test(username)) return bad(res, 'Username ไม่ถูกต้อง');
  const pkg = db.prepare('SELECT id FROM packages WHERE id=?').get(Number(req.body.package_id));
  if (!pkg) return bad(res, 'ไม่พบแพ็กเกจ');
  const amount = num(req.body.amount, 0, 1_000_000);
  if (amount === null) return bad(res, 'ยอดไม่ถูกต้อง');
  const discordId = str(req.body.discord_id, 25);
  if (discordId && !/^\d{15,25}$/.test(discordId)) return bad(res, 'Discord ID ไม่ถูกต้อง');
  const method = db.prepare('SELECT id FROM payment_methods WHERE id=?').get(Number(req.body.method_id));
  const pub = req.body.public ? 1 : 0;
  const id = db.transaction(() => {
    let s = db.prepare('SELECT id FROM supporters WHERE username=?').get(username);
    if (!s) s = { id: db.prepare('INSERT INTO supporters (username,discord_id,public) VALUES (?,?,?)').run(username, discordId, pub).lastInsertRowid };
    else db.prepare('UPDATE supporters SET public=? WHERE id=?').run(pub, s.id);
    return db.prepare(`INSERT INTO donations (idem_key,status_token,supporter_id,package_id,method_id,claimed_amount,verified_amount,note,status,source,reviewed_by,reviewed_at)
      VALUES (?,?,?,?,?,?,?,?, 'approved','manual',?,datetime('now'))`)
      .run(crypto.randomUUID(), crypto.randomBytes(18).toString('hex'), s.id, pkg.id, method?.id ?? null, amount, amount, str(req.body.note, 300), req.admin.username).lastInsertRowid;
  })();
  audit(req.admin.username, 'donation.manual', id, `${username} ${amount}`);
  const out = await runDiscordForDonation(id).catch(e => ({ role_status: 'error: ' + e.message.slice(0, 100) }));
  const full = db.prepare(`${donationSelect} WHERE d.id=?`).get(id);
  broadcast({ type: 'supporter', name: full.public ? full.username : null, tier: full.package_name, emoji: full.package_emoji, summary: summary() });
  res.status(201).json({ ok: true, id, role_status: out.role_status });
}));

/* ---- Packages ---- */
function readPackage(b) {
  const name = str(b.name, 40);
  if (!name) return { error: 'กรุณากรอกชื่อแพ็กเกจ' };
  const price = num(b.price, 0, 1_000_000);
  if (price === null) return { error: 'ราคาไม่ถูกต้อง' };
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#00d4ff';
  const role = str(b.discord_role_id, 25);
  if (role && !/^\d{15,25}$/.test(role)) return { error: 'Discord Role ID ต้องเป็นตัวเลข' };
  const perks = (Array.isArray(b.perks) ? b.perks : String(b.perks || '').split('\n')).map(s => str(s, 120)).filter(Boolean).slice(0, 15);
  return { v: [name, str(b.emoji, 8), str(b.description, 120), price, color, JSON.stringify(perks), role, b.active === false || b.active === 0 ? 0 : 1, Number(b.sort_order) || 0] };
}
adminApi.get('/packages', (req, res) => res.json(db.prepare('SELECT * FROM packages ORDER BY sort_order, id').all().map(p => ({ ...p, perks: parsePerks(p.perks) }))));
adminApi.post('/packages', (req, res) => {
  const r = readPackage(req.body); if (r.error) return bad(res, r.error);
  const id = db.prepare('INSERT INTO packages (name,emoji,description,price,color,perks,discord_role_id,active,sort_order) VALUES (?,?,?,?,?,?,?,?,?)').run(...r.v).lastInsertRowid;
  audit(req.admin.username, 'package.create', id, r.v[0]); res.status(201).json({ ok: true, id });
});
adminApi.put('/packages/:id', (req, res) => {
  const r = readPackage(req.body); if (r.error) return bad(res, r.error);
  const x = db.prepare('UPDATE packages SET name=?,emoji=?,description=?,price=?,color=?,perks=?,discord_role_id=?,active=?,sort_order=? WHERE id=?').run(...r.v, Number(req.params.id));
  if (!x.changes) return bad(res, 'not found', 404);
  audit(req.admin.username, 'package.update', req.params.id, r.v[0]); res.json({ ok: true });
});
adminApi.delete('/packages/:id', (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM donations WHERE package_id=?').get(id)) return bad(res, 'แพ็กเกจนี้มีรายการโดเนทอ้างอิงอยู่ ลบไม่ได้ — ให้ปิดการใช้งานแทน', 409);
  db.prepare('DELETE FROM packages WHERE id=?').run(id);
  audit(req.admin.username, 'package.delete', id); res.json({ ok: true });
});

/* ---- Payment methods ---- */
function readMethod(b) {
  const name = str(b.name, 40); if (!name) return { error: 'กรุณากรอกชื่อช่องทาง' };
  const link = str(b.link, 300);
  if (link && !/^https?:\/\//i.test(link)) return { error: 'ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://' };
  const kind = ['roblox', 'boost', 'other'].includes(b.kind) ? b.kind : 'other';
  return { v: [name, kind, str(b.instructions, 800), link, b.active === false || b.active === 0 ? 0 : 1, Number(b.sort_order) || 0] };
}
adminApi.get('/methods', (req, res) => res.json(db.prepare('SELECT * FROM payment_methods ORDER BY sort_order, id').all()));
adminApi.post('/methods', (req, res) => {
  const r = readMethod(req.body); if (r.error) return bad(res, r.error);
  const id = db.prepare('INSERT INTO payment_methods (name,kind,instructions,link,active,sort_order) VALUES (?,?,?,?,?,?)').run(...r.v).lastInsertRowid;
  audit(req.admin.username, 'method.create', id, r.v[0]); res.status(201).json({ ok: true, id });
});
adminApi.put('/methods/:id', (req, res) => {
  const r = readMethod(req.body); if (r.error) return bad(res, r.error);
  const x = db.prepare('UPDATE payment_methods SET name=?,kind=?,instructions=?,link=?,active=?,sort_order=? WHERE id=?').run(...r.v, Number(req.params.id));
  if (!x.changes) return bad(res, 'not found', 404);
  audit(req.admin.username, 'method.update', req.params.id, r.v[0]); res.json({ ok: true });
});
adminApi.delete('/methods/:id', (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM donations WHERE method_id=?').get(id)) return bad(res, 'ช่องทางนี้มีรายการอ้างอิงอยู่ — ให้ปิดการใช้งานแทน', 409);
  db.prepare('DELETE FROM payment_methods WHERE id=?').run(id);
  audit(req.admin.username, 'method.delete', id); res.json({ ok: true });
});

/* ---- Supporters ---- */
adminApi.get('/supporters', (req, res) => {
  const q = '%' + str(req.query.q, 40).replace(/[%_]/g, '') + '%';
  const rows = db.prepare(`
    SELECT s.id, s.username, s.discord_id, s.avatar_url, s.public,
      COALESCE(SUM(CASE WHEN d.status='approved' THEN d.verified_amount END),0) total,
      SUM(d.status='approved') approved, COUNT(d.id) submissions
    FROM supporters s LEFT JOIN donations d ON d.supporter_id=s.id
    WHERE s.username LIKE ? GROUP BY s.id ORDER BY total DESC, s.id DESC LIMIT 200`).all(q);
  res.json(rows.map(r => ({ ...r, tier: tierFor(r.id) })));
});
adminApi.patch('/supporters/:id', (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare('SELECT * FROM supporters WHERE id=?').get(id);
  if (!s) return bad(res, 'not found', 404);
  const pub = req.body.public === undefined ? s.public : (req.body.public ? 1 : 0);
  const did = req.body.discord_id === undefined ? s.discord_id : str(req.body.discord_id, 25);
  if (did && !/^\d{15,25}$/.test(did)) return bad(res, 'Discord ID ไม่ถูกต้อง');
  db.prepare('UPDATE supporters SET public=?, discord_id=? WHERE id=?').run(pub, did, id);
  audit(req.admin.username, 'supporter.update', s.username, `public=${pub}`); res.json({ ok: true });
});
adminApi.delete('/supporters/:id', (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare('SELECT username FROM supporters WHERE id=?').get(id);
  if (!s) return bad(res, 'not found', 404);
  const files = db.prepare('SELECT proof_file FROM donations WHERE supporter_id=?').all(id);
  db.transaction(() => { db.prepare('DELETE FROM donations WHERE supporter_id=?').run(id); db.prepare('DELETE FROM supporters WHERE id=?').run(id); })();
  for (const f of files) if (/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(f.proof_file)) fs.rmSync(path.join(UPLOAD_DIR, f.proof_file), { force: true });
  audit(req.admin.username, 'supporter.delete', s.username); res.json({ ok: true });
});

/* ---- Settings & audit ---- */
adminApi.get('/settings', (req, res) => res.json({ goal_title: getSetting('goal_title'), goal_amount: Number(getSetting('goal_amount')) || 0, currency: currency() }));
adminApi.put('/settings', (req, res) => {
  const goal = num(req.body.goal_amount, 0, 1_000_000_000);
  if (goal === null) return bad(res, 'เป้าหมายไม่ถูกต้อง');
  setSetting('goal_amount', goal);
  setSetting('goal_title', str(req.body.goal_title, 60) || 'Donation Goal');
  setSetting('currency', str(req.body.currency, 6) || '฿');
  audit(req.admin.username, 'settings.update', '', `goal=${goal}`);
  broadcast({ type: 'summary', summary: summary() });
  res.json({ ok: true });
});
adminApi.get('/audit', (req, res) => res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all()));

app.use('/api/admin', adminApi);

/* =========================================================
   Static + errors
   ========================================================= */
const sendAsset = (name, extra = {}) => (req, res) => {
  const a = ASSETS[name];
  res.set({ 'Content-Type': a.type, 'Cache-Control': IS_PROD ? 'public, max-age=3600' : 'no-cache', ...extra }).send(a.body);
};
app.get('/', sendAsset('index.html'));
app.get('/index.html', sendAsset('index.html'));
app.get('/admin', sendAsset('admin.html', { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }));
app.get('/donate', sendAsset('donate.html'));
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api/\n'));
for (const name of Object.keys(ASSETS)) if (!name.endsWith('.html')) app.get('/' + name, sendAsset(name));

app.use('/api', (req, res) => bad(res, 'not found', 404));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return bad(res, err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 5MB' : 'อัปโหลดไม่สำเร็จ');
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
});

app.listen(PORT, () => console.log(`HI GARDEN running on http://localhost:${PORT}  (discord integration: ${discord.enabled() ? 'ON' : 'OFF'})`));
