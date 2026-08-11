#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SmartPet · สรุปรายวันสำหรับผู้บริหาร (ทุกสาขา)
- ยอดขาย/บิล/กำไรขั้นต้น รายวัน
- แยกช่องทางชำระ (เงินสด/โอน/เครดิต/คนละครึ่ง/สวัสดิการรัฐ)
- ใบปิดยอดรายกะ: เงินตั้งต้น · เงินสดที่ขายได้ · เงินในลิ้นชัก · **ส่วนต่าง**
ออกเป็นไฟล์เดียว daily.html เลือกวันที่ย้อนหลังได้ในหน้าเว็บ

กติกาที่ต้องรักษาไว้ (พิสูจน์กับยอดปิดกะจริงแล้วตรง 0.00 บาททุกกะ):
  1) ยอดบิล = ราคา*จำนวน - ส่วนลดรายชิ้น  แล้ว **หักส่วนลดท้ายบิล/โปร/คูปอง/แต้ม** อีกชั้น
  2) บิล PaymentType=4 คือ "จ่ายผสมหลายช่องทาง" ต้องแตกยอดตาม OrderPayment ไม่ใช่นับทั้งใบ
"""
import sys, os, json, copy, sqlite3, datetime
sys.stdout.reconfigure(encoding="utf-8")

from generate import BACKUP_DIR, OUT_DIR, BRANCH_NAMES, BKK, th_stamp, backups_by_branch, log

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "daily_template.html")
DAYS = 45                       # เก็บข้อมูลย้อนหลังไว้ในไฟล์ ให้เลือกวันที่ในหน้าเว็บได้

# ช่องทางชำระในตัว POS (เลข >= 10 คือวิธีที่ร้านตั้งเอง อ่านชื่อจากตาราง PaymentMethod)
BUILTIN = {0: "เงินสด", 1: "เครดิต", 2: "เงินโอน", 3: "อื่นๆ (3)"}
MIXED = 4                       # ไม่ใช่ช่องทาง — เป็นบิลที่จ่ายผสม

# ยอดสุทธิต่อบิล (หักส่วนลดครบทุกชั้น)
BILL = """
SELECT o.Id id, o.ShiftWorkId sid, date(o.[Create]) d, COALESCE(o.PaymentType,0) pt,
       COALESCE((SELECT SUM(x.Price*(x.Qty-COALESCE(x.QtyReturn,0))-COALESCE(x.Discount,0))
                 FROM OrdersDetail x WHERE x.OrderId=o.Id AND x.IsDelete=0),0)
       - COALESCE(o.Discount,0) - COALESCE(o.PromotionDiscount,0)
       - COALESCE(o.CouponDiscount,0) - COALESCE(o.DiscountOnpoint,0) net,
       COALESCE((SELECT SUM((x.Qty-COALESCE(x.QtyReturn,0))*COALESCE(p.Cost,0))
                 FROM OrdersDetail x LEFT JOIN Product p ON p.Barcode=x.Barcode AND p.IsDelete=0
                 WHERE x.OrderId=o.Id AND x.IsDelete=0),0) cogs
FROM Orders o
WHERE o.IsDelete=0 AND date(o.[Create]) >= ?
"""


def read_branch(db, since):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    names = dict(BUILTIN)
    for r in con.execute("SELECT Id,Name FROM PaymentMethod WHERE IsDelete=0"):
        names[10 + r["Id"]] = r["Name"]           # POS เก็บวิธีที่ตั้งเองเป็น 10+id

    bills = {r["id"]: dict(r) for r in con.execute(BILL, (since,))}
    # แตกยอดบิลจ่ายผสมตาม OrderPayment
    mixed = [i for i, b in bills.items() if b["pt"] == MIXED]
    splits = {}
    if mixed:
        q = ",".join("?" * len(mixed))
        for r in con.execute(f"""SELECT OrderId, COALESCE(Type,0) t, SUM(Money) m
                                 FROM OrderPayment WHERE IsDelete=0 AND OrderId IN ({q})
                                 GROUP BY OrderId, t""", mixed):
            splits.setdefault(r["OrderId"], []).append((r["t"], r["m"] or 0))

    days = {}
    def slot(d, sid):
        day = days.setdefault(d, {"bills": 0, "rev": 0.0, "gp": 0.0, "ch": {}, "shifts": {}})
        sh = day["shifts"].setdefault(sid or 0, {"bills": 0, "rev": 0.0, "ch": {}})
        return day, sh

    for b in bills.values():
        day, sh = slot(b["d"], b["sid"])
        day["bills"] += 1; sh["bills"] += 1
        day["rev"] += b["net"]; sh["rev"] += b["net"]
        day["gp"] += b["net"] - b["cogs"]
        parts = splits.get(b["id"]) if b["pt"] == MIXED else None
        for t, m in (parts if parts else [(b["pt"], b["net"])]):
            day["ch"][t] = day["ch"].get(t, 0) + m
            sh["ch"][t] = sh["ch"].get(t, 0) + m

    # ข้อมูลปิดกะจาก POS (ตัวเลขเดียวกับที่พิมพ์บนใบปิดยอด)
    for r in con.execute("""SELECT Id,CashierId,Isclose,Open,Close,OpenMoney,CloseMoney,ExpectMoney,SalePrice
                            FROM ShiftWork WHERE IsDelete=0 AND date(Open)>=?""", (since,)):
        d = str(r["Open"])[:10]
        day, sh = slot(d, r["Id"])
        sh.update({
            "id": r["Id"], "cashier": r["CashierId"] or "",
            "open": str(r["Open"])[11:16], "close": str(r["Close"])[11:16] if r["Isclose"] else "",
            "closed": bool(r["Isclose"]),
            "openMoney": round(r["OpenMoney"] or 0), "closeMoney": round(r["CloseMoney"] or 0),
            "expect": round(r["ExpectMoney"] or 0), "sale": round(r["SalePrice"] or 0),
            "diff": round((r["CloseMoney"] or 0) - (r["ExpectMoney"] or 0)) if r["Isclose"] else 0,
        })

    last_bill = con.execute("SELECT MAX([Create]) FROM Orders WHERE IsDelete=0").fetchone()[0]
    top = {}
    con.close()

    out_days = {}
    for d, v in days.items():
        shifts = [s for s in v["shifts"].values() if s.get("id")]
        shifts.sort(key=lambda s: s.get("open", ""))
        out_days[d] = {"bills": v["bills"], "rev": round(v["rev"]), "gp": round(v["gp"]),
                       "ch": {str(k): round(x) for k, x in v["ch"].items() if round(x)},
                       "shifts": [{**s, "rev": round(s["rev"]),
                                   "ch": {str(k): round(x) for k, x in s["ch"].items() if round(x)}}
                                  for s in shifts]}
    dt = None
    if last_bill:
        try: dt = datetime.datetime.fromisoformat(str(last_bill).replace("T", " ")).replace(tzinfo=BKK)
        except ValueError: pass
    return {"days": out_days, "names": {str(k): v for k, v in names.items()},
            "dataAtTh": th_stamp(dt) if dt else "", "dataAt": str(last_bill or "")}


def main():
    now = datetime.datetime.now(BKK)
    today = now.date()
    if os.environ.get("SMARTPET_DAILY_DATE"):
        today = datetime.date.fromisoformat(os.environ["SMARTPET_DAILY_DATE"])
        log("ใช้วันที่ที่ระบุ:", today.isoformat())
    since = (today - datetime.timedelta(days=DAYS)).isoformat()

    found = backups_by_branch()
    out = {"generatedTh": th_stamp(now), "today": today.isoformat(), "branches": {}}
    for br in ("ML3", "ML2"):
        db = found.get(br)
        if not db:
            log(f"[{br}] ไม่มี backup — ข้าม"); continue
        log(f"[{br}] อ่าน:", os.path.basename(db))
        d = read_branch(db, since)
        d["name"] = BRANCH_NAMES.get(br, br)
        out["branches"][br] = d
        t = d["days"].get(today.isoformat())
        bad = [s for s in (t["shifts"] if t else []) if s.get("closed") and s.get("diff")]
        log(f"[{br}] {today}: {t['bills'] if t else 0} บิล · {t['rev'] if t else 0:,} บาท"
            f" · กะ {len(t['shifts']) if t else 0}" + (f" · ⚠️ ลิ้นชักไม่ตรง {len(bad)} กะ" if bad else ""))

    if not out["branches"]:
        sys.exit("ไม่มีข้อมูลสาขาไหนเลย")
    os.makedirs(OUT_DIR, exist_ok=True)
    tpl = open(TEMPLATE, encoding="utf-8").read()
    html = tpl.replace("__DATA__", json.dumps(out, ensure_ascii=False))
    path = os.path.join(OUT_DIR, "daily.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    log("เขียนสรุปรายวัน ->", path, f"({len(html)/1024:.0f} KB)")

    # --- ฉบับบัญชี: ตัดตัวเลขกำไร (gp) ออกจาก "ข้อมูล" เลย ไม่ใช่แค่ซ่อน ---
    #     ทีมบัญชีต้องเห็นเงินเข้า-ออก/ลิ้นชัก แต่ไม่เห็นกำไร (นโยบายเดียวกับที่แยก /executive)
    acct = copy.deepcopy(out)
    for br in acct["branches"].values():
        for d in br["days"].values():
            d.pop("gp", None)
    atpl = tpl.replace('+ (t.rev>0?" · กำไรขั้นต้น "+gp+"%":"")', "")
    atpl = atpl.replace("'<div class=\"meta\">'+sT.bills+\" บิล · กำไรขั้นต้น ฿\"+baht(sT.gp)+\"</div>\"",
                        "'<div class=\"meta\">'+sT.bills+\" บิล</div>\"")
    # หัวเพจ: ฉบับบัญชีไม่ใช่คอนโซลผู้บริหาร + ไม่มีแท็บลิงก์ไป /executive /clearance (บัญชีเปิดไม่ได้อยู่แล้ว)
    atpl = atpl.replace("<h1>คอนโซลผู้บริหาร</h1>", "<h1>ใบปิดยอดรายกะ — บัญชี</h1>")
    atpl = atpl.replace('<div class="cnav"><a href="/executive">👔 ภาพรวมผู้บริหาร</a><span class="on">🧾 ปิดบิลสิ้นวัน</span><a href="/clearance">📉 วัดผลระบาย C</a></div>', "")
    assert atpl != tpl and "กำไรขั้นต้น" not in atpl and "/executive" not in atpl \
        and "/clearance" not in atpl, \
        "template เปลี่ยนไป — patch ฉบับบัญชีไม่ติด ต้องแก้ daily_summary.py"
    ahtml = atpl.replace("__DATA__", json.dumps(acct, ensure_ascii=False))
    assert '"gp"' not in ahtml, "ยังมีข้อมูลกำไรหลุดในฉบับบัญชี"
    apath = os.path.join(OUT_DIR, "daily_accounting.html")
    with open(apath, "w", encoding="utf-8") as f:
        f.write(ahtml)
    log("เขียนฉบับบัญชี (ไม่มีกำไร) ->", apath, f"({len(ahtml)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
