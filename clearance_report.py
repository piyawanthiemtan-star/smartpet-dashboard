# -*- coding: utf-8 -*-
"""แดชบอร์ดวัดผลระบายสต๊อกกลุ่ม C — หน้าเว็บ /clearance (owner/admin เท่านั้น)
[Owner สั่งทำ 2026-08-11: เปลี่ยนจากรายงาน Excel รายสัปดาห์ (tools/clearance_weekly.py)
 เป็นหน้าเว็บที่อัปเดตเองทุกรอบ build — ไม่ต้องรอจันทร์ ไม่ต้องรันมือ]

เทียบยอดขายจริงกับ clearance_baseline.csv (300 รายการ ถ่ายไว้วันเริ่มรอบ 6 ส.ค.)
ตอบ: ขายออกกี่ชิ้น ได้เงินเท่าไหร่ ตัวไหนหมดแล้ว/ขยับ/ยังไม่ขยับ + ยอดรายสัปดาห์

รัน:  python clearance_report.py
env override (สำหรับ GitHub Actions): CLR_BASELINE, CLR_ML2_DIR, CLR_ML3_DIR, CLR_OUT
"""
import csv
import datetime
import glob
import html
import os
import sqlite3
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = r"D:\1. SmartPet AI Framework"

BASELINE = os.environ.get("CLR_BASELINE", os.path.join(HERE, "clearance_baseline.csv"))
ML2_DIR = os.environ.get("CLR_ML2_DIR", BASE + r"\SmartPetBackup\Daily\Onepoint ML2 Blackup")
ML3_DIR = os.environ.get("CLR_ML3_DIR", BASE + r"\SmartPetData\Import\OnePoint\Blackup 2026")
OUT = os.environ.get("CLR_OUT", os.path.join(HERE, "output", "clearance.html"))

ROUND_END = "2026-09-03"   # กำหนดจบรอบ (~4 สัปดาห์) — จบแล้วทำใบคืนราคา


def newest_db(folder):
    fs = glob.glob(os.path.join(folder, "*.db"))
    return max(fs, key=os.path.getmtime) if fs else None


def main():
    if not os.path.exists(BASELINE):
        sys.exit("ไม่พบ clearance_baseline.csv")
    base = list(csv.DictReader(open(BASELINE, encoding="utf-8-sig")))
    start = base[0]["start_date"]
    today = datetime.date.today().isoformat()
    day_no = (datetime.date.fromisoformat(today) - datetime.date.fromisoformat(start)).days + 1
    week_no = (day_no - 1) // 7 + 1

    dbs = {b: p for b, p in {"ML3": newest_db(ML3_DIR), "ML2": newest_db(ML2_DIR)}.items() if p}
    print(f"รอบเริ่ม {start} · วันนี้ {today} (วันที่ {day_no} ของรอบ สัปดาห์ที่ {week_no})")
    for b, p in dbs.items():
        print(f"  {b}: {os.path.basename(p)}")

    sold, stock_now, daily = {}, {}, {}
    for br, db in dbs.items():
        bcs = [r["barcode"] for r in base if r["branch"] == br]
        if not bcs:
            continue
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        q = ",".join("?" * len(bcs))
        for bc, qty, amt in con.execute(f"""
            SELECT d.Barcode, SUM(d.Qty-COALESCE(d.QtyReturn,0)),
                   SUM((d.Qty-COALESCE(d.QtyReturn,0))*d.Price - COALESCE(d.Discount,0))
            FROM OrdersDetail d JOIN Orders o ON o.Id=d.OrderId AND o.IsDelete=0
            WHERE d.IsDelete=0 AND date(o.[Create]) >= ? AND d.Barcode IN ({q})
            GROUP BY d.Barcode""", [start] + bcs):
            sold[(br, str(bc).strip())] = (qty or 0, amt or 0)
        for dt, qty, amt in con.execute(f"""
            SELECT date(o.[Create]), SUM(d.Qty-COALESCE(d.QtyReturn,0)),
                   SUM((d.Qty-COALESCE(d.QtyReturn,0))*d.Price - COALESCE(d.Discount,0))
            FROM OrdersDetail d JOIN Orders o ON o.Id=d.OrderId AND o.IsDelete=0
            WHERE d.IsDelete=0 AND date(o.[Create]) >= ? AND d.Barcode IN ({q})
            GROUP BY date(o.[Create])""", [start] + bcs):
            a = daily.setdefault(dt, [0, 0])
            a[0] += qty or 0
            a[1] += amt or 0
        for bc, qty in con.execute(
                f"SELECT Barcode, Qty FROM Product WHERE IsDelete=0 AND Barcode IN ({q})", bcs):
            stock_now[(br, str(bc).strip())] = qty or 0
        con.close()

    rows, tot_qty, tot_amt = [], 0, 0
    n_gone = n_move = n_dead = 0
    target = 0.0   # เป้าเงินคืนถ้าระบายหมดที่ราคาโปร
    per_branch = {}
    for r in base:
        k = (r["branch"], r["barcode"])
        q, amt = sold.get(k, (0, 0))
        st = stock_now.get(k)
        try:
            target += float(r["stock_start"]) * float(r["promo_price"] or 0)
        except ValueError:
            pass
        tot_qty += q
        tot_amt += amt
        pb = per_branch.setdefault(r["branch"], [0, 0])
        pb[0] += q
        pb[1] += amt
        if isinstance(st, (int, float)) and st <= 0:
            status, scls = "✅ หมดแล้ว", "gone"
            n_gone += 1
        elif q > 0:
            status, scls = "🟢 ขยับ", "move"
            n_move += 1
        else:
            status, scls = "🔴 ยังไม่ขยับ", "dead"
            n_dead += 1
        rows.append({"branch": r["branch"], "barcode": r["barcode"], "name": r["name"],
                     "start": float(r["stock_start"]), "sold": q, "amt": amt,
                     "now": st if st is not None else "-", "status": status, "scls": scls})
    rows.sort(key=lambda r: (-r["amt"], r["branch"]))

    # ยอดรายสัปดาห์ (จากยอดรายวันรวมทุกสาขา)
    weeks = {}
    for dt, (q, a) in daily.items():
        w = (datetime.date.fromisoformat(dt) - datetime.date.fromisoformat(start)).days // 7 + 1
        acc = weeks.setdefault(w, [0, 0])
        acc[0] += q
        acc[1] += a
    pct = (tot_amt / target * 100) if target else 0

    print(f"ขายออก {tot_qty:,.0f} ชิ้น · เงินคืน ฿{tot_amt:,.0f} ({pct:.0f}% ของเป้า ฿{target:,.0f})"
          f" · หมด {n_gone} · ขยับ {n_move} · ยังไม่ขยับ {n_dead}/{len(base)}")

    trs = []
    for i, r in enumerate(rows, 1):
        trs.append(
            f'<tr class="{r["scls"]}" data-s="{r["scls"]}">'
            f'<td class="c">{i}</td><td class="c">{r["branch"]}</td>'
            f'<td class="bc">{html.escape(r["barcode"])}</td><td>{html.escape(r["name"])}</td>'
            f'<td class="c">{r["start"]:g}</td><td class="c b">{r["sold"]:g}</td>'
            f'<td class="r b">{r["amt"]:,.0f}</td><td class="c">{r["now"] if isinstance(r["now"], str) else format(r["now"], "g")}</td>'
            f'<td class="c">{r["status"]}</td></tr>')
    wtr = "".join(f'<tr><td class="c">สัปดาห์ {w}</td><td class="c">{v[0]:,.0f}</td>'
                  f'<td class="r">{v[1]:,.0f}</td></tr>' for w, v in sorted(weeks.items()))
    btr = "".join(f'<tr><td class="c">{b}</td><td class="c">{v[0]:,.0f}</td>'
                  f'<td class="r">{v[1]:,.0f}</td></tr>' for b, v in sorted(per_branch.items()))
    stamp = datetime.datetime.now().strftime("%d/%m/%Y %H:%M")

    doc = f"""<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>วัดผลระบายสต๊อก C</title>
<style>
  * {{ box-sizing:border-box; }}
  body {{ font-family:Tahoma,"TH Sarabun New",sans-serif; margin:0; background:#f2f4f7; color:#15243a; font-size:14px; }}
  .wrap {{ max-width:1080px; margin:0 auto; padding:16px; }}
  h1 {{ font-size:21px; margin:4px 0 2px; color:#0C223A; }}
  .sub {{ color:#5a6b80; font-size:13px; margin-bottom:12px; }}
  .cards {{ display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; }}
  .card {{ background:#fff; border:1px solid #dfe5ec; border-radius:12px; padding:10px 16px; min-width:130px; flex:1; }}
  .card .v {{ font-size:22px; font-weight:800; color:#0C223A; }}
  .card .l {{ font-size:12px; color:#5a6b80; }}
  .card.gold .v {{ color:#8a6d1a; }}
  .bar {{ background:#e4e9ef; border-radius:99px; height:14px; overflow:hidden; margin:2px 0 12px; }}
  .bar i {{ display:block; height:100%; background:linear-gradient(90deg,#C89535,#8a6d1a); border-radius:99px; }}
  .mini {{ display:flex; gap:14px; flex-wrap:wrap; margin-bottom:12px; }}
  .mini table {{ background:#fff; border:1px solid #dfe5ec; border-radius:10px; border-collapse:separate; border-spacing:0; overflow:hidden; }}
  .mini th, .mini td {{ padding:5px 12px; border-bottom:1px solid #eef1f5; font-size:13px; }}
  .mini th {{ background:#0C223A; color:#fff; font-size:12px; }}
  .tools {{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }}
  .tools button {{ font-family:inherit; font-size:13px; padding:6px 14px; border-radius:99px; border:1px solid #c9d2dd; background:#fff; cursor:pointer; }}
  .tools button.on {{ background:#0C223A; color:#fff; border-color:#0C223A; }}
  .tools input {{ font-family:inherit; font-size:13px; padding:6px 12px; border:1px solid #c9d2dd; border-radius:8px; flex:1; min-width:180px; }}
  a.tab {{ font-size:13px; color:#0C223A; margin-right:10px; }}
  table.main {{ width:100%; border-collapse:collapse; background:#fff; }}
  .main th, .main td {{ border:1px solid #dfe5ec; padding:4px 8px; }}
  .main thead th {{ background:#0C223A; color:#fff; font-size:12px; position:sticky; top:0; }}
  td.c {{ text-align:center; }} td.r {{ text-align:right; }} td.b {{ font-weight:700; }}
  td.bc {{ font-family:Consolas,monospace; font-size:12px; }}
  tr.dead td {{ background:#fdf0ee; }}
  tr.gone td {{ background:#eef7ef; }}
  .tblwrap {{ overflow-x:auto; }}
</style></head>
<body><div class="wrap">
  <div><a class="tab" href="/executive">← คอนโซลผู้บริหาร</a><a class="tab" href="/daily">ปิดยอดรายกะ</a></div>
  <h1>📉 วัดผลระบายสต๊อกกลุ่ม C</h1>
  <div class="sub">รอบ {start} → {ROUND_END} (จบรอบทำใบคืนราคา) · วันนี้วันที่ {day_no} ของรอบ สัปดาห์ที่ {week_no}
    · ข้อมูล ณ {stamp} (อัปเดตอัตโนมัติทุกรอบระบบ)</div>
  <div class="cards">
    <div class="card"><div class="v">{tot_qty:,.0f}</div><div class="l">ขายออกแล้ว (ชิ้น)</div></div>
    <div class="card gold"><div class="v">฿{tot_amt:,.0f}</div><div class="l">เงินคืนมาแล้ว ({pct:.0f}% ของเป้า ฿{target:,.0f})</div></div>
    <div class="card"><div class="v">✅ {n_gone}</div><div class="l">หมดแล้ว (รายการ)</div></div>
    <div class="card"><div class="v">🟢 {n_move}</div><div class="l">ขยับแล้ว</div></div>
    <div class="card"><div class="v">🔴 {n_dead}</div><div class="l">ยังไม่ขยับ (จาก {len(base)})</div></div>
  </div>
  <div class="bar"><i style="width:{min(pct, 100):.0f}%"></i></div>
  <div class="mini">
    <table><thead><tr><th>สัปดาห์</th><th>ชิ้น</th><th>เงิน (฿)</th></tr></thead><tbody>{wtr}</tbody></table>
    <table><thead><tr><th>สาขา</th><th>ชิ้น</th><th>เงิน (฿)</th></tr></thead><tbody>{btr}</tbody></table>
  </div>
  <div class="tools">
    <button class="on" data-f="all">ทั้งหมด ({len(base)})</button>
    <button data-f="dead">🔴 ยังไม่ขยับ ({n_dead})</button>
    <button data-f="move">🟢 ขยับ ({n_move})</button>
    <button data-f="gone">✅ หมดแล้ว ({n_gone})</button>
    <input id="q" placeholder="ค้นหาชื่อ/บาร์โค้ด...">
  </div>
  <div class="tblwrap"><table class="main"><thead><tr>
    <th>#</th><th>สาขา</th><th>บาร์โค้ด</th><th>สินค้า</th>
    <th>สต๊อกวันเริ่ม</th><th>ขายแล้ว</th><th>ได้เงิน (฿)</th><th>เหลือ</th><th>สถานะ</th>
  </tr></thead><tbody id="tb">
{chr(10).join(trs)}
  </tbody></table></div>
  <script>
  var F="all";
  function apply(){{
    var q=document.getElementById("q").value.trim().toLowerCase();
    document.querySelectorAll("#tb tr").forEach(function(tr){{
      var okF=(F==="all"||tr.dataset.s===F);
      var okQ=(!q||tr.textContent.toLowerCase().indexOf(q)>=0);
      tr.style.display=(okF&&okQ)?"":"none";
    }});
  }}
  document.querySelectorAll(".tools button").forEach(function(b){{
    b.onclick=function(){{document.querySelectorAll(".tools button").forEach(function(x){{x.className="";}});
      b.className="on";F=b.dataset.f;apply();}};
  }});
  document.getElementById("q").oninput=apply;
  </script>
</div></body></html>"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(doc)
    print("เขียนไฟล์:", OUT)


if __name__ == "__main__":
    main()
