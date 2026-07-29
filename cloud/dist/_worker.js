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
const LABEL = { purchasing:"งานจัดซื้อ", accounting:"บัญชีและบุคคล", warehouse:"คลังและจัดส่ง", marketing:"งานการตลาด", sales:"ขายปลีก·ขายส่ง" };
const ROLE_LABEL = { owner:"เจ้าของ · ผู้บริหาร", purchasing:"ทีมจัดซื้อ", accounting:"ทีมบัญชีและบุคคล", warehouse:"ทีมคลังและจัดส่ง", marketing:"ทีมการตลาด", sales:"ทีมขาย" };
// การ์ดแผนก (เรียงตามลำดับที่จะแสดง)
const TILES = [
  { key:"purchasing", icon:"🛒", title:"งานจัดซื้อ",     desc:"ABC · จุดสั่งซื้อ · ระบายสต๊อก C · มาร์จิ้น", live:true },
  { key:"accounting", icon:"💰", title:"บัญชีและบุคคล",   desc:"บัญชี · การเงิน · งานบุคคล · ลงเวลา",     live:false },
  { key:"sales",      icon:"🧾", title:"ขายปลีก · ขายส่ง", desc:"ยอดขาย · ลูกค้า · ใบเสร็จ",                live:false },
  { key:"warehouse",  icon:"📦", title:"คลังและจัดส่ง",   desc:"LSMG Logistic · เส้นทาง · จัดส่ง · เก็บเงิน", live:true },
  { key:"marketing",  icon:"📣", title:"งานการตลาด",     desc:"โปรโมชัน · แคมเปญ · วิเคราะห์ลูกค้า",     live:false },
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
  const cards = TILES.filter((t) => allowed.includes(t.key)).map((t) => {
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
          const { status, data } = await portalCall(env, { action: "login", employee_id: empId, pin });
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

    // แผนกงาน = ต้องล็อกอิน + มีสิทธิ์
    const section = path.replace(/^\/+/, "").replace(/\.html$/, "").split("/")[0];
    if (SECTIONS.includes(section)) {
      const sess = await readSession(request, env);
      if (!sess) return new Response(null, { status: 302, headers: { "Location": "/login?next=" + encodeURIComponent("/" + section) } });
      if (ipRestricted(request, env, sess)) return offNetworkPage(request, sess);
      if (!canSee(sess, section)) return forbidden(section, sess);
      if (section === "purchasing" || section === "warehouse") return env.ASSETS.fetch(request); // → purchasing.html / warehouse.html (LSMG Logistic)
      return placeholder(section, sess); // marketing/sales/accounting รอเฟส B
    }

    // อื่นๆ → หน้าหลัก
    return env.ASSETS.fetch(new Request(new URL("/", url), { method: "GET" }));
  }
};
