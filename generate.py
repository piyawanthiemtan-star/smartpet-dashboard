#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SmartPet · ML3 Purchase Dashboard generator
Reads the latest POS backup + Master_Multiplier + Approved_NoSubUnit,
computes reorder suggestions (consolidated to base unit, ordered in full ลัง),
and writes a ready-to-open dashboard HTML.

Run daily:  python generate.py
No arguments needed — it auto-picks the newest backup .db.
"""
import sys, os, glob, sqlite3, json, math, datetime, csv, re
sys.stdout.reconfigure(encoding="utf-8")
import openpyxl
from collections import defaultdict

# ---------- CONFIG (แก้ path ที่นี่ หรือ override ผ่าน env สำหรับคลาวด์/GitHub Actions) ----------
# เครื่อง Owner: ไม่ตั้ง env = ใช้ค่าเดิม (Windows) · GitHub runner: ตั้ง env ชี้ path ใน repo (Linux)
BASE       = os.environ.get("SMARTPET_BASE", r"D:\1. SmartPet AI Framework\SmartPetData")
BACKUP_DIR = os.environ.get("SMARTPET_BACKUP_DIR", os.path.join(BASE, r"Import\OnePoint\Blackup 2026"))
MASTER_XLSX= os.environ.get("SMARTPET_MASTER",     os.path.join(BASE, r"Master\OnePoint\Master_Multiplier.xlsx"))
APPROVED   = os.environ.get("SMARTPET_APPROVED",   os.path.join(BASE, r"Master\OnePoint\Approved_NoSubUnit.csv"))
TEMPLATE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "template.html")
OUT_DIR    = os.environ.get("SMARTPET_OUT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "output"))
ML3_SOURCE = "7FEF%"     # warehouse GUID prefix that does the purchasing
REVIEW_DAYS= 30          # monthly ordering cycle
COMPANY    = "บริษัท เลิฟเพ็ท โกลบอลพลัส จำกัด"
BRANCH_NAMES = {"ML3": "โกดังเลยสมาร์ทเพ็ทช็อป", "ML2": "เลยสมาร์ทเพ็ทช็อป"}
# ---------------------------------------------------------------------------

def log(*a): print("·", *a)
def n(x): return str(x).strip() if x is not None else ""

# เวลาไทยแบบ fixed offset (+07:00 ไม่มี DST) — ใช้ offset ตรงๆ จะได้ไม่ต้องพึ่ง tzdata
# สำคัญ: GitHub runner เป็น UTC ถ้าใช้ now() เฉยๆ วันที่/เวลาจะเพี้ยนไป 7 ชม.
BKK = datetime.timezone(datetime.timedelta(hours=7))
TH_MON = ("ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค.")

def th_stamp(dt):
    """29 ก.ค. 2569 15:42น. — วันที่ไทย + เวลา 24 ชม."""
    return f"{dt.day} {TH_MON[dt.month-1]} {dt.year+543} {dt:%H:%M}น."

# แต่ละสาขาโอนของ "ออกจากตัวเอง" ด้วย GUID ของตัวเอง → ใช้ prefix ที่พบมากสุดในช่อง Source
# เป็นตัวบอกว่าไฟล์ backup นี้เป็นของสาขาไหน (ชื่อไฟล์เชื่อไม่ได้ ตั้งกันคนละแบบทุกเครื่อง)
BRANCH_BY_SOURCE = {"7FEF": "ML3", "ECE7": "ML2"}
SOURCE_BY_BRANCH = {v: k for k, v in BRANCH_BY_SOURCE.items()}

def detect_branch(db_path):
    """คืนรหัสสาขาของไฟล์ backup (ML3/ML2) หรือ None ถ้าไม่รู้จัก"""
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        row = con.execute("""SELECT UPPER(SUBSTR(Source,1,4)) p, COUNT(*) c FROM ProductTransfer
                             WHERE IsDelete=0 AND Source IS NOT NULL AND Source<>''
                             GROUP BY p ORDER BY c DESC LIMIT 1""").fetchone()
        con.close()
        return BRANCH_BY_SOURCE.get(row[0]) if row and row[0] else None
    except Exception:
        return None

def backups_by_branch():
    """ไฟล์ backup ใหม่สุดของแต่ละสาขา -> {"ML3": path, "ML2": path}"""
    dbs = glob.glob(os.path.join(BACKUP_DIR, "*.db"))
    if not dbs: sys.exit(f"ไม่พบไฟล์ backup (.db) ใน {BACKUP_DIR}")
    found, skipped = {}, []
    for d in sorted(dbs, key=os.path.getmtime):     # เก่า -> ใหม่ ตัวหลังทับตัวหน้า
        b = detect_branch(d)
        if b: found[b] = d
        else: skipped.append(os.path.basename(d))
    if skipped: log("ข้ามไฟล์ที่ระบุสาขาไม่ได้:", ", ".join(skipped))
    if not found: sys.exit("ไม่พบ backup ที่ระบุสาขาได้เลย")
    return found

def is_ml3(db_path):
    """Identify the ML3 warehouse DB by its data (it ships transfers out from 7FEF),
    not by filename — filenames are inconsistent across branches."""
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        c = con.execute("SELECT COUNT(*) FROM ProductTransfer WHERE Source LIKE ? AND IsDelete=0",
                        (ML3_SOURCE,)).fetchone()[0]
        con.close()
        return c > 100
    except Exception:
        return False

def latest_backup():
    dbs = glob.glob(os.path.join(BACKUP_DIR, "*.db"))
    if not dbs: sys.exit(f"ไม่พบไฟล์ backup (.db) ใน {BACKUP_DIR}")
    ml3 = [d for d in dbs if is_ml3(d)]
    if not ml3:
        sys.exit("ไม่พบ backup ของคลัง ML3 (ไฟล์ที่มีการโอนออกจาก 7FEF) — ตรวจสอบว่าวางไฟล์ ML3 ไว้หรือยัง")
    chosen = max(ml3, key=os.path.getmtime)
    skipped = [os.path.basename(d) for d in dbs if d not in ml3]
    if skipped: log("ข้ามไฟล์ที่ไม่ใช่ ML3:", ", ".join(skipped))
    return chosen

def load_master():
    children = defaultdict(list); msingles=set(); childpacks=set()
    if not os.path.exists(MASTER_XLSX): sys.exit("ไม่พบ Master_Multiplier.xlsx")
    wb = openpyxl.load_workbook(MASTER_XLSX, read_only=True, data_only=True)
    ws = wb["Master"]
    for r in list(ws.iter_rows(values_only=True))[1:]:
        if not r or r[0] is None: continue
        packbc, single, mult = n(r[2]), n(r[4]), r[5]
        try: m = float(mult)
        except (TypeError, ValueError): continue
        children[single].append((packbc, m)); msingles.add(single); childpacks.add(packbc)
    wb.close()
    return children, msingles, childpacks

def load_approved():
    appr=set()
    if os.path.exists(APPROVED):
        for row in csv.DictReader(open(APPROVED, encoding="utf-8-sig")):
            appr.add(n(row.get("barcode")))
    return appr

def compute(db_path, children, msingles, childpacks, approved, branch="ML3"):
    NOW = datetime.datetime.now(BKK)
    TODAY = NOW.date()
    def dcut(d): return (TODAY - datetime.timedelta(days=d)).isoformat()
    c30, c90, c365 = dcut(30), dcut(90), dcut(365)
    # same calendar month, last year (seasonality)
    smly_lo = TODAY.replace(year=TODAY.year-1, day=1).isoformat()
    m2 = (TODAY.replace(year=TODAY.year-1, day=28) + datetime.timedelta(days=4)).replace(day=1)
    smly_hi = m2.isoformat()

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True); con.row_factory = sqlite3.Row
    # เวลาของ "ข้อมูล" จริง = บิลใบล่าสุดใน backup — คนละอย่างกับเวลาที่รันสคริปต์
    # ถ้า agent ไม่ได้ส่งไฟล์ใหม่ขึ้นมา ตัวนี้จะค้าง ทำให้รู้ทันทีว่าข้อมูลเก่า
    last_bill = con.execute("SELECT MAX([Create]) FROM Orders WHERE IsDelete=0").fetchone()[0]
    data_dt = None
    if last_bill:
        try: data_dt = datetime.datetime.fromisoformat(str(last_bill).replace("T", " ")).replace(tzinfo=BKK)
        except ValueError: pass
    units = {r[0]: r[1] for r in con.execute("SELECT Id,Name FROM ProductUnit")}
    cats  = {r[0]: r[1] for r in con.execute("SELECT Id,Name FROM ProductCategory")}
    prod = {r["Barcode"]: {"name": r["Name"], "cat": cats.get(r["Category"], "-"),
            "stock": r["Qty"] or 0, "cost": r["Cost"] or 0, "price": r["RetailPrice"] or 0,
            "unit": units.get(r["Unit"], "?")}
            for r in con.execute("SELECT Barcode,Name,Category,Qty,Cost,RetailPrice,Unit FROM Product WHERE IsDelete=0")}

    def zero(): return {30:0.0, 90:0.0, 365:0.0, "m":0.0}
    sell = defaultdict(zero); trans = defaultdict(zero)
    first = {}   # bc -> earliest movement date seen (to judge if product existed a year ago)
    def seen(bc, dt):
        if bc not in first or dt < first[bc]: first[bc] = dt
    for bc, q, dt in con.execute("""SELECT d.Barcode,(d.Qty-COALESCE(d.QtyReturn,0)),o.[Create]
            FROM OrdersDetail d JOIN Orders o ON d.OrderId=o.Id
            WHERE d.IsDelete=0 AND o.IsDelete=0 AND o.[Create]>=?""", (dcut(400),)):
        if bc not in prod or not dt: continue
        s = sell[bc]; q = q or 0; seen(bc, dt)
        if dt>=c365: s[365]+=q
        if dt>=c90:  s[90]+=q
        if dt>=c30:  s[30]+=q
        if smly_lo<=dt<smly_hi: s["m"]+=q
    # โกดัง (ML3): ของที่โอนออกไปสาขา = ความต้องการจริง ต้องนับรวมเป็นดีมานด์
    # ร้าน (ML2): ของที่โอนออก = ส่งคืนโกดัง ไม่ใช่ดีมานด์ → ไม่นับ ไม่งั้นตัวเลข "ต้องเติม" จะพอง
    if branch == "ML3":
        for bc, q, dt in con.execute("""SELECT i.Barcode,i.TransferQty,t.[Create] FROM ProductTransferItem i
                JOIN ProductTransfer t ON i.TransferId=t.Id
                WHERE i.IsDelete=0 AND t.IsDelete=0 AND t.Source LIKE ? AND t.[Create]>=?""",
                (SOURCE_BY_BRANCH[branch] + "%", dcut(400))):
            if bc not in prod or not dt: continue
            s = trans[bc]; q = q or 0; seen(bc, dt)
            if dt>=c365: s[365]+=q
            if dt>=c90:  s[90]+=q
            if dt>=c30:  s[30]+=q
            if smly_lo<=dt<smly_hi: s["m"]+=q
    # monthly sales trend (13 months) + total stock value for the executive view
    trend = []
    for r in con.execute("""SELECT substr(o.[Create],1,7) m,
            SUM(d.Price*(d.Qty-COALESCE(d.QtyReturn,0))-COALESCE(d.Discount,0)) v
            FROM Orders o JOIN OrdersDetail d ON d.OrderId=o.Id
            WHERE o.IsDelete=0 AND d.IsDelete=0 AND o.Status=1 AND o.[Create]>=?
            GROUP BY m ORDER BY m""", (dcut(400),)):
        trend.append({"m": r[0], "rev": round(r[1] or 0)})
    # per-barcode revenue + qty (last 365d) for margin / GP analysis
    rev365 = {}
    for r in con.execute("""SELECT d.Barcode,
            SUM(d.Price*(d.Qty-COALESCE(d.QtyReturn,0))-COALESCE(d.Discount,0)),
            SUM(d.Qty-COALESCE(d.QtyReturn,0))
            FROM OrdersDetail d JOIN Orders o ON d.OrderId=o.Id
            WHERE d.IsDelete=0 AND o.IsDelete=0 AND o.Status=1 AND o.[Create]>=?
            GROUP BY d.Barcode""", (c365,)):
        rev365[r[0]] = (r[1] or 0, r[2] or 0)
    stock_total = con.execute(
        "SELECT COALESCE(SUM(Qty*Cost),0) FROM Product WHERE IsDelete=0 AND Qty>0").fetchone()[0]
    con.close()

    def mv(bc,k): return sell[bc][k]+trans[bc][k]
    def case_of(single):
        ch = children.get(single, [])
        if not ch: return None
        lang = [(b,m) for b,m in ch if b in prod and "ลัง" in prod[b]["unit"]]
        return max(lang if lang else ch, key=lambda x: x[1])
    def scen(d, lead, stock):
        ss = d*lead*0.5; rop = d*lead+ss; upto = d*(lead+REVIEW_DAYS)+ss
        return round(rop), max(0, math.ceil(upto-stock))

    bases = [bc for bc in prod if bc not in childpacks]
    rev = []
    for bc in bases:
        p = prod[bc]; ch = children.get(bc, [])
        agg = lambda k: mv(bc,k) + sum(mv(cb,k)*m for cb,m in ch)
        o30,o90,o365,om = agg(30),agg(90),agg(365),agg("m")
        stock = p["stock"] + sum(prod[cb]["stock"]*m for cb,m in ch if cb in prod)
        base = 0.5*(o30/30) + 0.3*(o90/90) + 0.2*(o365/365)
        am = o365/12 if o365 else 0
        # seasonality: only trust the year-on-year comparison if the product actually
        # existed before that month last year. New products (0 last year because they
        # weren't stocked yet) must NOT be dragged down — use neutral index 1.0.
        fs = min([first[b] for b in ([bc]+[cb for cb,_ in ch]) if b in first], default=None)
        existed_prior = fs is not None and fs <= smly_lo
        seas = max(0.7, min(1.6, (om/am))) if (am>0 and existed_prior) else 1.0
        rev.append((sell[bc][365]*p["price"], bc))
        p.update(_d=base*seas, _stock=stock, _o365=o365, _seas=round(seas,2), _case=case_of(bc))
    rev.sort(reverse=True); tot = sum(r for r,_ in rev) or 1; cum=0; abc={}
    for r,bc in rev:
        cum += r; abc[bc] = "A" if cum/tot<=0.8 else ("B" if cum/tot<=0.95 else "C")

    items=[]; need7=need14=need30=val7=val14=val30=dead=deadval=over=mapped=0
    gpRev={"A":0.0,"B":0.0,"C":0.0}; gpCogs={"A":0.0,"B":0.0,"C":0.0}; clearance=[]
    for bc in bases:
        p=prod[bc]; d=p["_d"]; stock=p["_stock"]
        # ระยะรอของ 3 ช่วง ตามประเภทซัพพลายเออร์ (5-7 / 7-14 / 14-30 วัน)
        rop7,o7=scen(d,7,stock); rop14,o14=scen(d,14,stock); rop30,o30s=scen(d,30,stock)
        case=p["_case"]; cm=case[1] if case else None; cbc=case[0] if case else None
        cunit=prod[cbc]["unit"] if (cbc and cbc in prod) else None
        ca7=math.ceil(o7/cm) if (cm and o7>0) else None
        ca14=math.ceil(o14/cm) if (cm and o14>0) else None
        ca30=math.ceil(o30s/cm) if (cm and o30s>0) else None
        dleft=(stock/d) if d>0 else None
        is_dead=(p["_o365"]==0 and stock>0 and p["cost"]*stock>=200)
        is_over=(dleft is not None and dleft>120 and p["cost"]*stock>=500)
        nm=(bc not in msingles) and ("*" in str(p["name"])) and (bc not in approved) and (p["_o365"]>0)
        # --- margin / GP by ABC (family-aggregated, actual sale revenue) ---
        cls=abc.get(bc,"C"); _ch=children.get(bc,[]); _fam=[bc]+[cb for cb,_ in _ch]
        gpRev[cls]+=sum(rev365.get(b,(0,0))[0] for b in _fam)
        gpCogs[cls]+=sum(rev365.get(b,(0,0))[1]*prod[b]["cost"] for b in _fam if b in prod)
        # --- clearance engine: overstock-C or dead-stock, promo floor = no-loss (hybrid) ---
        if ((is_over and cls=="C") or is_dead) and p["cost"]>0 and p["price"]>0:
            _cost=p["cost"]; _price=p["price"]
            _floor=_cost if is_dead else _cost*1.05            # dead=breakeven cash-recovery, over=keep 5%
            _promo=math.ceil(_floor)
            if _promo>_price: _promo=round(_price)             # already at/under floor -> cannot discount
            _disc=max(0.0,(_price-_promo)/_price*100)
            _tier="strong" if _disc>=25 else ("mid" if _disc>=10 else "hold")
            clearance.append({"bc":bc,"name":p["name"],"cat":p["cat"],"abc":cls,"unit":p["unit"],
                "stock":round(stock,1),"sold365":round(p["_o365"]),
                "cost":round(_cost,2),"price":round(_price,2),
                "marginNow":round((_price-_cost)/_price*100),
                "floor":round(_floor,2),"promo":_promo,"disc":round(_disc),
                "marginKept":round((_promo-_cost)/_promo*100) if _promo>0 else 0,
                "cashLocked":round(stock*_cost),"recover":round(stock*_promo),
                "tier":_tier,"reason":("dead" if is_dead else "overC")})
        if case: mapped+=1
        if o7>0: need7+=1; val7+=o7*p["cost"]
        if o14>0: need14+=1; val14+=o14*p["cost"]
        if o30s>0: need30+=1; val30+=o30s*p["cost"]
        if is_dead: dead+=1; deadval+=p["cost"]*stock
        if is_over: over+=1
        if o14>0 or is_dead or is_over or p["_o365"]>0:
            st = "critical" if (dleft is not None and dleft<7 and d>0) else \
                 ("warning" if o14>0 else ("dead" if is_dead else ("over" if is_over else "ok")))
            items.append({"bc":bc,"name":p["name"],"cat":p["cat"],"abc":abc.get(bc,"C"),"unit":p["unit"],
                "stock":round(stock,1),"demand":round(d,2),"dleft":round(dleft) if dleft is not None else None,
                "rop7":rop7,"rop14":rop14,"rop30":rop30,"o7":o7,"o14":o14,"o30":o30s,
                "cm":cm,"cunit":cunit,"cbc":cbc,
                "ca7":ca7,"ca14":ca14,"ca30":ca30,"cost":round(p["cost"],2),"seas":p["_seas"],
                "stockval":round(stock*p["cost"]),"status":st,"nm":1 if nm else 0})
    rank={"critical":0,"warning":1,"dead":2,"over":3,"ok":4}
    items.sort(key=lambda x:(rank[x["status"]], -(x["o14"]*x["cost"]), -x["stockval"]))
    unmapped=[{"bc":x["bc"],"name":x["name"],"cat":x["cat"],"unit":x["unit"],
               "stock":round(prod[x["bc"]]["stock"]),"sold":round(sell[x["bc"]][365])}
              for x in items if x["nm"]]
    # margin / GP summary + clearance totals
    def gp(rv,cg): return round((rv-cg)/rv*100,1) if rv>0 else None
    marginABC={k:gp(gpRev[k],gpCogs[k]) for k in ("A","B","C")}
    clr_count=len(clearance); clr_cash=round(sum(x["cashLocked"] for x in clearance))
    clr_recover=round(sum(x["recover"] for x in clearance))
    clr_strong=sum(1 for x in clearance if x["tier"]=="strong")
    clr_hold=sum(1 for x in clearance if x["tier"]=="hold")
    clearance.sort(key=lambda x:-x["cashLocked"]); clearance=clearance[:150]
    S={"generated":TODAY.isoformat(),"generatedAt":NOW.isoformat(timespec="minutes"),
       "generatedTh":th_stamp(NOW),
       "dataAtTh":th_stamp(data_dt) if data_dt else "",
       "dataAgeMin":int((NOW-data_dt).total_seconds()//60) if data_dt else None,
       "skuBase":len(bases),"mapped":mapped,"need7":need7,"need14":need14,"need30":need30,
       "val7":round(val7),"val14":round(val14),"val30":round(val30),
       "abcA":sum(1 for v in abc.values() if v=="A"),"abcB":sum(1 for v in abc.values() if v=="B"),
       "abcC":sum(1 for v in abc.values() if v=="C"),"dead":dead,"deadval":round(deadval),
       "over":over,"unmapped":len(unmapped),"rows":len(items),"stockTotal":round(stock_total),
       "marginAll":gp(sum(gpRev.values()),sum(gpCogs.values())),
       "marginA":marginABC["A"],"marginB":marginABC["B"],"marginC":marginABC["C"],
       "clrCount":clr_count,"clrCash":clr_cash,"clrRecover":clr_recover,
       "clrStrong":clr_strong,"clrHold":clr_hold,
       "branch":branch,"branchName":BRANCH_NAMES.get(branch,branch)}
    return {"s":S,"items":items,"unmapped":unmapped,"trend":trend,"clearance":clearance}

def main():
    found = backups_by_branch()
    children, msingles, childpacks = load_master()
    approved = load_approved()
    log(f"master singles: {len(msingles)} | approved no-sub-unit: {len(approved)}")
    os.makedirs(OUT_DIR, exist_ok=True)
    tpl = open(TEMPLATE, encoding="utf-8").read()

    # สาขาไหนไม่มีไฟล์ก็ข้ามไป — ไม่ให้สาขาเดียวพังทำให้ทั้งระบบล้ม
    failed, done = [], []
    for branch in ("ML3", "ML2"):
        db = found.get(branch)
        if not db:
            log(f"[{branch}] ไม่มี backup — ข้าม")
            continue
        log(f"[{branch}] ใช้ backup:", os.path.basename(db))
        try:
            data = compute(db, children, msingles, childpacks, approved, branch=branch)
        except Exception as e:
            # สาขาหนึ่งพังต้องไม่ทำให้ทั้ง build ล้ม ไม่งั้นอีกสาขาที่ปกติจะไม่ได้อัปเดตไปด้วย
            log(f"[{branch}] ❌ ประมวลผลไม่สำเร็จ ข้ามสาขานี้: {type(e).__name__}: {e}")
            failed.append(branch)
            continue
        log(f"[{branch}] สรุป:", json.dumps(data["s"], ensure_ascii=False))
        html = tpl.replace("__DATA__", json.dumps(data, ensure_ascii=False))
        names = [f"dashboard_{branch}.html"]
        if branch == "ML3":     # ชื่อเดิม — ของเก่า (daily_run STEP 6) ยังใช้ได้เหมือนเดิม
            names += [f"dashboard_{data['s']['generated']}.html", "dashboard_latest.html"]
        for name in names:
            with open(os.path.join(OUT_DIR, name), "w", encoding="utf-8") as f:
                f.write(html)
        log(f"[{branch}] เขียนแดชบอร์ด ->", os.path.join(OUT_DIR, names[0]))
        done.append(branch)

    if not done:
        sys.exit("สร้างแดชบอร์ดไม่สำเร็จสักสาขา")          # ให้ workflow ฟ้องแดง จะได้รู้ตัว
    if failed:
        log("⚠️ สาขาที่ข้ามไป:", ", ".join(failed))
    log("เสร็จ:", ", ".join(done))

if __name__ == "__main__":
    main()
