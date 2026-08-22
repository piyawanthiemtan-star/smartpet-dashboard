// Cloudflare Pages — พอร์ทัล LOVEPET GLOBALPLUS
// หน้าหลัก+Overview = สาธารณะ · แผนกงาน = ล็อกอิน User+PIN แยกตามบทบาท
// บัญชี: env AUTH_USERS (JSON {"user":{"pin":"1234","role":"purchasing"}}) + fallback AUTH_USER/AUTH_PASS = owner
const COOKIE = "lpsess";
const enc = new TextEncoder();
const SECTIONS = ["purchasing", "accounting", "warehouse", "marketing", "sales"];
const ACCESS = {
  owner:      ["purchasing", "accounting", "warehouse", "marketing", "sales"],
  purchasing: ["purchasing"],
  accounting: ["accounting"],
  warehouse:  ["warehouse"],
  marketing:  ["marketing"],
  sales:      ["sales"],
};
const LABEL = { purchasing:"งานจัดซื้อ", accounting:"บัญชีและบุคคล", warehouse:"คลังและจัดส่ง", marketing:"งานการตลาด", sales:"ขายปลีก·ขายส่ง", executive:"สรุปผู้บริหาร (เฉพาะผู้บริหาร)", daily:"สรุปปิดบิลสิ้นวัน (เฉพาะผู้บริหาร)" };
const ROLE_LABEL = { owner:"เจ้าของ · ผู้บริหาร", purchasing:"ทีมจัดซื้อ", accounting:"ทีมบัญชีและบุคคล", warehouse:"ทีมคลังและจัดส่ง", marketing:"ทีมการตลาด", sales:"ทีมขาย" };
// การ์ดแผนก (เรียงตามลำดับที่จะแสดง)
const TILES = [
  { key:"purchasing", icon:"🛒", title:"งานจัดซื้อ",     desc:"ABC · จุดสั่งซื้อ · เติมสต๊อก · จัดการตัวคูณ", live:true },
  { key:"accounting", icon:"💰", title:"บัญชีและบุคคล",   desc:"เจ้าหนี้การค้า (AP) · ใบปิดยอดรายกะ · ลงเวลา", live:true },
  { key:"sales",      icon:"🧾", title:"ขายปลีก · ขายส่ง", desc:"ยอดขาย · ลูกค้า · ใบเสร็จ",                live:false },
  { key:"warehouse",  icon:"📦", title:"คลังและจัดส่ง",   desc:"LSMG Logistic · เส้นทาง · จัดส่ง · เก็บเงิน", live:true },
  { key:"marketing",  icon:"📣", title:"งานการตลาด",     desc:"ใบสั่งงานโปรโมชัน · สถานะงาน · แคมเปญ",     live:true },
];

async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(s))).replace(/[^A-Za-z0-9]/g, "");
}
function secret(env) { return env.SESSION_SECRET || env.AUTH_PASS || "lovepet-fallback-secret"; }
function accounts(env) {
  let map = {};
  try { if (env.AUTH_USERS) map = JSON.parse(env.AUTH_USERS); } catch (e) {}
  if (env.AUTH_USER && env.AUTH_PASS && !map[env.AUTH_USER]) map[env.AUTH_USER] = { pin: env.AUTH_PASS, role: "owner" };
  return map;
}
function safeNext(n) { return (n && n.startsWith("/") && !n.startsWith("//")) ? n : "/home"; }

// ===== Supabase (attendance) — ล็อกอิน name+PIN ผ่าน Edge Function portal-login =====
const SB_URL_DEFAULT = "https://ihtpdwgdbcxojpmisaaz.supabase.co";
// สาขา: uuid (employees.branch_id / branches.id) -> โค้ดพอร์ทัล + ชื่อ
const BRANCH_BY_ID = {
  "9bc1090c-9585-4b4d-9a27-029999eee73a": { code: "ML3",   name: "โกดังเลยสมาร์ทเพ็ทช็อป" },
  "dc38e18a-d7d3-40b5-96aa-d53d1e602c35": { code: "ML2",   name: "เลยสมาร์ทเพ็ทช็อป" },
  "a139c49b-4dc4-44b2-8507-f5a89b61c6d1": { code: "PHONE", name: "เมืองเลยสมาร์ทโฟน" },
};
function branchName(code) {
  if (code === "*") return "ทุกสาขา";
  for (const k in BRANCH_BY_ID) if (BRANCH_BY_ID[k].code === code) return BRANCH_BY_ID[k].name;
  return code;
}
async function portalCall(env, payload) {
  const base = env.SB_URL || SB_URL_DEFAULT;
  const key = env.SB_ANON_KEY || "";
  try {
    const r = await fetch(`${base}/functions/v1/portal-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": key, "Authorization": `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch (e) {
    return { status: 0, data: { error: "เชื่อมต่อระบบไม่ได้" } };
  }
}

// ===== session cookie: base64(JSON).hmac — เก็บ user + sections + branches =====
function b64e(str) { return btoa(String.fromCharCode(...new TextEncoder().encode(str))); }
function b64d(b64) { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); } catch { return ""; } }
async function makeSession(sess, env) {
  const p = b64e(JSON.stringify(sess));
  const sig = await hmac(p, secret(env));
  return encodeURIComponent(`${p}.${sig}`);
}
async function readSession(request, env) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(COOKIE + "=([^;]+)"));
  if (!m) return null;
  const raw = decodeURIComponent(m[1]);
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const p = raw.slice(0, dot), sig = raw.slice(dot + 1);
  if ((await hmac(p, secret(env))) !== sig) return null;
  try {
    const s = JSON.parse(b64d(p));
    if (!s || !Array.isArray(s.sections)) return null;
    return s;
  } catch { return null; }
}
// สิทธิ์ดูการ์ด/สาขา จาก session
function canSee(sess, section) { return (sess.sections || []).includes(section); }
function sessBranches(sess) {
  const b = sess.branches || [];
  return b.includes("*") ? ["*"] : b;
}
// ===== IP allowlist (รองรับ IPv4 /32 และ IPv6 prefix /64 ฯลฯ) =====
function normHextet(h) { return h.replace(/^0+/, "") || "0"; }
function v4InCidr(ip, net, bits) {
  const toN = (s) => (s.split(".").reduce((a, o) => (a * 256) + (parseInt(o, 10) & 255), 0)) >>> 0;
  const mask = (bits <= 0) ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
  return ((toN(ip) & mask) >>> 0) === ((toN(net) & mask) >>> 0);
}
function ipAllowed(ip, allow) {
  if (!ip || !allow || !allow.length) return false;
  const v6 = ip.includes(":");
  for (let entry of allow) {
    entry = String(entry).trim();
    if (!entry) continue;
    if (entry === ip) return true;
    const slash = entry.indexOf("/");
    const net = slash >= 0 ? entry.slice(0, slash) : entry;
    const bits = slash >= 0 ? parseInt(entry.slice(slash + 1), 10) : (net.includes(":") ? 128 : 32);
    if (v6 && net.includes(":")) {
      const g = Math.max(1, Math.floor(bits / 16));
      const ipg = ip.split(":").slice(0, g).map(normHextet).join(":");
      const ntg = net.replace(/::+$/, "").split(":").filter((x) => x !== "").slice(0, g).map(normHextet).join(":");
      if (ntg && ipg === ntg) return true;
    } else if (!v6 && !net.includes(":")) {
      if (v4InCidr(ip, net, bits)) return true;
    }
  }
  return false;
}
// บังคับ WiFi ร้าน: owner/admin เข้าได้ทุกที่ · user อื่นเฉพาะ IP ใน OFFICE_IPS (ถ้าตั้งไว้)
function ipRestricted(request, env, sess) {
  const allow = String(env.OFFICE_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return false;           // ยังไม่ตั้ง allowlist = ไม่บังคับ
  if (sess && sess.is_admin) return false;   // owner/admin ข้ามได้
  const ip = request.headers.get("CF-Connecting-IP") || "";
  return !ipAllowed(ip, allow);
}

const SHELL = (title, body) => `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0C223A">
<link rel="apple-touch-icon" href="/icon-192.png"><link rel="icon" type="image/png" href="/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet">
<style>@font-face{font-family:'LINE Seed Sans TH';font-weight:400;font-display:swap;src:url(/fonts/LINESeedSansTH_W_Rg.woff2) format('woff2')}
@font-face{font-family:'LINE Seed Sans TH';font-weight:700;font-display:swap;src:url(/fonts/LINESeedSansTH_W_Bd.woff2) format('woff2')}
:root{--navy:#0C223A;--navy-d:#001A37;--navy-l:#173D61;--gold:#C89535;--gold-l:#E4B65C;--gold-d:#9D681E;--cream:#F5ECE3;--surface:#FAF6F1;--ink:#25282C;--muted:#89694C;--border:#CFC1B3;--f-head:'Poppins','LINE Seed Sans TH','Noto Sans Thai',sans-serif;--f-body:'Inter','LINE Seed Sans TH','Noto Sans Thai',sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:var(--f-body);background:linear-gradient(135deg,#001A37 0%,#0C223A 55%,#173D61 100%);display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:22px;color:var(--ink)}
.card{background:var(--surface);border-radius:20px;padding:32px 26px;width:100%;max-width:370px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.35);border:1px solid rgba(200,149,53,.35)}
.logo{display:block;margin:0 auto 18px;width:auto;height:auto;max-width:210px;max-height:58px;border-radius:8px}
h1{font-family:var(--f-head);font-size:21px;font-weight:700;color:var(--navy);margin:0 0 4px}
.sub{font-size:13px;color:var(--muted);margin:0 0 20px}
input,select{width:100%;font-size:16px;padding:13px 14px;margin-bottom:12px;border:1.5px solid var(--border);border-radius:11px;color:var(--ink);background:#fff;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:var(--gold)}
.backup{margin:14px 0 4px;text-align:left}
.backup summary{cursor:pointer;font-size:12.5px;color:var(--muted);list-style:none;text-align:center}
.backup summary::-webkit-details-marker{display:none}
.backup summary:hover{color:var(--gold-d)}
.backup form{margin-top:12px}
button{width:100%;font-size:16px;font-weight:700;font-family:var(--f-body);padding:13px;border:1.5px solid var(--gold);border-radius:11px;background:var(--navy);color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(200,149,53,.20);transition:background .15s}
button:hover{background:var(--navy-l)}button:active{transform:scale(.98)}
.err{background:#f7dede;color:#a32d2d;font-size:13px;padding:9px;border-radius:9px;margin-bottom:14px}
.link{display:inline-block;margin-top:16px;font-size:13px;color:var(--gold-d);text-decoration:none;font-weight:600}
.link:hover{color:var(--navy)}
.msg{font-size:14px;color:var(--muted);line-height:1.7;margin:10px 0 4px}</style></head>
<body><div class="card">${body}</div></body></html>`;

async function loginPage(env, { err, next } = {}) {
  const nx = String(next || "/").replace(/"/g, "");
  const { data } = await portalCall(env, { action: "list" });
  const users = (data && Array.isArray(data.users)) ? data.users : [];
  const options = users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("");
  const mainField = users.length
    ? `<select name="employee_id" required><option value="" disabled selected>— เลือกชื่อพนักงาน —</option>${options}</select>`
    : `<input name="user" placeholder="ชื่อผู้ใช้" autocomplete="username" autocapitalize="none" required>`;
  const body = `<img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS"><h1>เข้าสู่ระบบ</h1>
<p class="sub">บริษัท เลิฟเพ็ท โกลบอลพลัส จำกัด</p>${err ? `<div class="err">${esc(err)}</div>` : ""}
<form method="POST" action="/login">
<input type="hidden" name="next" value="${nx}">
${mainField}
<input name="pin" type="password" placeholder="PIN 4 หลัก" inputmode="numeric" autocomplete="current-password" required>
<button type="submit">เข้าสู่ระบบ</button></form>
<details class="backup"><summary>เข้าด้วยบัญชีผู้ดูแล (สำรอง)</summary>
<form method="POST" action="/login">
<input type="hidden" name="next" value="${nx}">
<input name="user" placeholder="ชื่อผู้ใช้ผู้ดูแล" autocomplete="username" autocapitalize="none" required>
<input name="pin" type="password" placeholder="PIN / รหัสผ่าน" inputmode="numeric" autocomplete="current-password" required>
<button type="submit">เข้าระบบสำรอง</button></form></details>
<a class="link" href="/">← กลับหน้าหลัก</a>`;
  return new Response(SHELL("เข้าสู่ระบบ — LOVEPET", body), { status: 200, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" } });
}
// ===== หน้าหลังล็อกอิน (การ์ดแผนกตามสิทธิ์) — ธีม navy-gold =====
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const HOME_CSS = `@font-face{font-family:'LINE Seed Sans TH';font-weight:400;font-display:swap;src:url(/fonts/LINESeedSansTH_W_Rg.woff2) format('woff2')}
@font-face{font-family:'LINE Seed Sans TH';font-weight:700;font-display:swap;src:url(/fonts/LINESeedSansTH_W_Bd.woff2) format('woff2')}
:root{--navy:#0C223A;--navy-d:#001A37;--navy-l:#173D61;--gold:#C89535;--gold-l:#E4B65C;--gold-soft:#D8B479;--gold-d:#9D681E;--cream:#F5ECE3;--surface:#FAF6F1;--ink:#25282C;--muted:#89694C;--border:#CFC1B3;--f-head:'Poppins','LINE Seed Sans TH','Noto Sans Thai',sans-serif;--f-body:'Inter','LINE Seed Sans TH','Noto Sans Thai',sans-serif;--sh-card:0 8px 24px rgba(12,34,58,.12);--sh-sm:0 2px 8px rgba(12,34,58,.08);--r-md:10px;--r-card:20px}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:var(--f-body);font-size:16px;line-height:1.7;color:var(--ink);background:var(--cream);min-height:100dvh}
h1,h2,h3{font-family:var(--f-head);margin:0}
.nav{background:var(--navy);color:#fff;padding:12px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.nav .logo{height:34px;background:#fff;border-radius:8px;padding:4px 9px;display:block}
.nav .co{font-family:var(--f-head);font-size:14px;font-weight:700;line-height:1.15}
.nav .co small{display:block;font-family:var(--f-body);font-size:10px;color:#cbbfa0;font-weight:400;letter-spacing:.5px}
.nav .who{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px}
.nav .chip{background:var(--navy-l);border:1px solid var(--gold-d);border-radius:99px;padding:5px 13px;color:#fff;font-weight:600}
.nav .chip b{color:var(--gold-l)}
.nav .out{background:transparent;color:#cbbfa0;border:1px solid #4a5f78;border-radius:var(--r-md);padding:6px 14px;font-family:var(--f-body);font-weight:600;font-size:13px;text-decoration:none}
.nav .out:hover{color:#fff;border-color:var(--gold)}
.wrap{max-width:1000px;margin:0 auto;padding:34px 24px 56px}
.hi{color:var(--navy);font-size:26px;font-weight:700;margin:0 0 4px}
.hi .em{color:var(--gold-d)}
.lead{color:var(--muted);font-size:15px;margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
.tile{background:var(--surface);border:1px solid var(--gold-soft);border-radius:var(--r-card);padding:24px 22px;text-decoration:none;color:var(--ink);transition:.15s;display:block;box-shadow:var(--sh-sm);position:relative}
.tile:hover{box-shadow:var(--sh-card);transform:translateY(-3px);border-color:var(--gold)}
.tile.soon{opacity:.72;pointer-events:none}
.tile .ic{width:50px;height:50px;border-radius:var(--r-md);background:var(--navy);color:var(--gold-l);display:grid;place-items:center;font-size:26px;margin-bottom:14px}
.tile .t{font-family:var(--f-head);font-size:19px;font-weight:700;color:var(--navy)}
.tile .d{font-size:13.5px;color:var(--muted);margin-top:5px;line-height:1.55}
.tile .go{font-family:var(--f-body);font-size:13px;color:var(--gold-d);margin-top:12px;font-weight:600}
.tile .badge{position:absolute;top:16px;right:16px;font-size:11px;font-weight:600;padding:3px 10px;border-radius:99px}
.tile .badge.on{background:#e8f3ec;color:#2f7d4f}
.tile .badge.dev{background:#f2ece1;color:var(--gold-d)}
.foot{color:var(--muted);text-align:center;font-size:12.5px;margin-top:40px}
@media(max-width:720px){.grid{grid-template-columns:1fr}.hi{font-size:22px}.nav .co{font-size:13px}}`;
const HOME_SHELL = (title, nav, main) => `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0C223A">
<link rel="apple-touch-icon" href="/icon-192.png"><link rel="icon" type="image/png" href="/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@600;700&display=swap" rel="stylesheet">
<style>${HOME_CSS}</style></head><body>${nav}<div class="wrap">${main}</div></body></html>`;

function homePage(sess, env) {
  const allowed = sess.sections || [];
  // การ์ดการตลาดเปิดให้ทีมจัดซื้อเห็นด้วย (Owner สั่ง 6 ส.ค.: คนเห็นใบสั่งงาน = owner + จัดซื้อ + การตลาด)
  const visible = (t) => allowed.includes(t.key) || (t.key === "marketing" && (allowed.includes("purchasing") || sess.is_admin));
  const cards = TILES.filter(visible).map((t) => {
    const badge = t.live ? `<span class="badge on">ใช้งานได้</span>` : `<span class="badge dev">กำลังพัฒนา</span>`;
    const cls = t.live ? "tile" : "tile soon";
    const href = t.live ? `/${t.key}` : "#";
    const go = t.live ? "เปิดแดชบอร์ด →" : "เฟส B · เร็วๆ นี้";
    return `<a class="${cls}" href="${href}">${badge}<div class="ic">${t.icon}</div><div class="t">${t.title}</div><div class="d">${t.desc}</div><div class="go">${go}</div></a>`;
  });
  // การ์ดลงเวลา — เฉพาะสิทธิ์บัญชีและบุคคล (owner + accounting) · กันพนักงานทั่วไปกดผิดที่พอร์ทัลแทนระบบลงเวลาจริง
  const attUrl = env.ATTENDANCE_URL || "https://piyawanthiemtan-star.github.io/attendance-app/attendance-app.html";
  const attLive = !!attUrl;
  if (allowed.includes("accounting")) {
    cards.push(`<a class="${attLive ? "tile" : "tile soon"}" href="${attLive ? esc(attUrl) : "#"}"${attLive ? ' target="_blank" rel="noopener"' : ""}>`
      + `${attLive ? '<span class="badge on">ใช้งานได้</span>' : '<span class="badge dev">รอลิงก์</span>'}`
      + `<div class="ic">⏰</div><div class="t">ลงเวลาเข้า-ออกงาน</div><div class="d">บันทึกเวลาทำงาน · ลิงก์แอปลงเวลา</div>`
      + `<div class="go">${attLive ? "เปิดแอปลงเวลา →" : "เร็วๆ นี้"}</div></a>`);
  }
  // การ์ดสรุปผู้บริหาร — เฉพาะ owner/admin (กำไร · มาร์จิ้น · เร่งระบาย · ยอดขายรายเดือน)
  // แยกออกจากหน้าจัดซื้อโดยตั้งใจ: ทีมจัดซื้อไม่เห็นตัวเลขกำไร
  if (sess.is_admin) {
    cards.unshift(`<a class="tile" href="/executive"><span class="badge on">ผู้บริหาร</span>`
      + `<div class="ic">👔</div><div class="t">คอนโซลผู้บริหาร</div>`
      + `<div class="d">ยอดขาย · กำไรมาร์จิ้น · เร่งระบายสต๊อก · ปิดบิลสิ้นวัน</div>`
      + `<div class="go">เปิดแดชบอร์ด →</div></a>`);
    // หลังบ้าน LOEI CAT HOTEL — ทีมพัฒนาภายนอกกำลังทำระบบจอง+แดชบอร์ด เสียบลิงก์เมื่อส่งมอบ
    cards.push(`<a class="tile soon" href="#"><span class="badge dev">กำลังพัฒนา</span>`
      + `<div class="ic">🏨</div><div class="t">หลังบ้านโรงแรมแมว</div>`
      + `<div class="d">LOEI CAT HOTEL · ระบบจอง + แดชบอร์ด (ทีมพัฒนากำลังส่งมอบ)</div>`
      + `<div class="go">เร็วๆ นี้</div></a>`);
  }

  const brs = sessBranches(sess);
  const brLabel = brs.includes("*") ? "ทุกสาขา" : brs.map(branchName).join(" · ");
  const nav = `<div class="nav"><img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS">
<div class="co">บริษัท เลิฟเพ็ท โกลบอลพลัส จำกัด<small>LOVE PET GLOBAL PLUS CO., LTD.</small></div>
<div class="who"><span class="chip"><b>${esc(sess.user)}</b> · ${esc(brLabel)}</span>
<a class="out" href="/logout">ออกจากระบบ</a></div></div>`;
  const main = `<h1 class="hi">สวัสดี <span class="em">${esc(sess.user)}</span></h1>
<p class="lead">เลือกแผนกที่ต้องการเข้าใช้งาน</p>
<div class="grid">${cards.join("")}</div>
<p class="foot">© บริษัท เลิฟเพ็ท โกลบอลพลัส จำกัด · Loei Smart Group</p>`;
  return new Response(HOME_SHELL("หน้าหลัก — LOVEPET", nav, main), { status: 200, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" } });
}

// ===== หน้างานการตลาด — คิวใบสั่งงานโปรโมชัน (owner สั่งจาก /executive · การตลาดรับงาน/ปิดงาน) =====
function marketingPage(sess, env) {
  const canEdit = sess.is_admin || canSee(sess, "marketing");
  const brs = sessBranches(sess);
  const brLabel = brs.includes("*") ? "ทุกสาขา" : brs.map(branchName).join(" · ");
  const nav = `<div class="nav"><img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS">
<div class="co">บริษัท เลิฟเพ็ท โกลบอลพลัส จำกัด<small>LOVE PET GLOBAL PLUS CO., LTD.</small></div>
<div class="who"><span class="chip"><b>${esc(sess.user)}</b> · ${esc(brLabel)}</span>
<a class="out" href="/home">🏠 หน้าหลัก</a>
<a class="out" href="/logout">ออกจากระบบ</a></div></div>`;
  const main = `<h1 class="hi">📣 งานการตลาด</h1>
<p class="lead">ใบสั่งงานโปรโมชันจากผู้บริหาร — ${canEdit ? "กดรับงาน/ปิดงานได้เลย" : "ดูอย่างเดียว"}</p>
<div id="jobs" style="display:grid;gap:16px"><p style="color:var(--muted)">กำลังโหลด…</p></div>
<p class="foot"><a href="/home" style="color:var(--gold-d);font-weight:600;text-decoration:none">← กลับหน้าหลัก</a></p>
<script>
const CAN_EDIT=${canEdit ? "true" : "false"};
const IS_ADMIN=${sess.is_admin ? "true" : "false"};
const ST={new:["🆕 งานใหม่","#a32d2d","#f7dede"],doing:["🔨 กำลังทำ","#8a5a12","#faeecd"],done:["✅ เสร็จแล้ว","#1c7a4a","#e3f4ea"]};
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function thDT(s){try{return new Date(s).toLocaleString("th-TH",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});}catch(e){return s;}}
function setStatus(id,st){
  // ไม่ใช้ prompt/alert — อ่านชื่อโปรจากช่องกรอกในการ์ด แจ้งเตือนผ่านข้อความสีแดงใต้ปุ่มแทน
  const body={id:id,status:st};
  const msg=document.getElementById("pmsg"+id);
  if(st==="done"){
    const pf=document.getElementById("pd"+id);
    const pp=(pf&&pf.value.trim())||"";
    if(!pp){if(msg)msg.textContent="⚠️ กรอกชื่อโปรโมชั่นจาก Onepointofsale ในช่องด้านซ้ายก่อน แล้วกดปิดงานอีกครั้ง";return;}
    if(msg)msg.textContent="";
    body.pos_promo=pp;
  }
  fetch("/api/marketing-jobs/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.ok?load():r.json().then(j=>{if(msg)msg.textContent=j.error||"ไม่สำเร็จ";}));
}
const JOBS={};
function printTags(id){
  // ป้ายโปรโมชั่นติดชั้นวาง — กระดาษ 80mm (เครื่องพิมพ์ใบเสร็จ) 1 ป้าย/สินค้า มีเส้นตัดคั่น
  const j=JOBS[id]; if(!j) return;
  // ไม่ใช้ prompt/alert เลย — ถ้าผู้ใช้เคยติ๊ก "บล็อกกล่องโต้ตอบ" ทุกอย่างจะเงียบหาย แก้ยากมาก
  const msg=document.getElementById("pmsg"+id);
  const w=window.open("","_blank");
  if(!w){if(msg)msg.textContent="⚠️ เบราว์เซอร์บล็อกป๊อปอัพ — กดไอคอนที่มุมขวาของช่องที่อยู่เว็บ แล้วเลือกอนุญาต popup ของเว็บนี้ จากนั้นกดปุ่มใหม่";return;}
  if(msg)msg.textContent="";
  const note=(j.note||"").trim();
  // ชื่อโปร: อ่านจากช่องกรอกสดๆ ก่อน (เผื่อพิมพ์ก่อนกดปิดงาน) แล้วค่อยดูที่บันทึกไว้ตอนปิดงาน
  // [แก้ 2026-08-10: เดิมป้ายไม่เคยหยิบ pos_promo เลย — ชื่อโปรที่ใส่ทีหลังจึงไม่ขึ้นในใบปริ้น]
  const pf=document.getElementById("pd"+id);
  const pos=((pf&&pf.value.trim())||j.pos_promo||"").trim();
  const blocks=(j.items||[]).map(function(x){
    const promo=note||pos||("ราคาพิเศษ "+x.promo+".- (ปกติ "+x.price+".-)");
    const tagLine=(pos&&pos!==promo)?'<div class="pd">🏷 '+esc(pos)+'</div>':'';
    return '<div class="tag">'
      +'<div class="hd">&#9733;&#9733; Promotion &#9733;&#9733;</div>'
      +'<div class="bc">'+esc(x.bc||"")+'</div>'
      +'<div class="nm">'+esc(x.name)+'</div>'
      +'<div class="pm">'+esc(promo)+'</div>'
      +tagLine
      +'</div><div class="cut">&#9986; --------------------------------</div>';
  }).join("");
  w.document.write('<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ป้ายโปรโมชั่น 80mm</title><style>'
    +'@page{size:80mm auto;margin:2mm}'
    +'body{width:72mm;margin:0 auto;font-family:Tahoma,sans-serif;color:#000;background:#fff}'
    +'.tag{text-align:center;padding:3mm 0 1mm}'
    +'.hd{font-size:16px;font-weight:700;letter-spacing:1px;border-top:2px solid #000;border-bottom:2px solid #000;padding:1.5mm 0;margin-bottom:2mm}'
    +'.bc{font-family:Consolas,monospace;font-size:13px;letter-spacing:1px;margin:1mm 0}'
    +'.nm{font-size:15px;font-weight:700;line-height:1.4;margin:1mm 0}'
    +'.pm{font-size:18px;font-weight:800;margin:2mm 1mm;border:2px solid #000;border-radius:3mm;padding:2mm 1mm}'
    +'.pd{font-size:12px;margin-top:1mm}'
    +'.cut{text-align:center;font-size:10px;color:#666;margin:2mm 0}'
    +'.btn{display:block;margin:4mm auto;padding:8px 22px;font-size:14px;font-weight:700;background:#C89535;color:#fff;border:none;border-radius:8px;cursor:pointer}'
    +'@media print{.btn{display:none}}'
    +'</style></head><body>'
    +'<button class="btn" onclick="print()">&#128424;&#65039; พิมพ์</button>'
    +blocks
    +'</body></html>');
  w.document.close();
}
function delJob(id,btn){
  // ยืนยัน 2 จังหวะแทน confirm() — กันมือลั่นโดยไม่พึ่งกล่องโต้ตอบของเบราว์เซอร์
  if(btn&&btn.dataset.arm!=="1"){
    btn.dataset.arm="1";btn.textContent="⚠️ กดอีกครั้งเพื่อยืนยันลบถาวร";
    setTimeout(function(){btn.dataset.arm="";btn.textContent="🗑 ลบใบสั่งงาน";},4000);
    return;
  }
  const msg=document.getElementById("pmsg"+id);
  fetch("/api/marketing-jobs/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})}).then(r=>r.ok?load():r.json().then(j=>{if(msg)msg.textContent=j.error||"ไม่สำเร็จ";}));
}
function copyPre(btn){
  const t=btn.parentElement.querySelector("pre").textContent;
  navigator.clipboard.writeText(t).then(()=>{btn.textContent="คัดลอกแล้ว ✓";setTimeout(()=>btn.textContent="คัดลอก",1500);}).catch(()=>{btn.textContent="กดไม่ได้ — เลือกข้อความก๊อปเอง";setTimeout(()=>btn.textContent="คัดลอก",2500);});
}
function buildCaption(j){
  // ถ้าใบสั่งงานมีโน้ต (เงื่อนไขโปร เช่น "3 ถุง 100 บาท") → ใช้เป็นหัว hook + สินค้าโชว์ราคาปกติ
  // ไม่มีโน้ต → หัวมาตรฐาน + สินค้าโชว์ราคาโปรรายตัว
  const note=(j.note||"").trim();
  const head=note?("🔥 โปรโมชันพิเศษ! "+note+" 🔥"):"🔥 โปรโมชันพิเศษ ลดจริง คุ้มจริง! 🔥";
  const lines=(j.items||[]).map(x=>note
    ?("🐾 "+x.name+" (ปกติ "+x.price+".-)")
    :("🐾 "+x.name+" เหลือ "+x.promo+".- (ปกติ "+x.price+".-) ลดถึง "+x.disc+"%"));
  return head+"\\n\\n"+lines.join("\\n")+"\\n\\n📍 ของมีจำนวนจำกัด หมดแล้วหมดเลย\\n📲 สอบถาม/สั่งจอง: ทักแชทเพจ หรือ LINE ของร้าน\\n\\n#อาหารสัตว์ราคาถูก #โปรโมชันสัตว์เลี้ยง #เลยสมาร์ทเพ็ทช็อป #โกดังเลยสมาร์ทเพ็ทช็อป\\n#LOVEPETGLOBALPLUS #อาหารสัตว์จังหวัดเลย";
}
function buildPrompt(j){
  // แม่แบบประจำร้าน — ถอดจากโปสเตอร์ต้นแบบของ Owner (6 ส.ค. 2569)
  // เนื้อหาต้องสอดคล้องกับคอนเทนท์ข้อ 1: มีโน้ตโปร → ข้อความโปรเป็นพระเอก · ไม่มี → ราคาโปรรายตัวเป็นพระเอก
  const st={ML3:["โกดังเลยสมาร์ทเพ็ทช็อป"],ML2:["เลยสมาร์ทเพ็ทช็อป"]}[j.branch]||["โกดังเลยสมาร์ทเพ็ทช็อป / เลยสมาร์ทเพ็ทช็อป"];
  const note=(j.note||"").trim();
  const its=(j.items||[]).map(x=>note
    ?("- "+x.name+" (ราคาปกติ "+x.price+" บาท มีเส้นแดงขีดฆ่า)")
    :("- "+x.name+" ราคาโปร "+x.promo+" บาท (ราคาปกติ "+x.price+" มีเส้นแดงขีดฆ่า, ลด "+x.disc+"%)")).join("\\n");
  const L=[
    "สร้างภาพโปสเตอร์โปรโมชันร้านเพ็ทช็อป สไตล์การ์ตูนสดใสระดับมืออาชีพ ขนาดจัตุรัส 1:1 (1080x1080)",
    "พื้นหลัง: ภายในร้านเพ็ทช็อปจริง ชั้นวางสินค้าเต็มผนัง เบลอแบบ bokeh โทนอุ่นสว่าง",
    "ป้ายหัวเรื่องสีแดงมนโค้ง คำว่า 'โปรโมชั่น' ตัวอักษรไทยสีขาวหนาพิเศษ มีขอบเข้มและเงาชัด พร้อมไอคอนโทรโข่ง 3 มิติสีแดง-ขาว มีเส้นประกายรอบ",
    note?("ข้อความโปรที่ต้องเด่นที่สุดในภาพ: '"+note+"' ตัวอักษรไทยสีแดงใหญ่พิเศษ ขอบขาวหนา มีเงาชัด อยู่บนป้ายครีมขอบมน")
        :"ราคาโปรเป็นตัวเลขสีแดงใหญ่ที่สุดในภาพ ขอบขาวหนา มีเงาชัด อยู่บนป้ายครีมขอบมน",
    "สินค้าที่ต้องแสดง ("+(j.items||[]).length+" รายการ):",
    its,
    "จัดวางสินค้าเรียงเด่นบนแท่นไม้กลม คมชัดตัดจากพื้นหลัง มีแมวเปอร์เซียขนฟูสีส้มหน้ายิ้มโผล่มุมล่างซ้าย",
    "แถบล่างสุดสีครีม: ชื่อร้าน '"+st[0]+"'",
    "โลโก้บริษัท LOVEPET GLOBALPLUS CO.,LTD. มุมขวาบน",
    "ตกแต่ง: รอยอุ้งเท้าแมวสีส้ม-เหลืองกระจายรอบภาพ ประกายดาวเหลืองทอง แสงวิ้งๆ",
    "โทนสีรวม: แดงสด ครีม น้ำตาล ส้มอบอุ่น ตัวหนังสือไทยทุกจุดคมชัดอ่านง่าย"
  ];
  return L.join("\\n");
}
function toolkit(j){
  const box='background:#FAF6F1;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:6px 0 12px;white-space:pre-wrap;font-size:13px;line-height:1.6;font-family:inherit';
  const cbtn='background:transparent;color:#9D681E;border:1px solid #D8B479;border-radius:6px;padding:3px 12px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;margin-left:8px';
  return '<details style="margin-top:12px"><summary style="cursor:pointer;font-weight:700;color:#173D61">🧰 ชุดเครื่องมือทีมการตลาด (คอนเทนท์ · Prompt สื่อ · ขั้นตอน)</summary>'
    +'<div style="margin-top:12px"><b>✍️ 1) ร่างคอนเทนท์ไปวางใน Facebook</b> (คัดลอกไปแก้/เติมได้เลย)<button style="'+cbtn+'" onclick="copyPre(this)">คัดลอก</button><pre style="'+box+'">'+esc(buildCaption(j))+'</pre></div>'
    +'<div><b>🎨 2) Prompt สร้างสื่อใน ChatGPT</b> (คัดลอกไปแก้ไขและสร้างภาพได้เลย · แนบภาพอ้างอิงใน ChatGPT ได้)<button style="'+cbtn+'" onclick="copyPre(this)">คัดลอก</button><pre style="'+box+'">'+esc(buildPrompt(j))+'</pre>'
    +'<div style="font-size:12px;color:#8a5a12;margin:-6px 0 12px">💡 ตัวหนังสือไทยในภาพ AI อาจเพี้ยน — ตรวจ/พิมพ์ทับใน Canva ก่อนโพสต์</div></div>'
    +'<div><b>📌 3) ขั้นตอนที่ต้องทำทั้งหมด</b><ol style="margin:6px 0 4px;padding-left:22px;line-height:1.9">'
    +'<li>คัดลอกคอนเทนท์ข้อ 1 → แก้/เติม → <b>โพสต์ลงเพจ Facebook ของร้าน</b></li>'
    +'<li>คัดลอก Prompt ข้อ 2 → สร้างภาพใน ChatGPT → แต่งใน Canva</li>'
    +'<li><b>ตั้งโปรโมชั่นใน Onepointofsale</b></li>'
    +'<li>กด "✅ ปิดงาน" แล้ว<b>วางชื่อโปรโมชั่นจาก Onepointofsale</b></li>'
    +'<li>กด "🖨 ป้ายชั้นวาง 80mm" พิมพ์ไปติดที่ชั้นสินค้า</li>'
    +'</ol></div></details>';
}
function load(){fetch("/api/marketing-jobs").then(r=>r.json()).then(js=>{
  const el=document.getElementById("jobs");
  if(!Array.isArray(js)){el.innerHTML='<p style="color:#a32d2d">'+esc(js.error||"โหลดไม่สำเร็จ")+'</p>';return;}
  if(!js.length){el.innerHTML='<p style="color:var(--muted)">ยังไม่มีใบสั่งงาน — ผู้บริหารสั่งได้จากหน้าคอนโซล (ติ๊กเลือกสินค้า → ส่งให้การตลาด)</p>';return;}
  js.forEach(j=>{JOBS[j.id]=j;});
  el.innerHTML=js.map(j=>{const t=ST[j.status]||ST.new;
    const C='padding:6px 8px;border-bottom:1px solid var(--border);';
    const rows=(j.items||[]).map((x,i)=>'<tr><td style="'+C+'text-align:center">'+(i+1)+'</td><td style="'+C+'font-family:monospace">'+esc(x.bc)+'</td><td style="'+C+'text-align:center">'+esc(x.code)+'</td><td style="'+C+'">'+esc(x.name)+'</td><td style="'+C+'text-align:right">'+x.price+'</td><td style="'+C+'text-align:right;font-weight:700">'+x.promo+'</td><td style="'+C+'text-align:center">'+x.disc+'%</td></tr>').join("");
    const btns=CAN_EDIT?('<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">'
      +(j.status==="new"?'<button onclick="setStatus('+j.id+',\\'doing\\')" style="background:#C89535;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-weight:700;font-family:inherit;cursor:pointer">🔨 รับงานนี้</button>':"")
      +(j.status!=="done"?'<button onclick="setStatus('+j.id+',\\'done\\')" style="background:#2f7d4f;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-weight:700;font-family:inherit;cursor:pointer">✅ ปิดงาน</button>':"")
      +(j.status==="done"?'<button onclick="setStatus('+j.id+',\\'doing\\')" style="background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:8px;padding:7px 14px;font-family:inherit;cursor:pointer">↩︎ เปิดงานอีกครั้ง</button>':"")
      +'<input id="pd'+j.id+'" value="'+esc(j.pos_promo||"")+'" placeholder="กรอกชื่อโปรโมชั่นจาก Onepointofsale" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:12.5px;width:230px">'
      +'<button onclick="printTags('+j.id+')" style="background:#6B4A33;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-weight:700;font-family:inherit;cursor:pointer">🖨 ป้ายชั้นวาง 80mm</button>'
      +'<span id="pmsg'+j.id+'" style="font-size:12px;color:#a32d2d;flex-basis:100%"></span>'
      +(IS_ADMIN?'<button onclick="delJob('+j.id+',this)" style="background:transparent;color:#a32d2d;border:1px solid #e3b3b3;border-radius:8px;padding:7px 14px;font-family:inherit;cursor:pointer;margin-left:auto">🗑 ลบใบสั่งงาน</button>':"")
      +'</div>'):"";
    return '<div style="background:var(--surface);border:1px solid var(--gold-soft);border-radius:16px;padding:20px 22px;box-shadow:var(--sh-sm)">'
      +'<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><b style="font-family:var(--f-head);font-size:17px">ใบสั่งงาน #'+j.id+'</b>'
      +'<span style="background:'+t[2]+';color:'+t[1]+';font-size:12px;font-weight:700;padding:3px 12px;border-radius:99px">'+t[0]+'</span>'
      +'<span style="font-size:12.5px;color:var(--muted)">สั่งโดย '+esc(j.created_by)+' · '+thDT(j.created_at)+((j.status_by&&j.status!=="new")?' · อัปเดตโดย '+esc(j.status_by)+' '+thDT(j.status_at):'')+(j.pos_promo?' · 🏷️ โปรใน POS: <b>'+esc(j.pos_promo)+'</b>':'')+'</span></div>'
      +(j.note?'<div style="margin:10px 0 4px;padding:10px 14px;background:#FFF8EC;border-left:3px solid #C89535;border-radius:6px;font-size:14px">📝 '+esc(j.note)+'</div>':"")
      +'<div style="overflow-x:auto;margin-top:10px"><table style="border-collapse:collapse;width:100%;font-size:13px;min-width:560px"><thead><tr style="background:var(--navy);color:#fff">'
      +'<th style="padding:6px 8px">#</th><th style="padding:6px 8px">บาร์โค้ด</th><th style="padding:6px 8px">รหัสประเภท</th><th style="padding:6px 8px;text-align:left">สินค้า</th><th style="padding:6px 8px">ราคาเดิม</th><th style="padding:6px 8px">ราคาโปร</th><th style="padding:6px 8px">ลด</th>'
      +'</tr></thead><tbody>'+rows+'</tbody></table></div>'
      +toolkit(j)
      +btns+'</div>';
  }).join("");
}).catch(e=>{document.getElementById("jobs").innerHTML='<p style="color:#a32d2d">โหลดไม่สำเร็จ: '+esc(e)+'</p>';});}
load();
</`+`script>`;
  return new Response(HOME_SHELL("งานการตลาด — LOVEPET", nav, main), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
// ===== หน้าแผนกบัญชีและบุคคล — hub รวมเครื่องมือทีมบัญชี (ธีมเดียวกับ /home) =====
function accountingPage(sess, env) {
  const attUrl = env.ATTENDANCE_URL || "https://piyawanthiemtan-star.github.io/attendance-app/attendance-app.html";
  const tiles = [
    `<a class="tile" href="/accounting-ap"><span class="badge on">ใช้งานได้</span><div class="ic">💰</div><div class="t">เจ้าหนี้การค้า (AP)</div><div class="d">บิลค้างจ่ายจากใบรับของ · ครบกำหนดตามเครดิตซัพ · บันทึกจ่าย · บัญชีโอน · พิมพ์รายการทำจ่าย</div><div class="go">เปิดดู →</div></a>`,
    `<a class="tile" href="/accounting-daily"><span class="badge on">ใช้งานได้</span><div class="ic">🧾</div><div class="t">ใบปิดยอดรายกะ</div><div class="d">เงินตั้งต้น · เงินสด/โอน/เครดิต แยกช่องทาง · ส่วนต่างลิ้นชักทุกกะ ทั้ง 2 สาขา</div><div class="go">เปิดดู →</div></a>`,
    `<a class="tile" href="${esc(attUrl)}" target="_blank" rel="noopener"><span class="badge on">ใช้งานได้</span><div class="ic">⏰</div><div class="t">ลงเวลาเข้า-ออกงาน</div><div class="d">บันทึกเวลาทำงานพนักงาน · เปิดแอปลงเวลา</div><div class="go">เปิดแอป →</div></a>`,
  ];
  const brs = sessBranches(sess);
  const brLabel = brs.includes("*") ? "ทุกสาขา" : brs.map(branchName).join(" · ");
  const nav = `<div class="nav"><img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS">
<div class="co">บริษัท เลิฟเพ็ท โกลบอลพลัส จำกัด<small>LOVE PET GLOBAL PLUS CO., LTD.</small></div>
<div class="who"><span class="chip"><b>${esc(sess.user)}</b> · ${esc(brLabel)}</span>
<a class="out" href="/home">🏠 หน้าหลัก</a>
<a class="out" href="/logout">ออกจากระบบ</a></div></div>`;
  const main = `<h1 class="hi">💰 บัญชีและบุคคล</h1>
<p class="lead">เครื่องมือของทีมบัญชี — ตัวเลขฝั่งเงินเข้า-ออกเท่านั้น</p>
<div class="grid">${tiles.join("")}</div>
<p class="foot"><a href="/home" style="color:var(--gold-d);font-weight:600;text-decoration:none">← กลับหน้าหลัก</a></p>`;
  return new Response(HOME_SHELL("บัญชีและบุคคล — LOVEPET", nav, main), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function placeholder(section, sess) {
  const body = `<img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS"><h1>${LABEL[section]}</h1>
<p class="msg">🔧 กำลังพัฒนา (เฟส B)<br>ระบบล็อกอิน+สิทธิ์พร้อมแล้ว หน้านี้จะเติมข้อมูลจริงจาก POS เร็วๆ นี้</p>
<p class="sub">เข้าใช้โดย: ${esc(sess.user)}</p>
<a class="link" href="/home">← กลับหน้าหลัก</a> &nbsp; <a class="link" href="/logout">ออกจากระบบ</a>`;
  return new Response(SHELL(LABEL[section] + " — LOVEPET", body), { status: 200, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" } });
}
function forbidden(section, sess) {
  const body = `<img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS"><h1>ไม่มีสิทธิ์เข้าถึง</h1>
<p class="msg">บัญชี <b>${esc(sess.user)}</b> ไม่มีสิทธิ์ดู "${LABEL[section]}"<br>ติดต่อผู้ดูแลถ้าต้องการสิทธิ์เพิ่ม</p>
<a class="link" href="/home">← กลับหน้าหลัก</a> &nbsp; <a class="link" href="/logout">ออกจากระบบ</a>`;
  return new Response(SHELL("ไม่มีสิทธิ์ — LOVEPET", body), { status: 403, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" } });
}
function offNetworkPage(request, sess) {
  const ip = request.headers.get("CF-Connecting-IP") || "-";
  const body = `<img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS"><h1>อยู่นอกเครือข่ายที่อนุญาต</h1>
<p class="msg">⛔ บัญชี <b>${esc(sess.user)}</b> เข้าใช้งานได้เฉพาะเมื่อเชื่อมต่อ <b>WiFi ที่ทำงาน</b><br>
กรุณาเชื่อมต่อ WiFi ของร้าน แล้วลองใหม่ (ปิด VPN ถ้าเปิดอยู่)</p>
<p class="sub">IP ปัจจุบัน: ${esc(ip)}</p>
<a class="link" href="/home">↻ ลองใหม่</a> &nbsp; <a class="link" href="/logout">ออกจากระบบ</a>`;
  return new Response(SHELL("นอกเครือข่าย — LOVEPET", body), { status: 403, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" } });
}

// ===== อัปเดตไฟล์ Master (จัดซื้อ) — โหลดไฟล์ปัจจุบัน → แก้ในเครื่อง → อัปกลับ =====
// ไฟล์เก็บใน GitHub repo (ได้ประวัติ+ย้อนกลับฟรี) · อัปเสร็จยิง repository_dispatch ให้ Actions สร้างแดชบอร์ดใหม่
const MASTER_FILES = {
  master:   { path: "Master_Multiplier.xlsx", kind: "xlsx", max: 8 * 1024 * 1024,
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  approved: { path: "Approved_NoSubUnit.csv", kind: "csv",  max: 2 * 1024 * 1024,
              type: "text/csv; charset=utf-8" },
};
const JSONH = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSONH });

function ghCfg(env) {
  return {
    repo:   env.GH_REPO   || "piyawanthiemtan-star/smartpet-dashboard",
    branch: env.GH_BRANCH || "main",
    token:  String(env.GH_TOKEN || "").trim(),   // trim: วาง token แล้วติดช่องว่าง/ขึ้นบรรทัด = 401
  };
}
// บอกใบ้เวลา GitHub ตอบ 401 โดยไม่เปิดเผยค่า token (บอกแค่ความยาว + ขึ้นต้นถูกไหม)
function ghAuthHint(env) {
  const t = ghCfg(env).token;
  return " · token ที่ตั้งไว้ยาว " + t.length + " ตัว"
       + (t.startsWith("github_pat_") ? " ขึ้นต้นถูกต้อง (น่าจะหมดอายุ/สิทธิ์ไม่พอ/วางไม่ครบ)"
                                      : " แต่ไม่ได้ขึ้นต้นด้วย github_pat_ — น่าจะวางผิดค่า");
}
async function gh(env, path, init) {
  const c = ghCfg(env);
  const headers = Object.assign({
    "Authorization": "Bearer " + c.token,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lovepet-portal",          // GitHub API บังคับต้องมี User-Agent
  }, (init && init.headers) || {});
  return fetch("https://api.github.com/repos/" + c.repo + path, Object.assign({}, init || {}, { headers }));
}
// ต้องล็อกอิน + อยู่ในเครือข่ายที่อนุญาต + มีสิทธิ์จัดซื้อ (owner มีอยู่แล้ว)
async function masterGuard(request, env) {
  const sess = await readSession(request, env);
  if (!sess) return { err: jsonRes({ error: "ต้องเข้าสู่ระบบก่อน" }, 401) };
  if (ipRestricted(request, env, sess)) return { err: jsonRes({ error: "อยู่นอกเครือข่ายที่อนุญาต" }, 403) };
  if (!canSee(sess, "purchasing")) return { err: jsonRes({ error: "ไม่มีสิทธิ์อัปเดต Master" }, 403) };
  return { sess };
}

async function masterApi(request, env, url) {
  const g = await masterGuard(request, env);
  if (g.err) return g.err;
  const c = ghCfg(env);
  if (!c.token) return jsonRes({ error: "ยังไม่ได้ตั้งค่า GH_TOKEN บน Cloudflare (ติดต่อผู้ดูแล)" }, 503);
  const sub = url.pathname.replace("/api/master/", "");

  // ข้อมูลไฟล์ปัจจุบัน (ขนาด + แก้ล่าสุดเมื่อไหร่ โดยใคร)
  if (sub === "meta" && request.method === "GET") {
    const out = {};
    for (const k of Object.keys(MASTER_FILES)) {
      const f = MASTER_FILES[k];
      const p = encodeURIComponent(f.path);
      const r = await gh(env, "/contents/" + p + "?ref=" + encodeURIComponent(c.branch));
      if (!r.ok) {
        out[k] = { name: f.path, error: "อ่านไฟล์ไม่ได้ (" + r.status + ")" + (r.status === 401 ? ghAuthHint(env) : "") };
        continue;
      }
      const j = await r.json();
      out[k] = { name: f.path, size: j.size, sha: (j.sha || "").slice(0, 7) };
      const cr = await gh(env, "/commits?path=" + p + "&per_page=1&sha=" + encodeURIComponent(c.branch));
      if (cr.ok) {
        const cj = await cr.json();
        if (Array.isArray(cj) && cj[0]) {
          out[k].updated = cj[0].commit && cj[0].commit.committer ? cj[0].commit.committer.date : null;
          out[k].msg = cj[0].commit ? String(cj[0].commit.message || "").split("\n")[0] : "";
        }
      }
    }
    return jsonRes(out);
  }

  // ดาวน์โหลดไฟล์ปัจจุบัน (ให้เอาไปแก้/เพิ่มแถวต่อท้าย)
  if (sub === "file" && request.method === "GET") {
    const f = MASTER_FILES[url.searchParams.get("f")];
    if (!f) return jsonRes({ error: "ไม่รู้จักไฟล์นี้" }, 400);
    const r = await gh(env, "/contents/" + encodeURIComponent(f.path) + "?ref=" + encodeURIComponent(c.branch),
                       { headers: { "Accept": "application/vnd.github.raw" } });
    if (!r.ok) return jsonRes({ error: "โหลดไฟล์จาก GitHub ไม่ได้ (" + r.status + ")" + (r.status === 401 ? ghAuthHint(env) : "") }, 502);
    return new Response(r.body, { status: 200, headers: {
      "Content-Type": f.type,
      "Content-Disposition": 'attachment; filename="' + f.path + '"',
      "Cache-Control": "no-store" } });
  }

  // อัปไฟล์ใหม่ทับ แล้วสั่งให้ Actions สร้างแดชบอร์ดใหม่
  if (sub === "upload" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const f = MASTER_FILES[body.f];
    if (!f) return jsonRes({ error: "ไม่รู้จักไฟล์นี้" }, 400);
    const b64 = String(body.content || "").replace(/\s+/g, "");
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return jsonRes({ error: "ไฟล์ที่ส่งมาไม่ถูกต้อง" }, 400);
    if (Math.floor(b64.length * 3 / 4) > f.max) return jsonRes({ error: "ไฟล์ใหญ่เกินกำหนด" }, 413);

    const p = encodeURIComponent(f.path);
    const cur = await gh(env, "/contents/" + p + "?ref=" + encodeURIComponent(c.branch));
    if (!cur.ok) return jsonRes({ error: "อ่านไฟล์เดิมไม่ได้ (" + cur.status + ")" + (cur.status === 401 ? ghAuthHint(env) : "") }, 502);
    const sha = (await cur.json()).sha;

    const note = String(body.note || "").slice(0, 120).replace(/[\r\n]+/g, " ");
    const msg = "Master: อัปเดต " + f.path + " โดย " + g.sess.user + (note ? " — " + note : "");
    const put = await gh(env, "/contents/" + p, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, content: b64, sha, branch: c.branch }),
    });
    if (!put.ok) return jsonRes({ error: "บันทึกไฟล์ไม่สำเร็จ (" + put.status + ")" }, 502);
    const pj = await put.json().catch(() => ({}));

    const disp = await gh(env, "/dispatches", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "master-updated", client_payload: { file: f.path, by: g.sess.user } }),
    });
    return jsonRes({ ok: true,
      commit: pj.commit && pj.commit.sha ? pj.commit.sha.slice(0, 7) : "",
      dispatched: disp.status === 204 });
  }

  return jsonRes({ error: "ไม่พบ endpoint" }, 404);
}

// ===== ผูกสินค้า→ซัพพลายเออร์ (หน้าสั่งซื้อรายซัพ /purchasing-order) =====
// เก็บ vendor_map_manual.csv ใน repo (ได้ประวัติ+ย้อนกลับฟรี เหมือนหน้า Master)
// supplier_order.py อ่านไฟล์นี้เป็นชั้นที่ชนะทุกชั้น (ประวัติรับของ/PO/เดาประเภท/เดาแบรนด์)
const VMAP_FILE = "vendor_map_manual.csv";
const VMAP_HEADER = "barcode,vendor_id,vendor_name,by,date";

function b64ToUtf8(b64) {
  const bin = atob(String(b64 || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function vendorMapApi(request, env) {
  if (request.method !== "POST") return jsonRes({ error: "ไม่พบ endpoint" }, 404);
  const g = await masterGuard(request, env);   // ล็อกอิน + WiFi ร้าน + สิทธิ์จัดซื้อ (เหมือนหน้า Master)
  if (g.err) return g.err;
  const c = ghCfg(env);
  if (!c.token) return jsonRes({ error: "ยังไม่ได้ตั้งค่า GH_TOKEN บน Cloudflare (ติดต่อผู้ดูแล)" }, 503);

  const body = await request.json().catch(() => ({}));
  const vid = String(body.vid || "").trim();
  if (!/^[\w\-]{1,64}$/.test(vid)) return jsonRes({ error: "รหัสซัพพลายเออร์ไม่ถูกต้อง" }, 400);
  const clean = (s, n) => String(s || "").slice(0, n).replace(/[",\r\n]+/g, " ").trim();
  const vname = clean(body.vname, 80);
  const by = clean(g.sess.user, 40);
  let bcs = Array.isArray(body.bcs) ? body.bcs.map((b) => String(b || "").trim()) : [];
  bcs = [...new Set(bcs.filter((b) => /^[0-9A-Za-z.\-]{3,32}$/.test(b)))];
  if (!bcs.length) return jsonRes({ error: "ไม่มีบาร์โค้ดที่ใช้ได้ในรายการที่ส่งมา" }, 400);
  if (bcs.length > 2000) return jsonRes({ error: "ครั้งละไม่เกิน 2,000 รายการ" }, 400);

  const p = encodeURIComponent(VMAP_FILE);
  const today = new Date().toISOString().slice(0, 10);
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {   // ไฟล์ขยับระหว่างทาง (คนอื่นบันทึกพร้อมกัน) = ดึงใหม่ ลองอีกรอบเดียว
    const cur = await gh(env, "/contents/" + p + "?ref=" + encodeURIComponent(c.branch));
    let sha = null;
    const rows = new Map();                          // bc -> บรรทัด CSV (บันทึกใหม่ทับตัวเดิมของบาร์โค้ดนั้น)
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      for (const line of b64ToUtf8(j.content).split(/\r?\n/)) {
        const bc = (line.split(",")[0] || "").trim();
        if (bc && bc.toLowerCase() !== "barcode") rows.set(bc, line);
      }
    } else if (cur.status !== 404) {                 // 404 = ยังไม่มีไฟล์ -> เริ่มไฟล์ใหม่ได้
      return jsonRes({ error: "อ่านไฟล์ผูกซัพไม่ได้ (" + cur.status + ")" + (cur.status === 401 ? ghAuthHint(env) : "") }, 502);
    }
    for (const bc of bcs) rows.set(bc, [bc, vid, vname, by, today].join(","));
    const text = VMAP_HEADER + "\n" + [...rows.values()].join("\n") + "\n";
    const put = await gh(env, "/contents/" + p, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({
        message: "ผูกซัพ " + bcs.length + " ตัว -> " + (vname || vid) + " โดย " + by,
        content: utf8ToB64(text), branch: c.branch }, sha ? { sha } : {})),
    });
    if (put.ok) {
      const pj = await put.json().catch(() => ({}));
      const disp = await gh(env, "/dispatches", {   // สั่ง build ใหม่ (event เดียวกับหน้า Master — deploy.yml รับอยู่แล้ว)
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: "master-updated", client_payload: { file: VMAP_FILE, by, n: bcs.length } }),
      });
      return jsonRes({ ok: true, n: bcs.length,
        commit: pj.commit && pj.commit.sha ? pj.commit.sha.slice(0, 7) : "",
        dispatched: disp.status === 204 });
    }
    lastErr = String(put.status);
    if (put.status !== 409 && put.status !== 422) break;
  }
  return jsonRes({ error: "บันทึกไม่สำเร็จ (" + lastErr + ") — กดบันทึกอีกครั้ง" }, 502);
}

// สคริปต์ฝั่งเบราว์เซอร์ของหน้าอัปเดต Master — ตรวจไฟล์ + เทียบกับของเดิมก่อนยืนยัน
// (เขียนแบบต่อสตริง ไม่ใช้ backtick/${ } เพราะอยู่ใน template literal ของ worker)
const MASTER_JS = `
var $ = function (id) { return document.getElementById(id); };
var PICK = null;
var TH_MON = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
var HEAD6 = ["no.","category","pack_barcode","product_name","single_barcode","multiplier"];

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
  return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[c]; }); }
function S(v) { return v == null ? "" : String(v).trim(); }
function fmtSize(n) { return n == null ? "-" : (n / 1024).toFixed(1) + " KB"; }
function fmtTime(iso) {
  if (!iso) return "-";
  var p = new Intl.DateTimeFormat("en-GB", { timeZone:"Asia/Bangkok", year:"numeric", month:"numeric",
    day:"numeric", hour:"2-digit", minute:"2-digit", hour12:false }).formatToParts(new Date(iso));
  var g = function (t) { for (var i = 0; i < p.length; i++) if (p[i].type === t) return p[i].value; return ""; };
  return Number(g("day")) + " " + TH_MON[Number(g("month")) - 1] + " " + (Number(g("year")) + 543)
       + " " + g("hour") + ":" + g("minute") + "น.";
}
function toB64(buf) {
  var b = new Uint8Array(buf), s = "", CH = 0x8000;
  for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
  return btoa(s);
}
function render(html) { var s = $("sum"); s.innerHTML = html; s.style.display = "block"; }

// ---------- อ่านไฟล์ ----------
function parseMaster(buf) {
  var out = { errors: [], rows: [] };
  var wb;
  try { wb = XLSX.read(new Uint8Array(buf), { type: "array" }); }
  catch (e) { out.errors.push("เปิดไฟล์ Excel ไม่ได้ (ไฟล์เสียหรือไม่ใช่ .xlsx)"); return out; }
  if (wb.SheetNames.indexOf("Master") < 0) {
    out.errors.push('ไม่พบชีตชื่อ "Master" (พบ: ' + wb.SheetNames.join(", ") + ")"); return out;
  }
  var aoa = XLSX.utils.sheet_to_json(wb.Sheets["Master"], { header: 1, raw: true, defval: null });
  if (!aoa.length) { out.errors.push("ชีต Master ว่าง"); return out; }
  var head = (aoa[0] || []).slice(0, 6).map(function (v) { return S(v).toLowerCase(); });
  for (var h = 0; h < 6; h++) if (head[h] !== HEAD6[h])
    out.errors.push("คอลัมน์ที่ " + (h + 1) + ' ต้องเป็น "' + HEAD6[h] + '" แต่พบ "' + (head[h] || "(ว่าง)") + '"');
  if (out.errors.length) return out;
  var seen = {};
  for (var i = 1; i < aoa.length; i++) {
    var r = aoa[i] || [];
    if (S(r[0]) === "") continue;                       // ไม่มีเลขลำดับ = แถวว่าง (generate.py ก็ข้าม)
    var ln = i + 1, pack = S(r[2]), single = S(r[4]), m = Number(r[5]);
    if (!pack) out.errors.push("แถว " + ln + ": ไม่มี pack_barcode");
    if (!single) out.errors.push("แถว " + ln + ": ไม่มี single_barcode");
    if (S(r[5]) === "" || !isFinite(m) || m <= 0)
      out.errors.push("แถว " + ln + ": ตัวคูณไม่ถูกต้อง (" + (S(r[5]) || "ว่าง") + ")");
    // ลังเดียวผูกได้หลายบาร์โค้ดเดี่ยว (แพ็คคละสี/คละกลิ่น) — ซ้ำจริงคือ "คู่ ลัง+เดี่ยว" ซ้ำ = นับสต๊อกซ้ำ
    var key = pack + "|" + single;
    if (pack && single) {
      if (seen[key]) out.errors.push("แถว " + ln + ": ซ้ำกับแถว " + seen[key] + " (ลัง " + pack + " + เดี่ยว " + single + " คู่เดิม)");
      else seen[key] = ln;
    }
    out.rows.push({ ln: ln, key: key, pack: pack, single: single, mult: isFinite(m) ? m : null, name: S(r[3]), cat: S(r[1]) });
  }
  if (!out.rows.length) out.errors.push("ไม่พบข้อมูลสักแถวในชีต Master");
  return out;
}
function parseApproved(buf) {
  var out = { errors: [], rows: [] };
  var txt = new TextDecoder("utf-8").decode(new Uint8Array(buf)).replace(/^\\uFEFF/, "");
  var lines = txt.split(/\\r?\\n/).filter(function (l) { return l.trim() !== ""; });
  if (!lines.length) { out.errors.push("ไฟล์ว่าง"); return out; }
  var head = lines[0].split(",").map(function (s) { return s.trim().toLowerCase(); });
  if (head[0] !== "barcode") { out.errors.push('คอลัมน์แรกต้องชื่อ "barcode" แต่พบ "' + (head[0] || "(ว่าง)") + '"'); return out; }
  var seen = {};
  for (var i = 1; i < lines.length; i++) {
    var cells = lines[i].split(","), bc = S(cells[0]), ln = i + 1;
    if (!bc) { out.errors.push("แถว " + ln + ": ไม่มีบาร์โค้ด"); continue; }
    if (seen[bc]) out.errors.push("แถว " + ln + ": บาร์โค้ดซ้ำกับแถว " + seen[bc] + " (" + bc + ")");
    else seen[bc] = ln;
    out.rows.push({ ln: ln, key: bc, pack: bc, name: S(cells[1]), cat: S(cells[2]) });
  }
  if (!out.rows.length) out.errors.push("ไม่พบข้อมูลสักแถว");
  return out;
}
function diffRows(nw, od, isMaster) {
  var oi = {}, ni = {}, add = [], chg = [], del = [];
  od.forEach(function (r) { oi[r.key] = r; });
  nw.forEach(function (r) { ni[r.key] = r; });
  nw.forEach(function (r) {
    var o = oi[r.key];
    if (!o) add.push(r);
    else if (isMaster && o.mult !== r.mult) chg.push({ n: r, o: o });
  });
  od.forEach(function (r) { if (!ni[r.key]) del.push(r); });
  return { add: add, chg: chg, del: del };
}

// ---------- แสดงผล ----------
function rowsTable(rows, isMaster) {
  var h = '<table class="tbl"><tr><th>' + (isMaster ? "บาร์โค้ด ลัง → เดี่ยว" : "บาร์โค้ด")
        + "</th><th>สินค้า</th>" + (isMaster ? "<th>ตัวคูณ</th>" : "") + "</tr>";
  rows.slice(0, 10).forEach(function (r) {
    h += '<tr><td class="mono">' + esc(r.pack) + (isMaster ? " → " + esc(r.single) : "")
       + "</td><td>" + esc(r.name || "-") + "</td>"
       + (isMaster ? "<td>×" + esc(r.mult) + "</td>" : "") + "</tr>";
  });
  h += "</table>";
  if (rows.length > 10) h += '<p class="hint" style="margin:6px 0 0">…และอีก ' + (rows.length - 10) + " รายการ</p>";
  return h;
}
function showSummary(kind, file, res, old) {
  var isMaster = kind === "master";
  var d = diffRows(res.rows, old.rows, isMaster);
  var h = '<div class="box ' + (res.errors.length ? "bad" : "ok") + '">'
        + (res.errors.length ? "❌ ไฟล์มีปัญหา " + res.errors.length + " จุด — แก้แล้วเลือกไฟล์ใหม่อีกครั้ง"
                             : "✅ ตรวจไฟล์ผ่าน — " + esc(file.name) + " (" + fmtSize(file.size) + ")");
  if (res.errors.length) {
    h += "<ul>";
    res.errors.slice(0, 15).forEach(function (e) { h += "<li>" + esc(e) + "</li>"; });
    if (res.errors.length > 15) h += "<li>…และอีก " + (res.errors.length - 15) + " จุด</li>";
    h += "</ul>";
  }
  h += "</div>";
  if (res.errors.length) { render(h); return; }

  h += '<div class="stats"><div class="st"><b>' + res.rows.length + "</b><span>แถวทั้งหมด</span></div>"
     + '<div class="st add"><b>+' + d.add.length + "</b><span>เพิ่มใหม่</span></div>"
     + (isMaster ? '<div class="st chg"><b>' + d.chg.length + "</b><span>แก้ตัวคูณ</span></div>" : "")
     + '<div class="st del"><b>' + (d.del.length ? "-" + d.del.length : "0") + "</b><span>หายไป</span></div></div>";

  var lim = Math.max(5, Math.round(old.rows.length * 0.05));
  if (d.del.length > lim)
    h += '<div class="box warn">⚠️ มีรายการหายไป ' + d.del.length + " รายการ (เดิม " + old.rows.length
       + " แถว) — เช็คก่อนว่าอัปไฟล์ถูกตัวไหม ปกติควรเพิ่มต่อท้าย ไม่ใช่ลบของเดิม</div>";
  if (!d.add.length && !d.chg.length && !d.del.length)
    h += '<div class="box warn">ไฟล์นี้เหมือนของเดิมทุกอย่าง — อัปไปก็ไม่มีอะไรเปลี่ยน</div>';
  if (d.add.length) h += "<h3 style=\\"font-size:15px;color:var(--navy);margin:14px 0 0\\">เพิ่มใหม่</h3>" + rowsTable(d.add, isMaster);
  if (d.chg.length) {
    h += "<h3 style=\\"font-size:15px;color:var(--navy);margin:14px 0 0\\">แก้ไข</h3>"
       + '<table class="tbl"><tr><th>บาร์โค้ด</th><th>สินค้า</th><th>เดิม</th><th>ใหม่</th></tr>';
    d.chg.slice(0, 10).forEach(function (c) {
      h += '<tr><td class="mono">' + esc(c.n.pack) + "</td><td>" + esc(c.n.name || "-") + "</td><td>×"
         + esc(c.o.mult) + "</td><td><b>×" + esc(c.n.mult) + "</b></td></tr>";
    });
    h += "</table>";
    if (d.chg.length > 10) h += '<p class="hint" style="margin:6px 0 0">…และอีก ' + (d.chg.length - 10) + " รายการ</p>";
  }
  if (d.del.length) h += "<h3 style=\\"font-size:15px;color:var(--navy);margin:14px 0 0\\">หายไปจากไฟล์ใหม่</h3>" + rowsTable(d.del, isMaster);

  h += '<div style="margin-top:18px"><input id="note" placeholder="บันทึกย่อ (ไม่ใส่ก็ได้) เช่น เพิ่มสินค้าใหม่ 12 ตัว" '
     + 'style="width:100%;max-width:420px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;font-family:inherit;font-size:14px">'
     + '<br><button class="btn gold" id="go">✅ ยืนยันใช้ไฟล์นี้</button>'
     + '<span class="hint" id="st2" style="margin-left:12px"></span></div>';
  render(h);
  $("go").addEventListener("click", doUpload);
}
function doUpload() {
  var b = $("go"); b.disabled = true;
  $("st2").textContent = "กำลังส่ง…";
  fetch("/api/master/upload", { method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ f: PICK.kind, content: PICK.b64, note: ($("note").value || "") })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.error) throw new Error(j.error);
    render('<div class="box ok">✅ บันทึกไฟล์ใหม่แล้ว' + (j.commit ? " (เวอร์ชัน " + esc(j.commit) + ")" : "")
      + "<br>" + (j.dispatched ? "ระบบกำลังคำนวณแดชบอร์ดใหม่ ใช้เวลาประมาณ 2-3 นาที"
                               : "⚠️ บันทึกไฟล์แล้ว แต่สั่งคำนวณใหม่ไม่สำเร็จ — แดชบอร์ดจะอัปเดตในรอบถัดไป")
      + '<br>เช็คได้ที่หัวแดชบอร์ด บรรทัด "ข้อมูล ณ" ว่าเวลาเปลี่ยนหรือยัง</div>'
      + '<a class="btn" href="/purchasing">ไปที่แดชบอร์ดจัดซื้อ</a>');
  }).catch(function (e) {
    b.disabled = false;
    $("st2").innerHTML = '<span style="color:#b3261e">' + esc(e.message || "ส่งไม่สำเร็จ") + "</span>";
  });
}

// ---------- เริ่มทำงาน ----------
fetch("/api/master/meta", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (m) {
  ["master", "approved"].forEach(function (k) {
    var d = m[k] || {};
    $("m-" + k).textContent = d.error ? d.error : (fmtSize(d.size) + " · แก้ล่าสุด " + fmtTime(d.updated));
  });
}).catch(function () {
  $("m-master").textContent = "โหลดข้อมูลไม่ได้";
  $("m-approved").textContent = "โหลดข้อมูลไม่ได้";
});

$("fin").addEventListener("change", function (e) {
  var f = e.target.files && e.target.files[0];
  if (!f) return;
  var nm = f.name.toLowerCase();
  var kind = /\\.xlsx$/.test(nm) ? "master" : (/\\.csv$/.test(nm) ? "approved" : null);
  if (!kind) { render('<div class="box bad">รองรับเฉพาะไฟล์ .xlsx (Master) และ .csv (Approved)</div>'); return; }
  render('<div class="box warn">⏳ กำลังตรวจไฟล์…</div>');
  var buf;
  f.arrayBuffer().then(function (b) {
    buf = b;
    return fetch("/api/master/file?f=" + kind, { credentials: "same-origin" });
  }).then(function (r) {
    if (!r.ok) throw new Error("โหลดไฟล์ปัจจุบันมาเทียบไม่ได้");
    return r.arrayBuffer();
  }).then(function (oldBuf) {
    var res = kind === "master" ? parseMaster(buf) : parseApproved(buf);
    var old = kind === "master" ? parseMaster(oldBuf) : parseApproved(oldBuf);
    PICK = { kind: kind, b64: toB64(buf) };
    showSummary(kind, f, res, old);
  }).catch(function (err) {
    render('<div class="box bad">' + esc(err.message || "อ่านไฟล์ไม่สำเร็จ") + "</div>");
  });
});
`;

const MASTER_EXTRA_CSS = `.card{background:var(--surface);border:1px solid var(--gold-soft);border-radius:var(--r-card);padding:22px 22px 24px;box-shadow:var(--sh-sm);margin-bottom:20px}
.card h2{font-size:18px;color:var(--navy);margin-bottom:4px}
.card .hint{font-size:13.5px;color:var(--muted);margin:0 0 16px}
.frow{display:flex;gap:14px;flex-wrap:wrap}
.fbox{flex:1 1 300px;border:1px solid var(--border);border-radius:var(--r-md);padding:14px 16px;background:#fff}
.fbox .fn{font-weight:700;color:var(--navy);font-size:14.5px;word-break:break-all}
.fbox .fm{font-size:12.5px;color:var(--muted);margin-top:3px;min-height:19px}
.btn{display:inline-block;margin-top:10px;background:var(--navy);color:#fff;border:0;border-radius:var(--r-md);padding:9px 18px;font-family:var(--f-body);font-weight:600;font-size:14px;text-decoration:none;cursor:pointer}
.btn:hover{background:var(--navy-l)}
.btn.gold{background:var(--gold-d)} .btn.gold:hover{background:var(--gold)}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.drop{border:2px dashed var(--gold-soft);border-radius:var(--r-md);padding:26px;text-align:center;background:#fff}
.drop input{display:block;margin:10px auto 0}
.sum{margin-top:16px;display:none}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.st{background:#fff;border:1px solid var(--border);border-radius:var(--r-md);padding:9px 15px;min-width:96px}
.st b{display:block;font-size:20px;color:var(--navy);font-family:var(--f-head)}
.st span{font-size:12px;color:var(--muted)}
.st.add b{color:#2f7d4f} .st.chg b{color:var(--gold-d)} .st.del b{color:#b3261e}
.box{border-radius:var(--r-md);padding:12px 15px;font-size:13.5px;margin-bottom:12px;line-height:1.6}
.box.ok{background:#e8f3ec;color:#1f5c39} .box.warn{background:#fdf3e0;color:#8a5a12} .box.bad{background:#fbe6e4;color:#9b2018}
.box ul{margin:6px 0 0;padding-left:20px} .box li{margin:2px 0}
.tbl{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
.tbl th,.tbl td{border-bottom:1px solid var(--border);padding:6px 8px;text-align:left}
.tbl th{color:var(--muted);font-weight:600}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
.back{color:var(--gold-d);font-weight:600;text-decoration:none;font-size:14px}`;

function masterPage(sess) {
  const brs = sessBranches(sess);
  const brLabel = brs.includes("*") ? "ทุกสาขา" : brs.map(branchName).join(" · ");
  const nav = `<div class="nav"><img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS">
<div class="co">บริษัท เลิฟเพ็ท โกลบอลพลัส จำกัด<small>LOVE PET GLOBAL PLUS CO., LTD.</small></div>
<div class="who"><span class="chip"><b>${esc(sess.user)}</b> · ${esc(brLabel)}</span>
<a class="out" href="/logout">ออกจากระบบ</a></div></div>`;

  const main = `<style>${MASTER_EXTRA_CSS}</style>
<a class="back" href="/purchasing">← กลับแดชบอร์ดจัดซื้อ</a>
<h1 class="hi" style="margin-top:10px">อัปเดตข้อมูล <span class="em">Master</span></h1>
<p class="lead">โหลดไฟล์ปัจจุบันลงมา → เพิ่ม/แก้แถวต่อท้ายในโปรแกรม Excel → อัปกลับขึ้นมา ระบบจะคำนวณแดชบอร์ดใหม่ให้เอง</p>

<div class="card"><h2>1) โหลดไฟล์ปัจจุบัน</h2>
<p class="hint">ใช้ไฟล์นี้เป็นตัวตั้งต้นเสมอ อย่าสร้างไฟล์ใหม่เอง (คอลัมน์จะไม่ตรง)</p>
<div class="frow">
  <div class="fbox"><div class="fn">Master_Multiplier.xlsx</div><div class="fm" id="m-master">กำลังโหลด…</div>
    <a class="btn" href="/api/master/file?f=master">⬇ ดาวน์โหลด</a></div>
  <div class="fbox"><div class="fn">Approved_NoSubUnit.csv</div><div class="fm" id="m-approved">กำลังโหลด…</div>
    <a class="btn" href="/api/master/file?f=approved">⬇ ดาวน์โหลด</a></div>
</div></div>

<div class="card"><h2>2) อัปไฟล์ที่แก้แล้วกลับขึ้นมา</h2>
<p class="hint">ระบบจะตรวจไฟล์ให้ก่อน แล้วสรุปว่าเปลี่ยนอะไรบ้าง — ต้องกดยืนยันเองถึงจะใช้จริง</p>
<div class="drop">📄 เลือกไฟล์ <b>.xlsx</b> (Master) หรือ <b>.csv</b> (Approved)
<input type="file" id="fin" accept=".xlsx,.csv"></div>
<div class="sum" id="sum"></div>
</div>
<p class="foot">© บริษัท เลิฟเพ็ท โกลบอลพลัส จำกัด · Loei Smart Group</p>
<script src="/vendor/xlsx.full.min.js"></script>
<script>${MASTER_JS}</script>`;
  return new Response(HOME_SHELL("อัปเดต Master — LOVEPET", nav, main),
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // สาธารณะ: ไฟล์ static (โลโก้/รูป/ฟอนต์/manifest) + หน้าหลัก
    if (path.startsWith("/icon-") || path === "/manifest.webmanifest"
        || /\.(woff2?|jpe?g|png|svg|css|ico)$/i.test(path)) return env.ASSETS.fetch(request);
    if (path === "/" || path === "/index.html") return env.ASSETS.fetch(request);
    // หน้าสินค้าและบริการ — สาธารณะ ลูกค้าเข้าดูได้เลย ไม่ต้องล็อกอิน
    // ส่ง request เดิมให้ ASSETS ตรงๆ (Pages เสิร์ฟ services.html ให้เอง)
    // ห้ามขอ "/services.html" เพราะ Pages จะ 308 กลับมาที่ /services → วนลูป
    if (path === "/services" || path === "/services.html") return env.ASSETS.fetch(request);

    if (path === "/logout")
      return new Response(null, { status: 302, headers: { "Location": "/", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0` } });

    // /whoami — เช็ค public IP ที่ Cloudflare เห็น (ไว้เก็บ IP ร้านสำหรับ allowlist)
    if (path === "/whoami") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const cf = request.cf || {};
      const isV6 = ip.includes(":");
      const prefix64 = isV6 ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip + "/32";
      const allow = String(env.OFFICE_IPS || "").split(",").map((s) => s.trim()).filter(Boolean);
      const inList = ipAllowed(ip, allow);
      const status = allow.length === 0
        ? `<p class="msg">ยังไม่ได้ตั้ง allowlist (ตอนนี้เข้าได้ทุกที่)</p>`
        : (inList
          ? `<div class="err" style="background:#dcefe0;color:#1f7a3d">✅ อยู่ในเครือข่ายที่อนุญาต</div>`
          : `<div class="err">⛔ ไม่อยู่ใน allowlist</div>`);
      const body = `<img class="logo" src="/logo.png" alt="LOVEPET GLOBALPLUS"><h1>IP ของคุณ</h1>
<p class="sub" style="font-size:19px;color:var(--navy);font-weight:700;margin:6px 0 6px;word-break:break-all">${esc(ip)}</p>
<p class="sub" style="margin:0 0 14px">ชนิด: <b>${isV6 ? "IPv6" : "IPv4"}</b></p>
${status}
<div class="msg" style="text-align:left;font-size:13px">
<div style="background:var(--gold-soft,#faeecd);border-radius:10px;padding:10px 12px;margin-bottom:10px">
ค่าที่ใช้ allowlist:<br><b style="font-size:15px;word-break:break-all">${esc(prefix64)}</b></div>
ISP/องค์กร: <b>${esc(cf.asOrganization || "-")}</b><br>
ประเทศ: <b>${esc(cf.country || "-")}</b> · เมือง: <b>${esc(cf.city || "-")}</b><br>
<span style="color:var(--muted)">เปิดจาก WiFi แต่ละสาขา (ปิด VPN) แล้วส่ง "ค่าที่ใช้ allowlist" + ISP มาให้ผม</span></div>
<a class="link" href="/">← กลับหน้าหลัก</a>`;
      return new Response(SHELL("IP ของคุณ — LOVEPET", body), { status: 200, headers: { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" } });
    }

    // หน้าหลังล็อกอิน — การ์ดแผนกตามสิทธิ์
    if (path === "/home") {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/home") } });
      if (ipRestricted(request, env, sess)) return offNetworkPage(request, sess);
      return homePage(sess, env);
    }

    if (path === "/login") {
      if (request.method === "POST") {
        const f = await request.formData();
        const next = safeNext(f.get("next"));
        const empId = (f.get("employee_id") || "").trim();
        const pin = (f.get("pin") || "").trim();

        // 1) ล็อกอินผ่าน Supabase (เลือกชื่อ + PIN)
        if (empId) {
          const { status, data } = await portalCall(env, { action: "login", employee_id: empId, pin,
            client_ip: request.headers.get("CF-Connecting-IP") || "" });   // ให้ rate-limit เก็บ IP จริงของผู้ใช้ไว้ตรวจย้อนหลัง
          if (status === 200 && data.employee) {
            const sess = {
              user: data.employee.name,
              role: data.employee.role || "staff",
              sections: data.permissions?.sections || [],
              branches: data.permissions?.branches || [],
              is_admin: !!data.permissions?.is_admin,
            };
            const val = await makeSession(sess, env);
            return new Response(null, { status: 302, headers: {
              "Location": next,
              "Set-Cookie": `${COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` } });
          }
          return loginPage(env, { err: data.error || "เข้าสู่ระบบไม่สำเร็จ", next });
        }

        // 2) fallback: เฉพาะ owner ฉุกเฉิน (AUTH_USER/AUTH_PASS) — ไม่ใช้ AUTH_USERS แล้ว (Supabase เป็นแหล่งหลัก)
        const u = (f.get("user") || "").trim();
        if (u && env.AUTH_USER && u === env.AUTH_USER && env.AUTH_PASS && pin === String(env.AUTH_PASS)) {
          const sess = { user: u, role: "owner", sections: ACCESS.owner, branches: ["*"], is_admin: true };
          const val = await makeSession(sess, env);
          return new Response(null, { status: 302, headers: {
            "Location": next,
            "Set-Cookie": `${COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` } });
        }
        return loginPage(env, { err: "ชื่อผู้ใช้หรือ PIN ไม่ถูกต้อง", next });
      }
      return loginPage(env, { next: safeNext(url.searchParams.get("next")) });
    }

    // ไลบรารีอ่าน .xlsx ฝั่งเบราว์เซอร์ (ใช้เฉพาะหน้าอัปเดต Master)
    if (path === "/vendor/xlsx.full.min.js") return env.ASSETS.fetch(request);

    // อัปเดตไฟล์ Master — หน้าเว็บ + API (ต้องมีสิทธิ์จัดซื้อ)
    if (path === "/purchasing/master") {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/purchasing/master") } });
      if (ipRestricted(request, env, sess)) return offNetworkPage(request, sess);
      if (!canSee(sess, "purchasing")) return forbidden("purchasing", sess);
      return masterPage(sess);
    }
    if (path.startsWith("/api/master/")) return masterApi(request, env, url);
    if (path === "/api/vendor-map/save") return vendorMapApi(request, env);

    // สรุปผู้บริหาร — เฉพาะ owner/admin เท่านั้น · แยกไฟล์จากหน้าจัดซื้อ
    // (ข้อมูลกำไร/มาร์จิ้น/เร่งระบายไม่ถูกฝังในไฟล์จัดซื้อ ทีมจัดซื้อจึงเปิดดูไม่ได้แม้ view-source)
    const execP = path.replace(/^\/+/, "").replace(/\.html$/, "").split("/")[0];
    if (execP === "executive") {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/executive") } });
      if (!sess.is_admin) return forbidden("executive", sess);   // owner บายพาส ipRestricted อยู่แล้ว
      const b = (url.searchParams.get("b") || "").toUpperCase();
      if (b === "ML2") return env.ASSETS.fetch(new Request(new URL("/executive-ml2", url), request));
      return env.ASSETS.fetch(new Request(new URL("/executive", url), request));   // clean URL → executive.html
    }

    // สั่งซื้อรายซัพพลายเออร์ — สิทธิ์ทีมจัดซื้อ (สร้างบนคลาวด์ทุก build จาก supplier_order.py)
    if (execP === "purchasing-order") {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/purchasing-order") } });
      if (ipRestricted(request, env, sess)) return offNetworkPage(request, sess);
      if (!canSee(sess, "purchasing")) return forbidden("purchasing", sess);
      return env.ASSETS.fetch(new Request(new URL("/purchasing-order", url), request));   // clean URL → purchasing-order.html
    }

    // วัดผลระบายสต๊อกกลุ่ม C — เฉพาะ owner/admin (สร้างบนคลาวด์ทุก build จาก clearance_report.py)
    if (execP === "clearance") {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/clearance") } });
      if (!sess.is_admin) return forbidden("clearance", sess);
      return env.ASSETS.fetch(new Request(new URL("/clearance", url), request));   // clean URL → clearance.html
    }

    // สรุปปิดบิลสิ้นวัน — เฉพาะ owner/admin · ไฟล์เดียวรวมทุกสาขา (เลือกวันที่ในหน้าเว็บ)
    if (execP === "daily") {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/daily") } });
      if (!sess.is_admin) return forbidden("daily", sess);
      return env.ASSETS.fetch(new Request(new URL("/daily", url), request));   // clean URL → daily.html
    }

    // ===== API เจ้าหนี้การค้า (Supabase ตาราง ap_bills) — ทีมบัญชี + owner [22 ส.ค. 2569] =====
    // GET /api/ap = สถานะทุกบิล · POST /api/ap/update = upsert สถานะ/ยอดจริง (key bill_id = "ML3-<ImportProduct.Id>")
    if (path === "/api/ap" || path === "/api/ap/update") {
      const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      const sess = await readSession(request, env);
      if (!sess) return J({ error: "กรุณาเข้าสู่ระบบ" }, 401);
      if (!(sess.is_admin || canSee(sess, "accounting"))) return J({ error: "เฉพาะทีมบัญชี/ผู้บริหาร" }, 403);
      if (!env.SB_URL || !env.SB_SERVICE_KEY) return J({ error: "ยังไม่ได้ตั้ง secret SB_SERVICE_KEY บน Cloudflare" }, 500);
      const sb = (p, init = {}) => fetch(env.SB_URL + "/rest/v1/" + p, { ...init,
        headers: { "apikey": env.SB_SERVICE_KEY, "Authorization": "Bearer " + env.SB_SERVICE_KEY, "Content-Type": "application/json", ...(init.headers || {}) } });
      if (request.method === "GET" && path === "/api/ap") {
        const r = await sb("ap_bills?select=*&limit=5000");
        return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && path === "/api/ap/update") {
        let b; try { b = await request.json(); } catch { return J({ error: "bad json" }, 400); }
        const id = String(b.bill_id || "").trim();
        if (!/^ML[23]-\d{1,12}$/.test(id)) return J({ error: "รหัสบิลไม่ถูกต้อง" }, 400);
        const status = String(b.status || "open");
        if (!["open", "hold", "paid"].includes(status)) return J({ error: "สถานะไม่ถูกต้อง" }, 400);
        const num = (v) => (v === "" || v == null) ? null : (isFinite(+v) && +v >= 0 ? Math.round(+v * 100) / 100 : NaN);
        const date = (v) => { const s = String(v || "").trim(); return s ? (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : NaN) : null; };
        const txt = (v, n) => String(v == null ? "" : v).trim().slice(0, n) || null;
        const row = { bill_id: id, status, updated_by: sess.user, updated_at: new Date().toISOString() };
        if (status === "paid") {
          row.paid_date = date(b.paid_date); row.paid_amount = num(b.paid_amount);
          if (!row.paid_date || Number.isNaN(row.paid_date)) return J({ error: "วันที่จ่ายไม่ถูกต้อง" }, 400);
          if (!(row.paid_amount > 0)) return J({ error: "ยอดที่จ่ายต้องมากกว่า 0" }, 400);
          row.paid_ref = txt(b.paid_ref, 120);
        } else {
          row.paid_date = null; row.paid_amount = null; row.paid_ref = null;   // ยกเลิกจ่าย/พัก = ล้างข้อมูลจ่าย
        }
        if ("invoice_no" in b) row.invoice_no = txt(b.invoice_no, 80);
        if ("invoice_amount" in b) { row.invoice_amount = num(b.invoice_amount); if (Number.isNaN(row.invoice_amount)) return J({ error: "ยอดใบแจ้งหนี้ไม่ถูกต้อง" }, 400); }
        if ("note" in b) row.note = txt(b.note, 300);
        const r = await sb("ap_bills?on_conflict=bill_id", { method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(row) });
        const out = await r.json().catch(() => null);
        if (!r.ok) return J({ error: "บันทึกไม่สำเร็จ (" + r.status + ")" + (out && out.message ? " " + out.message : "") }, 502);
        return J({ ok: true, row: Array.isArray(out) ? out[0] : row });
      }
      return J({ error: "method not allowed" }, 405);
    }

    // ===== API ใบสั่งงานการตลาด (เก็บใน Supabase ตาราง marketing_jobs, worker ใช้ service key) =====
    // เห็นได้: owner + จัดซื้อ + การตลาด · สั่งงาน: owner เท่านั้น · อัปเดตสถานะ: การตลาด + owner
    if (path === "/api/marketing-jobs" || path === "/api/marketing-jobs/status" || path === "/api/marketing-jobs/delete" || path === "/api/marketing-jobs/image") {
      const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      const sess = await readSession(request, env);
      if (!sess) return J({ error: "กรุณาเข้าสู่ระบบ" }, 401);
      const canView = sess.is_admin || canSee(sess, "marketing") || canSee(sess, "purchasing");
      const canEdit = sess.is_admin || canSee(sess, "marketing");
      if (!canView) return J({ error: "ไม่มีสิทธิ์" }, 403);
      if (!env.SB_URL || !env.SB_SERVICE_KEY) return J({ error: "ยังไม่ได้ตั้ง secret SB_SERVICE_KEY บน Cloudflare" }, 500);
      const sb = (p, init = {}) => fetch(env.SB_URL + "/rest/v1/" + p, { ...init,
        headers: { "apikey": env.SB_SERVICE_KEY, "Authorization": "Bearer " + env.SB_SERVICE_KEY, "Content-Type": "application/json", ...(init.headers || {}) } });
      if (request.method === "GET") {
        const r = await sb("marketing_jobs?select=*&order=id.desc&limit=100");
        return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && path === "/api/marketing-jobs") {
        if (!sess.is_admin) return J({ error: "สั่งงานได้เฉพาะผู้บริหาร" }, 403);
        let b; try { b = await request.json(); } catch { return J({ error: "bad json" }, 400); }
        if (!Array.isArray(b.items) || !b.items.length) return J({ error: "ไม่มีรายการสินค้า" }, 400);
        const items = b.items.slice(0, 200).map((x) => ({ bc: String(x.bc || ""), code: String(x.code || ""), name: String(x.name || "").slice(0, 200),
          price: +x.price || 0, promo: +x.promo || 0, disc: +x.disc || 0, stock: +x.stock || 0 }));
        const r = await sb("marketing_jobs", { method: "POST", headers: { "Prefer": "return=representation" },
          body: JSON.stringify({ created_by: sess.user, note: String(b.note || "").slice(0, 500), items,
            branch: String(b.branch || "").slice(0, 10) }) });
        return new Response(await r.text(), { status: r.ok ? 200 : r.status, headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST" && path === "/api/marketing-jobs/status") {
        if (!canEdit) return J({ error: "อัปเดตสถานะได้เฉพาะทีมการตลาด/ผู้บริหาร" }, 403);
        let b; try { b = await request.json(); } catch { return J({ error: "bad json" }, 400); }
        if (!["new", "doing", "done"].includes(b.status) || !(+b.id > 0)) return J({ error: "ข้อมูลไม่ครบ" }, 400);
        const patch = { status: b.status, status_by: sess.user, status_at: new Date().toISOString() };
        // ปิดงานต้องกรอก "ชื่อโปรโมชั่นที่ตั้งใน POS" เสมอ — Owner ใช้ตามยอดขายทีหลังได้
        if (b.status === "done") {
          const pp = String(b.pos_promo || "").trim();
          if (!pp) return J({ error: "ต้องใส่ชื่อโปรโมชั่นที่ตั้งใน POS ก่อนปิดงาน" }, 400);
          patch.pos_promo = pp.slice(0, 200);
        }
        const r = await sb("marketing_jobs?id=eq." + (+b.id), { method: "PATCH", body: JSON.stringify(patch) });
        return J({ ok: r.ok }, r.ok ? 200 : r.status);
      }
      // สร้างภาพฉากโปสเตอร์ด้วย Workers AI (flux-1-schnell, โควตาฟรีรายวันของ Cloudflare)
      if (request.method === "POST" && path === "/api/marketing-jobs/image") {
        if (!canEdit) return J({ error: "สร้างภาพได้เฉพาะทีมการตลาด/ผู้บริหาร" }, 403);
        if (!env.AI) return J({ error: "ยังไม่ได้ผูก Workers AI บน Cloudflare (Settings → Bindings → Workers AI ชื่อ AI)" }, 500);
        let b; try { b = await request.json(); } catch { return J({ error: "bad json" }, 400); }
        const prompt = String(b.prompt || "").slice(0, 2000);
        if (!prompt) return J({ error: "ไม่มี prompt" }, 400);
        try {
          const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt, steps: 8 });
          const img = (out && out.image) ? out.image : null;
          if (!img) return J({ error: "โมเดลไม่คืนภาพ ลองใหม่อีกครั้ง" }, 500);
          return J({ image: img });
        } catch (e) {
          return J({ error: "สร้างภาพไม่สำเร็จ: " + ((e && e.message) || e) }, 500);
        }
      }
      // ลบใบสั่งงาน — เฉพาะ owner/admin เท่านั้น (ทีมการตลาดลบไม่ได้)
      if (request.method === "POST" && path === "/api/marketing-jobs/delete") {
        if (!sess.is_admin) return J({ error: "ลบใบสั่งงานได้เฉพาะผู้บริหาร" }, 403);
        let b; try { b = await request.json(); } catch { return J({ error: "bad json" }, 400); }
        if (!(+b.id > 0)) return J({ error: "ข้อมูลไม่ครบ" }, 400);
        const r = await sb("marketing_jobs?id=eq." + (+b.id), { method: "DELETE" });
        return J({ ok: r.ok }, r.ok ? 200 : r.status);
      }
      return J({ error: "method not allowed" }, 405);
    }

    // เจ้าหนี้การค้า (AP) — ทีมบัญชี + owner · ไฟล์สร้างทุก build จาก ap_report.py (ไม่มีกำไร/ราคาขาย)
    if (execP === "accounting-ap") {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/accounting-ap") } });
      if (ipRestricted(request, env, sess)) return offNetworkPage(request, sess);
      if (!canSee(sess, "accounting")) return forbidden("accounting", sess);
      return env.ASSETS.fetch(new Request(new URL("/accounting-ap", url), request));   // clean URL → accounting-ap.html
    }

    // ใบปิดยอดรายกะ ฉบับบัญชี — ไม่มีตัวเลขกำไรในไฟล์เลย (คนละไฟล์กับ /daily ของผู้บริหาร)
    if (execP === "accounting-daily") {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/accounting-daily") } });
      if (ipRestricted(request, env, sess)) return offNetworkPage(request, sess);
      if (!canSee(sess, "accounting")) return forbidden("accounting", sess);
      return env.ASSETS.fetch(new Request(new URL("/accounting-daily", url), request));   // clean URL → accounting-daily.html
    }

    // ใบเบิกสินค้า ML2 รายวัน — สิทธิ์เดียวกับการ์ดคลังและจัดส่ง (สร้างบนคลาวด์ทุก build)
    // /requisition = วันล่าสุด · /requisition-YYYY-MM-DD = ใบย้อนหลัง (ดรอปดาวน์เลือกวันที่ในหน้า)
    // /requisition-purchase[-YYYY-MM-DD] = ใบแจ้งจัดซื้อ (ML3 หมด) — เอกสารแยกชุด
    if (execP === "requisition" || execP === "requisition-purchase" ||
        /^requisition(?:-purchase)?-\d{4}-\d{2}-\d{2}$/.test(execP)) {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/" + execP) } });
      if (ipRestricted(request, env, sess)) return offNetworkPage(request, sess);
      if (!canSee(sess, "warehouse")) return forbidden("warehouse", sess);
      return env.ASSETS.fetch(new Request(new URL("/" + execP, url), request));   // clean URL → <execP>.html
    }

    // แผนกงาน = ต้องล็อกอิน + มีสิทธิ์
    const section = path.replace(/^\/+/, "").replace(/\.html$/, "").split("/")[0];
    if (SECTIONS.includes(section)) {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/" + section) } });
      if (ipRestricted(request, env, sess)) return offNetworkPage(request, sess);
      // การตลาด: เปิดให้จัดซื้อ+owner เข้าดูใบสั่งงานด้วย (ก่อนเช็ค canSee ปกติ)
      if (section === "marketing") {
        if (!(sess.is_admin || canSee(sess, "marketing") || canSee(sess, "purchasing"))) return forbidden(section, sess);
        return marketingPage(sess, env);
      }
      if (!canSee(sess, section)) return forbidden(section, sess);
      // จัดซื้อ: สลับสาขาด้วย ?b=ML2 (คนละไฟล์ ไม่ยัดข้อมูล 2 สาขาไว้ด้วยกัน ไฟล์จะใหญ่เกินไป)
      // ขอ ASSETS ด้วย "clean URL" เสมอ — ถ้าขอ .html ตรงๆ Pages จะ 308 กลับมาแล้ววนลูป
      if (section === "purchasing") {
        const b = (url.searchParams.get("b") || "").toUpperCase();
        if (b === "ML2") return env.ASSETS.fetch(new Request(new URL("/purchasing-ml2", url), request));
        return env.ASSETS.fetch(request);
      }
      if (section === "warehouse") return env.ASSETS.fetch(request); // → warehouse.html (LSMG Logistic)
      if (section === "accounting") return accountingPage(sess, env);
      return placeholder(section, sess); // marketing/sales รอเฟส B
    }

    // อื่นๆ → หน้าหลัก
    return env.ASSETS.fetch(new Request(new URL("/", url), { method: "GET" }));
  }
};
