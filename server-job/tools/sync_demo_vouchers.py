# -*- coding: utf-8 -*-
"""
演示数据缴费凭证同步 —— 让凭证截图上的金额 / 时间与库里的缴费单完全一致。

【为什么需要这个脚本】
交付包里 `/uploads/seed/*.png` 那批演示凭证图，是早期脚本按「文件名哈希」随机生成的：
金额 2000~29999 随机、日期 10-01~10-28 随机。所以界面上会出现
    单据：¥12800.00  创建时间 2026-10-08 20:04:12
    凭证：¥16,081.00 付款时间 2026-10-02 16:59
两边对不上的情况（用户 2026-10-16 反馈）。

本脚本改为「以数据库为准」重画凭证图：
    金额     = 该凭证对应的缴费单金额；同一张 voucher_url 被同批多张单共用时取【合计】
    付款时间 = 单据 create_time（与列表「创建时间」一致）
    付款方式 = 单据 pay_method（wechat/微信支付/支付宝支付/现金…）
    订单号   = 单据 order_no
    订单说明 = 学生姓名 · 费用项

【安全约定 —— 不会误伤真实上传】
multer 上传的真实凭证落在 `/uploads/voucher/` 下，脚本默认【不动】它们；
只处理两类「演示/测试图」：
  1) `/uploads/seed/` 目录下的（该目录按约定就是演示图专用）
  2) DEMO_EXTRA 清单里列出的历史测试图（都是本地联调时造的假图，见下方注释）
需要全量重画时用 `--all`（会把真实上传也一起重画，务必确认后再用）。

【用法】
    python sync_demo_vouchers.py --check     # 只体检：列出被引用的凭证与差额，不写文件
    python sync_demo_vouchers.py             # 重画演示/测试凭证（默认，安全）
    python sync_demo_vouchers.py --all       # 重画全部被引用的凭证（含真实上传，慎用）

    # 依赖：pymysql + Pillow；本机用托管 venv：
    # C:/Users/HP/.workbuddy/binaries/python/envs/default/Scripts/python.exe sync_demo_vouchers.py

【幂等】反复执行结果一致；凭证图不参与业务，重画不影响任何单据数据。
"""
import argparse
import json
import os
import sys
from collections import OrderedDict
from datetime import datetime

import pymysql
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
SERVER_JOB = os.path.dirname(ROOT)                      # server-job/
UPLOAD_ROOT = os.path.join(SERVER_JOB, "uploads")       # server-job/uploads

# ---------------------------------------------------------------- 身份常量
PAYER = "良志学管（演示数据）"
W, H = 640, 960

GREEN = (7, 193, 96)
TEXT_DARK = (34, 38, 45)
TEXT_GRAY = (150, 155, 163)
LINE = (240, 242, 245)
BG = (245, 246, 248)
WHITE = (255, 255, 255)

# 费用类型（与 shared-types FeeType 对齐）
FEE_TYPE_NAME = {
    1: "学费",
    2: "住宿费",
    3: "餐费",
    4: "保险费",
    5: "试学费",
    6: "押金",
    7: "校服",
}

# 支付方式：库里的英文码 → 凭证上展示的中文
PAY_METHOD_NAME = {
    "wechat": "微信支付",
    "wechatpay": "微信支付",
    "wx": "微信支付",
    "alipay": "支付宝支付",
    "ali": "支付宝支付",
    "bank": "银行卡转账",
    "transfer": "银行卡转账",
    "card": "银行卡转账",
    "cash": "现金",
    "other": "其他",
    # 库里也有直接存中文的（且不统一），这里做一次归一
    "支付宝缴费": "支付宝支付",
    "支付宝": "支付宝支付",
    "微信": "微信支付",
    "银行卡": "银行卡转账",
    "转账": "银行卡转账",
}

# ★ 历史联调造的假图（图内容与业务无关：1×1 占位图 / 随手传的 IDE 截图 / 早期哈希生成的图）
#   这些路径都在 /uploads/voucher/ 下，但都不是真实缴费截图。等有真实上传后请把名字删掉。
DEMO_EXTRA = {
    "/uploads/voucher/voucher_1792037641393_b0ef1d08.png",
    "/uploads/voucher/voucher_1791947660587_029c1493.png",
    "/uploads/voucher/voucher_1791472560083_8ba90589.jpg",
    "/uploads/voucher/voucher_1791472313964_c747a021.jpg",
    "/uploads/voucher/voucher_1792069283656_7755098c.png",
}


# ---------------------------------------------------------------- 环境/DB
def read_env():
    """.env 极简解析（够用即可，避免引入 dotenv 依赖）"""
    env = {}
    p = os.path.join(SERVER_JOB, ".env")
    if not os.path.exists(p):
        return env
    with open(p, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def connect():
    env = read_env()
    return pymysql.connect(
        host=env.get("DB_HOST", "localhost"),
        port=int(env.get("DB_PORT", 3306)),
        user=env.get("DB_USER", "root"),
        password=env.get("DB_PASSWORD", ""),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )


SQL = """
SELECT 'consult' AS src, voucher_url, amount, create_time, IFNULL(pay_method,'') AS pm,
       IFNULL(student_name,'') AS sn, IFNULL(order_no,'') AS ono, fee_type,
       IFNULL(item_detail,'') AS detail
  FROM sms_consult.t_consult_fee_order
 WHERE is_deleted = 0 AND voucher_url IS NOT NULL AND voucher_url <> ''
UNION ALL
SELECT 'finance' AS src, voucher_url, amount, create_time, '' AS pm,
       IFNULL(student_name,'') AS sn, '' AS ono, fee_type, '' AS detail
  FROM sms_finance.t_finance_fee
 WHERE is_deleted = 0 AND voucher_url IS NOT NULL AND voucher_url <> ''
"""


def row_type_names(row):
    """一张单据包含的费用项名。
    合并单（一次发起勾多项 → 只建 1 张单）的费用项在 item_detail JSON 里，要解出来；
    老数据一项一单时 item_detail 为空，退回按 fee_type 取名。
    """
    names = []
    detail = row.get("detail")
    if detail:
        try:
            for it in json.loads(detail):
                nm = it.get("feeTypeName") or FEE_TYPE_NAME.get(it.get("feeType"))
                if nm and nm not in names:
                    names.append(nm)
        except Exception:
            pass
    if not names:
        nm = FEE_TYPE_NAME.get(row["fee_type"])
        if nm:
            names.append(nm)
    return names


def fetch_groups():
    """按 voucher_url 聚合：金额合计 / 付款时间 / 支付方式 / 订单号 / 费用项

    ⚠️ 两个坑，都踩过：
    ① 咨询库和财务库对【同一笔缴费】各存一条记录（voucher_url 相同、金额相同），
       直接 UNION 求和会翻倍（¥32,400 变 ¥64,800）。所以先按来源分桶，
       咨询侧有记录就只认咨询侧（它有 order_no / pay_method，信息更全），
       只有财务侧引用（如分期的逐期凭证）时才用财务侧。
    ② 代表单据口径必须和列表页一致（student.route.ts 详情合并逻辑）：
       优先「学费单」，其次单号最小的那张 —— 否则凭证上写「SK...-004 等 6 笔」，
       列表写「SK...-001 等 6 单」，同一笔钱对不上号。
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(SQL)
        rows = cur.fetchall()

    buckets = OrderedDict()      # url -> {"consult": [row...], "finance": [row...]}
    for r in rows:
        buckets.setdefault(r["voucher_url"], {"consult": [], "finance": []})[r["src"]].append(r)

    groups = OrderedDict()
    for url, b in buckets.items():
        rows = b["consult"] or b["finance"]
        g = groups[url] = {
            "url": url,
            "amount": 0,
            "time": None,
            "pm": "",
            "student": "",
            "orderNo": "",
            "orderText": "",
            "types": [],
            "rows": 0,
        }

        # 代表单据（与后端一致：学费优先，其次单号最小）
        ordered = sorted(rows, key=lambda r: str(r["ono"] or "~"))
        rep = next((r for r in ordered if r["fee_type"] == 1), ordered[0]) if ordered else None

        # 费用项：代表单据的排在最前（列表页也把学费放在「学费 等 N 项」的首位）
        for r in ([rep] if rep else []) + [x for x in ordered if x is not rep]:
            for nm in row_type_names(r):
                if nm not in g["types"]:
                    g["types"].append(nm)

        for r in rows:
            g["amount"] += int(r["amount"] or 0)
            g["rows"] += 1
            if not g["pm"] and r["pm"]:
                g["pm"] = r["pm"]
            if not g["student"] and r["sn"]:
                g["student"] = r["sn"]

        # 付款时间：优先代表单据的创建时间（= 列表「创建时间」），兜底取最早
        if rep and rep["create_time"]:
            t = rep["create_time"]
        else:
            t = min((r["create_time"] for r in rows if r["create_time"]), default=None)
        if isinstance(t, str):
            t = datetime.strptime(t[:19], "%Y-%m-%d %H:%M:%S")
        g["time"] = t

        # 订单号：与列表展示口径一致（多单 → 「首单 等 N 单」）
        if rep and rep["ono"]:
            g["orderNo"] = rep["ono"]
            g["orderText"] = rep["ono"] if len(rows) == 1 else "%s 等 %d 单" % (rep["ono"], len(rows))
        else:
            # 财务侧逐期凭证没有单号，用「分期第 N 期」之类不好判断，就留空
            g["orderText"] = ""
    return groups


# ---------------------------------------------------------------- 绘图
def load_font(size, bold=False):
    names = ("msyhbd.ttc", "msyh.ttc", "simhei.ttf") if bold else ("msyh.ttc", "msyhbd.ttc", "simhei.ttf")
    for n in names:
        p = os.path.join("C:/Windows/Fonts", n)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def pay_method_text(raw):
    if not raw:
        return "微信支付"          # 老数据没记支付方式，给个常见的兜底，避免出现空行
    return PAY_METHOD_NAME.get(raw.strip().lower(), raw.strip())


def yuan(cents):
    return "¥{:,.2f}".format((cents or 0) / 100.0)


def fulfill_desc(g):
    parts = []
    if g["student"]:
        parts.append(g["student"])
    types = g["types"]
    if len(types) > 3:
        parts.append("、".join(types[:3]) + "等%d项" % len(types))
    elif types:
        parts.append("、".join(types))
    else:
        parts.append("学费缴纳")
    text = " · ".join(parts)
    return text if len(text) <= 16 else text[:15] + "…"


def order_text(g):
    return g.get("orderText") or ""


def draw_voucher(g, out_path):
    amount = yuan(g["amount"])
    pay_dt = g["time"] or datetime.now()
    pay_time = pay_dt.strftime("%Y-%m-%d %H:%M:%S")   # 与列表「创建时间」精确到秒对齐
    method = pay_method_text(g["pm"])

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    f_huge = load_font(46, bold=True)
    f_big = load_font(34, bold=True)
    f_mid = load_font(28)
    f_small = load_font(22)
    f_tiny = load_font(19)

    # 顶部状态栏（时间跟付款时间一致，避免「上面 9:41 / 下面 20:04」这种自相矛盾）
    d.rectangle([0, 0, W, 60], fill=WHITE)
    d.text((24, 15), pay_dt.strftime("%H:%M"), font=f_mid, fill=TEXT_DARK)
    d.text((W - 24, 15), "支付成功", font=f_tiny, fill=TEXT_GRAY, anchor="ra")

    # 支付成功卡片
    d.rounded_rectangle([40, 104, W - 40, 424], radius=18, fill=WHITE)
    cx = W // 2
    d.ellipse([cx - 40, 134, cx + 40, 214], fill=GREEN)
    d.line([cx - 17, 176, cx - 5, 188], fill=WHITE, width=7)
    d.line([cx - 5, 188, cx + 18, 158], fill=WHITE, width=7)
    d.text((cx, 246), "支付成功", font=f_mid, fill=TEXT_DARK, anchor="mm")
    d.text((cx, 316), amount, font=f_huge, fill=TEXT_DARK, anchor="mm")
    d.text((cx, 380), method, font=f_small, fill=TEXT_GRAY, anchor="mm")

    # 明细卡片
    order_no = order_text(g)
    rows = [("收款方", PAYER), ("付款时间", pay_time), ("付款方式", method)]
    if order_no:
        rows.append(("订单号", order_no))
    rows.append(("订单说明", fulfill_desc(g)))

    top = 470
    row_h = 62
    d.rounded_rectangle([40, top, W - 40, top + row_h * len(rows) + 8], radius=18, fill=WHITE)
    y = top + 24
    for i, (k, v) in enumerate(rows):
        if i:
            d.line([70, y - 12, W - 70, y - 12], fill=LINE, width=1)
        d.text((70, y), k, font=f_small, fill=TEXT_GRAY)
        d.text((W - 70, y), v, font=f_small, fill=TEXT_DARK, anchor="ra")
        y += row_h

    d.text((W // 2, H - 62), "示例凭证图 · 仅用于演示", font=f_tiny, fill=TEXT_GRAY, anchor="mm")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if out_path.lower().endswith((".jpg", ".jpeg")):
        img.save(out_path, "JPEG", quality=92)
    else:
        img.save(out_path, "PNG")


# ---------------------------------------------------------------- 主流程
def to_fs_path(url):
    """'/uploads/seed/x.png' → '<server-job>/uploads/seed/x.png'；非 /uploads 前缀返回 None"""
    if not url.startswith("/uploads/"):
        return None
    return os.path.normpath(os.path.join(SERVER_JOB, url.lstrip("/").replace("/", os.sep)))


def is_demo(url, all_mode):
    if all_mode:
        return True
    return url.startswith("/uploads/seed/") or url in DEMO_EXTRA


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只体检，不写文件")
    ap.add_argument("--all", action="store_true", help="重画全部（含真实上传）")
    args = ap.parse_args()

    groups = fetch_groups()
    print("被引用的凭证 %d 张（涉及缴费单行 %d 条）" % (len(groups), sum(g["rows"] for g in groups.values())))
    print("-" * 96)

    demo_n, real_n, bad_n, new_n = 0, 0, 0, 0
    for url, g in groups.items():
        fs = to_fs_path(url)
        demo = is_demo(url, args.all)
        tag = "演示" if demo else "真实"
        exists = bool(fs and os.path.exists(fs))
        # 真实上传按约定不动（它本来就是用户自己传的真实截图）
        if demo and fs:
            demo_n += 1
            if not exists:
                new_n += 1
            if args.check:
                print("[体检] %-6s %s  金额 %s  时间 %s  方式 %s  单号 %s"
                      % (tag, url, yuan(g["amount"]),
                         g["time"].strftime("%Y-%m-%d %H:%M:%S") if g["time"] else "—",
                         pay_method_text(g["pm"]), g.get("orderText") or "—"))
            else:
                draw_voucher(g, fs)
                print("重画 %s  金额 %s  时间 %s  %s"
                      % (url, yuan(g["amount"]),
                         g["time"].strftime("%Y-%m-%d %H:%M") if g["time"] else "—",
                         "（新建）" if not exists else ""))
        elif fs:
            real_n += 1
            print("跳过 %-6s %s（脚本不覆盖用户真实上传）" % (tag, url))
        else:
            bad_n += 1
            print("忽略 %s（不是 /uploads 下的相对路径）" % url)

    print("-" * 96)
    if args.check:
        print("体检完成：演示/测试凭证 %d 张（其中 %d 张缺文件需生成），真实上传 %d 张，异常路径 %d 张"
              % (demo_n, new_n, real_n, bad_n))
    else:
        print("完成：重画 %d 张（新建 %d），跳过（真实上传） %d 张，异常路径 %d 张"
              % (demo_n, new_n, real_n, bad_n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
