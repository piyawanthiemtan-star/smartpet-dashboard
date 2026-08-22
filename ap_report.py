# -*- coding: utf-8 -*-
"""ระบบเจ้าหนี้การค้า (AP) — หน้า /accounting-ap สำหรับทีมบัญชี (พิศ)
[Owner สั่งทำ 2026-08-22: "การ์ดใหม่ คือ บัญชี"]

หลักคิด: บิลเจ้าหนี้ = ใบรับของ 1 ใบใน POS (ImportProduct Type 0/1 ที่ระบุซัพ)
- POS มีโมดูล Creditor ในตัวแต่ทีมเลิกใช้ (14 รายการ ธ.ค.68) → ยึดใบรับของแทน
- ML2 ไม่ซื้อตรงจากซัพ (รับของ = โอนจากโกดัง 100%) → ทำเฉพาะ ML3
- ยอดบิล = Σ Qty × Cost (ต้นทุนต่อหน่วยตอนรับ) — พิศกรอกยอดตามใบแจ้งหนี้จริงทับได้ในหน้าเว็บ
- ครบกำหนด = วันรับของ + เครดิตเทอม (vendor_info.csv > Vendor.CreditDay ใน POS > 30 วัน)
- เลขใบแจ้งหนี้ = ช่องอ้างอิง (RefDocumentId) ที่ทีมพิมพ์ตอนรับของ เช่น "IVT2608-00555 08/08/26 เบียร์"
- สถานะจ่าย/ยอดจริง อยู่ Supabase ตาราง ap_bills (หน้าเว็บดึงผ่าน /api/ap) — ไฟล์นี้ไม่รู้เรื่องการจ่าย

รัน: python ap_report.py
env override (GitHub Actions): AP_ML3_DIR, AP_TPL, AP_OUT, AP_VINFO, AP_DAYS
"""
import csv
import datetime
import glob
import json
import os
import re
import sqlite3
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = r"D:\1. SmartPet AI Framework"
BKK = datetime.timezone(datetime.timedelta(hours=7))   # ตรึง +07:00 — GitHub runner เป็น UTC

ML3_DIR = os.environ.get("AP_ML3_DIR", BASE + r"\SmartPetData\Import\OnePoint\Blackup 2026")
TPL = os.environ.get("AP_TPL", os.path.join(HERE, "ap_template.html"))
OUT = os.environ.get("AP_OUT", os.path.join(HERE, "output", "accounting-ap.html"))
VENDOR_INFO = os.environ.get("AP_VINFO", os.path.join(HERE, "vendor_info.csv"))
DAYS = int(os.environ.get("AP_DAYS", "180"))          # ย้อนหลังกี่วัน (บิลเก่ากว่านี้ถือว่าปิดไปแล้ว)
# วันเริ่มติดตามหนี้ในระบบ — บิลก่อนวันนี้ถือว่าจัดการนอกระบบไปแล้ว (แยกกลุ่ม "ก่อนเริ่มระบบ" ไม่นับเป็นค้าง)
# กันวันแรกบิลเก่า 180 วันโผล่เป็น "เกินกำหนด" เป็นร้อยใบ — Owner เปลี่ยนได้ผ่าน env AP_START
AP_START = os.environ.get("AP_START", "2026-08-01")
UNASSIGNED_DAYS = 60                                   # ใบรับของไม่ระบุซัพ — โชว์ให้ตามแก้ย้อนหลังกี่วัน
DEFAULT_CREDIT = 30

BRANCH = "ML3"


def norm_vendor_name(s):
    s = str(s or "").strip().lower()
    for w in ("ห้างหุ้นส่วนจำกัด", "หจก.", "หจก", "บริษัท", "บจก.", "บ.", "(สำนักงานใหญ่)", "สำนักงานใหญ่", "(มหาชน)", "จำกัด"):
        s = s.replace(w, "")
    return re.sub(r"[\s\.]+", "", s)


def load_vendor_info(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            r = {k: (v or "").strip() for k, v in r.items()}
            if r.get("name"):
                rows.append(r)
    return rows


def newest_db(folder):
    """ไฟล์ใหม่สุดในโฟลเดอร์ — ถ้ามีไฟล์ชื่อขึ้นต้น ML3 ให้เลือกเฉพาะกลุ่มนั้น (กันหยิบ ML2 ที่ปนอยู่)"""
    fs = glob.glob(os.path.join(folder, "*.db"))
    ml3 = [f for f in fs if os.path.basename(f).upper().startswith("ML3")]
    fs = ml3 or fs
    return max(fs, key=os.path.getmtime) if fs else None


def th_date(iso):
    """'2026-08-14' -> '14/08/26'"""
    try:
        d = datetime.date.fromisoformat(iso[:10])
        return d.strftime("%d/%m/%y")
    except ValueError:
        return iso


def main():
    db = newest_db(ML3_DIR)
    if not db:
        sys.exit(f"ไม่พบไฟล์ backup ใน {ML3_DIR}")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    print("ใช้ backup:", os.path.basename(db))

    last_import = con.execute(
        "SELECT MAX([Create]) FROM ImportProduct WHERE IsDelete=0 AND Type IN (0,1)").fetchone()[0] or ""
    last_bill = con.execute("SELECT MAX([Create]) FROM Orders WHERE IsDelete=0").fetchone()[0] or ""

    # --- พนักงาน (CreateBy = Employee.Id) ---
    emp = {}
    for eid, fn, ln in con.execute("SELECT Id, FirstName, LastName FROM Employee"):
        nick = re.search(r"\(([^)]+)\)", ln or "")
        emp[str(eid).strip()] = nick.group(1) if nick else f"{fn or ''} {ln or ''}".strip()

    # --- ซัพ: POS Vendor + เติมจาก vendor_info.csv (เลขภาษี = Vendor.Id) ---
    info_rows = load_vendor_info(VENDOR_INFO)
    by_tax = {r["tax_id"]: r for r in info_rows if r.get("tax_id")}
    by_name = {norm_vendor_name(r["name"]): r for r in info_rows}
    vendors = {}
    for vid, name, tel, remarks, credit, paycond in con.execute(
            "SELECT Id, Name, Tel, Remarks, CreditDay, PaymentCondition FROM Vendor WHERE IsDelete=0"):
        vid = str(vid).strip()
        v = {"id": vid, "name": (name or "").strip(), "tel": (tel or "").strip(),
             "credit": None, "pay": "", "bank": "", "account": "", "vcat": "",
             "note": (remarks or "").strip(), "paycond": (paycond or "").strip(), "creditSrc": ""}
        r = by_tax.get(vid) or by_name.get(norm_vendor_name(v["name"]))
        if r:
            m = re.search(r"เครดิต\s*(\d+)", r.get("terms", ""))
            if m:
                v["credit"] = int(m.group(1)); v["creditSrc"] = "บัญชี"
            elif r.get("terms"):
                v["credit"] = 0; v["pay"] = r["terms"]; v["creditSrc"] = "บัญชี"   # เงินสด / คิวอาร์โค้ด
            v["bank"] = r.get("bank", ""); v["account"] = r.get("account", "")
            v["vcat"] = r.get("category", "")
            if not v["tel"]:
                v["tel"] = r.get("tel", "")
        if v["credit"] is None:
            try:
                c = int(str(credit or "").strip())
                v["credit"] = c; v["creditSrc"] = "POS"
            except ValueError:
                v["credit"] = DEFAULT_CREDIT; v["creditSrc"] = "ค่าเริ่มต้น"
        if not v["account"] and v["paycond"]:
            v["pay"] = v["pay"] or v["paycond"]      # POS มี "โอน กสิกร 0371182896" ในช่องเงื่อนไขชำระ
        vendors[vid] = v
    print(f"ซัพพลายเออร์: {len(vendors)} เจ้า (มีข้อมูลบัญชี {sum(1 for v in vendors.values() if v['creditSrc']=='บัญชี')})")

    # --- บิล = ใบรับของจากซัพ (Type 0 รับตรง / 1 รับตาม PO) ย้อนหลัง DAYS วัน ---
    since = (datetime.datetime.now(BKK) - datetime.timedelta(days=DAYS)).strftime("%Y-%m-%d")
    bills = []
    for iid, created, vid, ref, remarks, by, n, amt in con.execute(f"""
        SELECT i.Id, i.[Create], i.VenderId, COALESCE(i.RefDocumentId,''), COALESCE(i.Remarks,''), COALESCE(i.CreateBy,''),
               COUNT(d.Id), COALESCE(SUM(d.Qty*d.Cost),0)
        FROM ImportProduct i
        JOIN ImportProductDetail d ON d.ImportId=i.Id AND d.IsDelete=0
        WHERE i.IsDelete=0 AND i.Type IN (0,1) AND TRIM(COALESCE(i.VenderId,''))<>''
          AND i.[Create] >= '{since}'
        GROUP BY i.Id ORDER BY i.[Create] DESC"""):
        vid = str(vid).strip()
        v = vendors.get(vid)
        if not v:
            continue                                   # ซัพถูกลบไปแล้ว — ข้าม
        date = str(created)[:10]
        due = (datetime.date.fromisoformat(date) + datetime.timedelta(days=v["credit"])).isoformat()
        bills.append({
            "id": f"{BRANCH}-{iid}", "date": date, "time": str(created)[11:16],
            "vid": vid, "vname": v["name"],
            "ref": ref.strip()[:80], "remarks": remarks.strip()[:80],
            "by": emp.get(str(by).strip(), str(by).strip()[-4:]),
            "items": n, "amount": round(amt, 2),
            "credit": v["credit"], "due": due, "pay": v["pay"],
            "old": date < AP_START,      # ก่อนวันเริ่มระบบ — ไม่นับค้าง (ดูได้ในตัวกรอง "ก่อนเริ่มระบบ")
        })
    print(f"บิลเจ้าหนี้ {DAYS} วัน: {len(bills):,} ใบ · รวม ฿{sum(b['amount'] for b in bills):,.0f}"
          f" (ติดตามตั้งแต่ {AP_START}: {sum(1 for b in bills if not b['old']):,} ใบ"
          f" ฿{sum(b['amount'] for b in bills if not b['old']):,.0f})")

    # --- ใบรับของไม่ระบุซัพ (Type 0/1) — เข้าระบบหนี้ไม่ได้ ต้องแก้ใน POS ---
    since_u = (datetime.datetime.now(BKK) - datetime.timedelta(days=UNASSIGNED_DAYS)).strftime("%Y-%m-%d")
    unassigned = []
    for iid, created, ref, remarks, by, n, amt in con.execute(f"""
        SELECT i.Id, i.[Create], COALESCE(i.RefDocumentId,''), COALESCE(i.Remarks,''), COALESCE(i.CreateBy,''),
               COUNT(d.Id), COALESCE(SUM(d.Qty*d.Cost),0)
        FROM ImportProduct i
        JOIN ImportProductDetail d ON d.ImportId=i.Id AND d.IsDelete=0
        WHERE i.IsDelete=0 AND i.Type IN (0,1) AND TRIM(COALESCE(i.VenderId,''))=''
          AND i.[Create] >= '{since_u}'
        GROUP BY i.Id ORDER BY i.[Create] DESC"""):
        if amt <= 0:
            continue
        # สินค้าตัวอย่าง 2 ชื่อแรก ช่วยให้ทีมนึกออกว่าใบไหน
        names = [r[0] for r in con.execute("""
            SELECT COALESCE(p.Name, d.Barcode) FROM ImportProductDetail d LEFT JOIN Product p ON p.Barcode=d.Barcode
            WHERE d.ImportId=? AND d.IsDelete=0 ORDER BY d.Qty*d.Cost DESC LIMIT 2""", (iid,))]
        unassigned.append({
            "id": f"{BRANCH}-{iid}", "date": str(created)[:10], "time": str(created)[11:16],
            "ref": ref.strip()[:80], "remarks": remarks.strip()[:60],
            "by": emp.get(str(by).strip(), str(by).strip()[-4:]),
            "items": n, "amount": round(amt, 2), "sample": " · ".join(names),
        })
    print(f"ใบรับของไม่ระบุซัพ {UNASSIGNED_DAYS} วัน: {len(unassigned):,} ใบ · ฿{sum(u['amount'] for u in unassigned):,.0f}")

    now = datetime.datetime.now(BKK)
    data = {
        "branch": BRANCH,
        "generatedTh": now.strftime("%d/%m/%Y %H:%M"),
        "today": now.strftime("%Y-%m-%d"),
        "lastImportTh": th_date(last_import) + (" " + str(last_import)[11:16] if last_import else ""),
        "lastBillTh": (th_date(last_bill) + " " + str(last_bill)[11:16]) if last_bill else "",
        "days": DAYS, "unassignedDays": UNASSIGNED_DAYS, "start": AP_START,
        "vendors": vendors,
        "bills": bills,
        "unassigned": unassigned,
    }
    tpl = open(TPL, encoding="utf-8").read()
    html = tpl.replace("__DATA__", json.dumps(data, ensure_ascii=False))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print("เขียนไฟล์:", OUT, f"({len(html)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
