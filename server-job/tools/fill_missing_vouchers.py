# -*- coding: utf-8 -*-
"""
一次性脚本：为数据库里引用了、但磁盘上不存在的缴费凭证补生成示例图。
根因：种子数据 SQL 里写了 /uploads/seed/*.png 等 16 个凭证路径，
      但交付包里只带了 1 张图，其余 15 张缺失 → 前端显示「凭证文件缺失」。
用法：python fill_missing_vouchers.py
幂等：已存在的文件跳过，不会覆盖真实上传的凭证。
"""
import hashlib
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "uploads")

MISSING = [
    "/uploads/voucher/voucher_1791947660587_029c1493.png",
    "/uploads/voucher/voucher_1791472560083_8ba90589.jpg",
    "/uploads/voucher/voucher_1791472313964_c747a021.jpg",
    "/uploads/seed/voucher-ZX26002.png",
    "/uploads/seed/voucher-U26006.png",
    "/uploads/seed/voucher-U26007.png",
    "/uploads/seed/voucher-U26008.png",
    "/uploads/seed/voucher-U26009.png",
    "/uploads/seed/voucher-U26010.png",
    "/uploads/seed/voucher-U26016.png",
    "/uploads/seed/voucher-U26017.png",
    "/uploads/seed/voucher-U26018.png",
    "/uploads/seed/voucher-J26011.png",
    "/uploads/seed/voucher-J26012.png",
]

PAY_METHODS = ["微信支付", "支付宝支付", "银行卡转账"]

GREEN = (7, 193, 96)
TEXT_DARK = (51, 51, 51)
TEXT_GRAY = (153, 153, 153)
BG = (245, 246, 248)
WHITE = (255, 255, 255)


def load_font(size):
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf"):
        p = os.path.join("C:/Windows/Fonts", name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_voucher(path_rel):
    """按文件名生成一张仿「支付成功」凭证图，金额/方式由文件名哈希决定，保证稳定且不雷同。"""
    h = hashlib.md5(path_rel.encode("utf-8")).hexdigest()
    amount = 2000 + int(h[:4], 16) % 28000          # 2000 ~ 29999
    method = PAY_METHODS[int(h[4:6], 16) % len(PAY_METHODS)]
    day = 1 + int(h[6:8], 16) % 28
    hour = 8 + int(h[8:10], 16) % 12
    minute = int(h[10:12], 16) % 60

    W, H = 640, 960
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    f_big = load_font(44)
    f_mid = load_font(30)
    f_small = load_font(22)

    # 顶部状态栏
    d.rectangle([0, 0, W, 60], fill=WHITE)
    d.text((24, 14), "9:41", font=f_mid, fill=TEXT_DARK)

    # 支付成功卡片
    d.rounded_rectangle([40, 110, W - 40, 430], radius=16, fill=WHITE)
    d.ellipse([W // 2 - 40, 140, W // 2 + 40, 220], fill=GREEN)
    d.line([W // 2 - 16, 182, W // 2 - 4, 194], fill=WHITE, width=6)
    d.line([W // 2 - 4, 194, W // 2 + 18, 164], fill=WHITE, width=6)
    d.text((W // 2, 250), "支付成功", font=f_mid, fill=TEXT_DARK, anchor="mm")
    amt = f"¥{amount:,}.00"
    d.text((W // 2, 320), amt, font=f_big, fill=TEXT_DARK, anchor="mm")
    d.text((W // 2, 380), method, font=f_small, fill=TEXT_GRAY, anchor="mm")

    # 明细行
    rows = [
        ("收款方", "良志学管（演示数据）"),
        ("付款时间", f"2026-10-{day:02d} {hour:02d}:{minute:02d}"),
        ("付款方式", method),
        ("订单说明", "学费缴纳"),
    ]
    y = 480
    d.rounded_rectangle([40, y, W - 40, y + 4 * 64 + 20], radius=16, fill=WHITE)
    yy = y + 24
    for k, v in rows:
        d.text((70, yy), k, font=f_small, fill=TEXT_GRAY)
        d.text((W - 70, yy), v, font=f_small, fill=TEXT_DARK, anchor="ra")
        yy += 64

    d.text((W // 2, H - 60), "示例凭证图 · 仅用于演示", font=f_small, fill=TEXT_GRAY, anchor="mm")

    full = os.path.normpath(os.path.join(ROOT, "..", path_rel.lstrip("/")))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    if full.lower().endswith(".jpg") or full.lower().endswith(".jpeg"):
        img.save(full, "JPEG", quality=90)
    else:
        img.save(full, "PNG")
    print("generated:", path_rel)


def main():
    for rel in MISSING:
        full = os.path.normpath(os.path.join(ROOT, "..", rel.lstrip("/")))
        if os.path.exists(full):
            print("skip (exists):", rel)
        else:
            make_voucher(rel)


if __name__ == "__main__":
    main()
