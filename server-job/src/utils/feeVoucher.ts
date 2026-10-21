/**
 * 登记缴费 · 公共件（三个部门共用）
 * ============================================================
 * ★ 2026-10-21 用户要求：催费页里 大学 / 就业 要和初高功能对齐 ——
 *   初高的行早就能「上传缴费凭证（登记缴费）」，大学（`t_class_urge_sync`）与
 *   就业（`t_job_fee_call`）原来没有这个能力。三个部门的表单是同一套五项
 *   （缴费方式 / 缴费金额 / 缴费时间 / 备注 / 截图），落盘与校验也应当只有一份实现，
 *   否则「现金可不传截图」「不能晚于今天」「只支持图片、≤5MB」这些规则迟早各写各的。
 *
 * 【为什么不直接 throw BizError】
 *   本仓有两个互不相通的业务码枚举与 BizError 类：
 *   · class-jh 侧 `shared-types/class-jh` 的 BizCode + class-jh/middleware/errorHandler
 *   · class 侧 `shared-types/class` 的 BizCode + class/http/response
 *   公共件若绑定某一侧，另一侧就得 try/catch 翻译一遍，反而更绕。
 *   → 这里**只返回结果**（不抛异常），由各路由用自己的错误类型抛出去。
 *
 * 【凭证怎么存】
 *   前端把图片读成 `data:image/png;base64,xxx` 传上来，后端解码落盘到
 *   `uploads/voucher/`，返回相对地址 `/uploads/voucher/xxx.jpg`。
 *   `<img src>` 带不上 Authorization 头，所以凭证必须走静态托管（app.ts 已挂 /uploads）。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 凭证图片体积上限（5MB，与咨询 / 财务一致） */
export const VOUCHER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 缴费方式码（三部门统一）
 *
 * ⚠️ 初高侧 `shared-types/class-jh` 里本来就有 `PayMethod` / `PAY_METHOD_NAME`；
 *   大学（`shared-types/class`）与就业（实训）**没有**这个枚举，而两者的码位必须一致
 *   （都落 `pay_method` 列：1 微信支付 / 2 支付宝 / 3 现金）。
 *   这里放一份公共定义，供没有枚举的那两处引用，避免各写一组数字。
 */
export const PAY_METHOD = { WECHAT: 1, ALIPAY: 2, CASH: 3 } as const;

export const PAY_METHOD_NAME: Record<number, string> = {
  1: '微信支付',
  2: '支付宝',
  3: '现金',
};

/** 允许的图片类型（dataURL 的 mime 段） */
const ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/** YYYY-MM-DD（本地时区；不用 toISOString，那是 UTC，凌晨 0~8 点会差一天） */
export function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 缴费时间是否合法：不能晚于今天（前端已禁选未来，接口可能被直接调，后端再兜一层）
 *
 * @returns 错误文案；合法时返回 null
 */
export function checkPayDate(payDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) return '缴费时间格式应为 YYYY-MM-DD';
  if (payDate > todayStr()) return '缴费时间不能晚于今天';
  return null;
}

export type VoucherSaveResult =
  | { ok: true; voucherUrl: string; fileName: string }
  | { ok: false; message: string };

/**
 * 把 dataURL 图片落盘到 uploads/voucher/
 *
 * @param dataUrl `data:image/png;base64,xxxx`（前端没选图时传 undefined）
 * @param prefix  文件名前缀，便于在共享目录里区分来源（jh / urge / call）
 */
export function saveVoucherImage(dataUrl: string | undefined, prefix: string): VoucherSaveResult {
  if (!dataUrl) return { ok: false, message: '没有收到缴费截图' };

  const matched = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!matched) return { ok: false, message: '缴费截图只支持 PNG / JPG / WEBP / GIF 图片' };

  const mime = matched[1].toLowerCase();
  if (!ALLOWED_EXT.includes(mime)) return { ok: false, message: '缴费截图只支持 PNG / JPG / WEBP / GIF 图片' };
  const ext = mime === 'jpeg' ? 'jpg' : mime;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(matched[2], 'base64');
  } catch {
    return { ok: false, message: '图片内容解析失败，请重新选择' };
  }
  if (!buffer.length) return { ok: false, message: '图片内容为空，请重新选择' };
  if (buffer.length > VOUCHER_MAX_BYTES) return { ok: false, message: '图片不能超过 5MB，请压缩后重试' };

  const fileName = `${prefix}_fee_${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`;
  try {
    const uploadDir = path.resolve(process.cwd(), 'uploads/voucher');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, fileName), buffer);
  } catch (e) {
    return { ok: false, message: `缴费截图保存失败：${(e as Error).message}` };
  }
  return { ok: true, voucherUrl: `/uploads/voucher/${fileName}`, fileName };
}
