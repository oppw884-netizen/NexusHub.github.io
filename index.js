<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>
<title>Donator (Copy)</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Mali:wght@600;700&family=Noto+Sans+Thai:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* Layout: single left-aligned column; a soft tulip-pink header block, then two channel cards of different weight, then a short "after you support" note. */
  :root {
    --bg: #fff5f8;
    --surface: #ffffff;
    --ink: #3a1f2b;
    --muted: #7d5b69;
    --pink: #d9356f;
    --pink-ink: #ffffff;
    --blush: #ffdce8;
    --line: #f3cfdc;
    --leaf: #4f9a6b;
    --font-display: "Mali", "Noto Sans Thai", system-ui, sans-serif;
    --font-body: "Noto Sans Thai", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #1e1219; --surface: #2a1a23; --ink: #fbe8ef; --muted: #c9a3b3;
      --pink: #ff7ca8; --pink-ink: #2a0f1a; --blush: #4a2433; --line: #4a2c3a; --leaf: #7fc99a;
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #1e1219; --surface: #2a1a23; --ink: #fbe8ef; --muted: #c9a3b3;
    --pink: #ff7ca8; --pink-ink: #2a0f1a; --blush: #4a2433; --line: #4a2c3a; --leaf: #7fc99a;
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-body);
    font-size: 16px;
    line-height: 1.7;
    padding-block: 40px 56px;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
  .wrap { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; }

  header { display: flex; gap: 20px; align-items: flex-start; }
  header svg { flex: none; width: 64px; height: 64px; }
  .eyebrow { font-size: 13px; letter-spacing: .08em; color: var(--pink); font-weight: 600; margin: 0; }
  h1 {
    font-family: var(--font-display); font-weight: 700;
    font-size: clamp(30px, 6vw, 44px); line-height: 1.25; margin: 2px 0 8px;
    text-wrap: balance;
  }
  .lead { margin: 0; color: var(--muted); max-width: 52ch; }

  .channels { display: grid; grid-template-columns: 1fr; gap: 16px; }
  @media (min-width: 640px) { .channels { grid-template-columns: 1fr 1fr; } }

  .card {
    background: var(--surface); border: 1px solid var(--line); border-radius: 18px;
    padding: 24px; display: flex; flex-direction: column; gap: 14px; min-width: 0;
  }
  .card .icon {
    width: 44px; height: 44px; border-radius: 12px; background: var(--blush);
    display: grid; place-items: center; color: var(--pink);
  }
  .card h2 { font-family: var(--font-display); font-size: 22px; line-height: 1.3; margin: 0; }
  .card p { margin: 0; color: var(--muted); font-size: 15px; }
  .card ol { margin: 0; padding-left: 1.3em; color: var(--muted); font-size: 15px; display: flex; flex-direction: column; gap: 4px; }
  .card .spacer { flex: 1; }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 46px; padding: 10px 20px; border-radius: 999px; border: 0;
    background: var(--pink); color: var(--pink-ink); font: 600 15px var(--font-body);
    text-decoration: none; cursor: pointer; width: fit-content;
  }
  .btn:hover { filter: brightness(1.06); }
  .btn:focus-visible, .copy:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
  .btn[aria-disabled="true"] { background: var(--blush); color: var(--muted); cursor: default; filter: none; }

  .after {
    border-top: 1px dashed var(--line); padding-top: 24px;
    display: grid; gap: 6px;
  }
  .after h3 { font-family: var(--font-display); font-size: 18px; margin: 0; }
  .after p { margin: 0; color: var(--muted); max-width: 60ch; }
  .tag {
    display: inline-block; background: var(--blush); color: var(--pink);
    font-weight: 600; font-size: 14px; padding: 1px 10px; border-radius: 999px;
  }
  footer { color: var(--muted); font-size: 13px; }

  @media (prefers-reduced-motion: no-preference) {
    .btn { transition: filter .15s; }
  }
</style>

<main class="wrap">
  <header>
    <svg viewBox="0 0 64 64" role="img" aria-label="ดอกทิวลิป">
      <path d="M32 60V34" stroke="var(--leaf)" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M32 52c-8 0-13-4-14-10 7 0 12 3 14 10z" fill="var(--leaf)"/>
      <path d="M32 46c7 0 12-4 13-9-6 0-11 3-13 9z" fill="var(--leaf)" opacity=".85"/>
      <path d="M17 14c0 12 4 21 15 21s15-9 15-21l-8 6-7-9-7 9z" fill="var(--pink)"/>
      <path d="M32 11l-7 9 7 15 7-15z" fill="var(--blush)" opacity=".55"/>
    </svg>
    <div>
      <p class="eyebrow">DONATOR</p>
      <h1>ช่องทางการสนับสนุน</h1>
      <p class="lead">ขอบคุณที่อยากช่วยให้เซิร์ฟเวอร์ของเราไปต่อ เลือกช่องทางที่สะดวกได้เลย</p>
    </div>
  </header>

  <section class="channels" aria-label="ช่องทางสนับสนุน">
    <article class="card">
      <div class="icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z"/><path d="M12 12l8.5-4.6M12 12L3.5 7.4M12 12v9.5"/></svg>
      </div>
      <h2>ROBLOX</h2>
      <p>สนับสนุนผ่าน ROBLOX ตามช่องทางที่ทีมงานประกาศไว้ กดปุ่มด้านล่างเพื่อเปิดหน้าสนับสนุน</p>
      <div class="spacer"></div>
      <a id="roblox-btn" class="btn" href="#" target="_blank" rel="noopener">เปิดหน้า ROBLOX</a>
    </article>

    <article class="card">
      <div class="icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20M9 3l3 6 3-6M12 21L9 9M12 21l3-12"/></svg>
      </div>
      <h2>เม็ดบูสต์เซิร์ฟเวอร์</h2>
      <p>บูสต์เซิร์ฟเวอร์ Discord ได้โดยตรงจากแอป</p>
      <ol>
        <li>เปิดเมนูที่ชื่อเซิร์ฟเวอร์</li>
        <li>เลือก “บูสต์เซิร์ฟเวอร์”</li>
        <li>ยืนยันการบูสต์</li>
      </ol>
      <div class="spacer"></div>
      <a id="discord-btn" class="btn" href="#" target="_blank" rel="noopener">เปิด Discord เซิร์ฟเวอร์</a>
    </article>
  </section>

  <section class="after">
    <h3>สนับสนุนแล้วต้องทำอะไรต่อ</h3>
    <p>แจ้งทีมงานในเซิร์ฟเวอร์ พร้อมหลักฐานการสนับสนุน เพื่อรับยศ <span class="tag">Donator</span> ได้เลยครับ</p>
  </section>

  <footer>พิมพ์ <strong>/donator</strong> ในเซิร์ฟเวอร์เพื่อดูช่องทางเหล่านี้อีกครั้ง</footer>
</main>

<script>
  // ใส่ลิงก์จริงตรงนี้ (เว้นว่างไว้ = ปุ่มจะแสดงเป็น "เร็ว ๆ นี้")
  var LINKS = {
    roblox: 'https://www.roblox.com/games/84130588253982/HI-Garden',   // เช่น https://www.roblox.com/...
    discord: 'https://dc.gg/higarden'   // เช่น https://discord.gg/xxxxxx
  };
  [['roblox-btn', LINKS.roblox], ['discord-btn', LINKS.discord]].forEach(function (p) {
    var el = document.getElementById(p[0]);
    if (p[1]) { el.href = p[1]; return; }
    el.removeAttribute('href');
    el.removeAttribute('target');
    el.setAttribute('aria-disabled', 'true');
    el.textContent = 'ลิงก์จะประกาศเร็ว ๆ นี้';
  });
</script>

</body></html>
