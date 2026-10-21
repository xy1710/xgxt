/**
 * 缴费截图识别（OCR）
 *
 * 用途：教务在「即将到期」页点「上传 / 重新上传」后，先传一张缴费截图，
 *       系统自动识别截图上的「缴费金额」和「订单号」并回填到弹窗里。
 *
 * 选型：tesseract.js（纯 JS，不需要装系统级的 tesseract 二进制）
 *   - 语言包 eng：金额和订单号都是数字/字母，用英文包足够，体积也小（10MB）
 *   - 语言包放在 server-edu/tessdata/ 下，启动时从本地加载，不走网络
 *   - worker 做成单例：每次识别都新建 worker 要重新加载 wasm + 语言包，要好几秒
 *
 * 识别流程：
 *   1. 小图先放大（宽度 < 900 时 ×2 并转灰度），大图保持原样
 *      —— 实测：本来就很清楚的图再放大反而会更糊，所以只在图小时才放大
 *   2. 第一遍：整页识别（PSM 3），拿到全文
 *   3. 金额或订单号没识别出来时，补一遍「只认数字」（PSM 11 + 数字白名单）
 *   4. 从文本里抽取金额 / 订单号
 */

import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { OcrResult } from 'shared-types/edu';

/** 语言包目录：src/services → ../../tessdata（编译到 dist/services 后同样指向根目录） */
const TESSDATA_DIR = path.resolve(__dirname, '../../tessdata');

/** tesseract.js 默认的语言包 CDN（本地缺包时兜底用） */
const TESSDATA_CDN = 'https://tessdata.projectnaptha.com/4.0.0';

/**
 * 本地语言包是否就绪
 *
 * ⚠️ 为什么需要这个判断（2026-10-15 修复）
 *   `.gitignore` 里有 `/server-job/tessdata/*.traineddata.gz`（eng 11MB + chi_sim 20MB，
 *   嫌大不入库），所以**新 clone 出来的仓库天生没有语言包** ——
 *   OCR 必然失败，教务「上传缴费截图」第一步就断了
 *   （用户反馈的「教务上传不了截图」正包含这一环）。
 *
 *   本地有包 → 走本地（离线、快）；本地没包 → 退回 CDN，让新同事能直接跑通。
 */
function hasLocalTessdata(): boolean {
  try {
    return fs.existsSync(path.join(TESSDATA_DIR, 'eng.traineddata.gz'));
  } catch {
    return false;
  }
}

let workerPromise: Promise<Worker> | null = null;

/**
 * 串行队列
 * ⚠️ worker 是单例，两个请求同时进来会互相覆盖 setParameters，
 *    所以所有识别任务排队串行执行。
 */
let queue: Promise<unknown> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const useLocal = hasLocalTessdata();
      if (!useLocal) {
        console.warn(
          `[ocr] 本地语言包缺失（${TESSDATA_DIR}），本次改用在线语言包 ${TESSDATA_CDN}，` +
            '首次识别会慢一些。想要离线可用，请把 eng.traineddata.gz 放到 server-job/tessdata/ 下。',
        );
      }
      const worker = await createWorker('eng', 1, {
        // 本地有包走本地（离线、快）；没有就交给 tesseract.js 用它自己的 CDN 默认值
        ...(useLocal ? { langPath: TESSDATA_DIR, gzip: true } : {}),
        // ⚠️ 必须挂 errorHandler：识别不了的图片会让 wasm 直接 Aborted(-1)，
        //    没有兜底的话这个错误会以 unhandled 形式把整个 node 进程打挂
        errorHandler: (err: any) => {
          console.error('[ocr] worker error:', err?.message || err);
        },
      });
      return worker;
    })().catch((err) => {
      // 建 worker 失败就清掉缓存，下次请求可以重试
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/** worker 挂了就整个丢掉重建，避免后面所有识别都失败 */
async function dropWorker(): Promise<void> {
  try {
    const w = await workerPromise;
    if (w) await w.terminate();
  } catch {
    /* 终止失败就算了 */
  }
  workerPromise = null;
}

/**
 * 预处理：先确认这张图能解析，再决定要不要放大
 *
 * ⚠️ 关键：解析不了的图（空文件 / 截断的 png）绝不能丢给 tesseract ——
 *    实测会 Aborted(-1) 把进程打挂。这里一律用 sharp 先解析一遍，
 *    解析不了直接抛错，由调用方转成「识别失败」。
 */
async function prepare(buffer: Buffer): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 0;
  if (width <= 0) throw new Error('无法解析图片尺寸');

  // 小图放大 + 灰度；大图原样返回（实测放大清楚的大图反而降低准确率）
  if (width < 900) {
    return await sharp(buffer)
      .resize({ width: width * 2, kernel: 'lanczos3' })
      .grayscale()
      .png()
      .toBuffer();
  }
  return buffer;
}

/** 给识别加个超时，避免 worker 卡死时请求永远挂着 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`识别超时（${ms}ms）`)), ms),
    ),
  ]);
}

/* ============================================================
 * 文本 → 金额 / 订单号
 * ============================================================ */

/** OCR 出来的文本先做一次字符归一化（全角符号、多余空格） */
function normalize(raw: string): string {
  return raw
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .replace(/[。．]/g, '.')
    .replace(/￥/g, '¥')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 金额关键字：命中这些字的行，优先从这行取数 */
const AMOUNT_KEYWORDS =
  /(缴费金额|付款金额|支付金额|订单金额|交易金额|实付金额|实付|应付|应缴|合计|总计|总额|金额|amount|total|paid)/i;

/** 订单号关键字 */
const ORDER_KEYWORDS =
  /(订单号|订单编号|交易号|交易单号|交易流水号|流水号|商户单号|商户订单号|支付单号|单号|订单|order\s*(no|number|id)?|transaction\s*(no|id)?|trade\s*(no|id)?|payment\s*id)/i;

function toNumber(s: string): number | undefined {
  const v = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(v * 100) / 100;
}

/**
 * 从一行里挑出最像金额的数字
 *
 * 先把日期（2026-10-02）、时间（13:40）、超长数字串（多半是订单号）抹掉，
 * 再在剩下的数字里优先取「带小数点的最大那个」。
 */
function pickAmountInLine(line: string): number | undefined {
  const cleaned = line
    .replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' ')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')
    .replace(/\d{10,}/g, ' ');

  const matches = cleaned.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g) || [];
  const withDecimal = matches.filter((m) => m.includes('.'));
  const pool = withDecimal.length > 0 ? withDecimal : matches;

  let best: number | undefined;
  for (const m of pool) {
    const v = toNumber(m);
    if (v == null) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

function extractAmount(text: string): number | undefined {
  const norm = normalize(text);
  const lines = norm.split('\n').filter((l) => l.trim());

  // 1) 带「金额」关键字的行
  for (const line of lines) {
    if (!AMOUNT_KEYWORDS.test(line)) continue;
    const v = pickAmountInLine(line);
    if (v != null) return v;
  }

  // 2) 带货币符号的行（¥5800.00 / $1,200.00）
  for (const line of lines) {
    if (!/[¥￥$]/.test(line)) continue;
    const v = pickAmountInLine(line);
    if (v != null) return v;
  }

  // 3) 兜底：全文里带两位小数的最大数（不取整数，避免把年份、时间当金额）
  const decimals = norm.match(/\d[\d,]*\.\d{2}/g) || [];
  let best: number | undefined;
  for (const m of decimals) {
    const v = toNumber(m);
    if (v == null) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

/**
 * 清洗订单号候选串
 *
 * OCR 经常把数字前面的符号认成字母（例如 Z20261002…、SB2026…），
 * 所以允许剥掉最多 3 个前缀字母，只保留后面的数字主体。
 */
function cleanOrderToken(t: string): string | undefined {
  const s = t.replace(/\s+/g, '').toUpperCase();
  const withPrefix = s.match(/^[A-Z]{0,3}(\d{8,})$/);
  if (withPrefix) return withPrefix[1];
  if (/^\d{8,}$/.test(s)) return s;
  if (/^[A-Z0-9]{10,}$/.test(s)) return s;
  return undefined;
}

function extractOrderNo(text: string): string | undefined {
  const norm = normalize(text);
  const lines = norm.split('\n').filter((l) => l.trim());

  // 1) 带「订单号 / 交易号」等关键字的行
  for (const line of lines) {
    if (!ORDER_KEYWORDS.test(line)) continue;
    const after = line.replace(ORDER_KEYWORDS, ' ').replace(/[:：]/g, ' ');
    const tokens = after.match(/[A-Za-z0-9][A-Za-z0-9 ]{7,}/g) || [];
    const cands = tokens
      .map((t) => cleanOrderToken(t))
      .filter((v): v is string => typeof v === 'string' && v.length >= 8);
    if (cands.length > 0) return cands.sort((a, b) => b.length - a.length)[0];
  }

  // 2) 全文里最长的数字串（≥10 位）
  const digits = (norm.match(/\d{10,}/g) || [])
    .map((t) => cleanOrderToken(t))
    .filter((v): v is string => Boolean(v));
  if (digits.length > 0) return digits.sort((a, b) => b.length - a.length)[0];

  // 3) 再退一步：长的字母数字混合串
  const mixed = (norm.match(/[A-Za-z0-9]{12,}/g) || [])
    .map((t) => cleanOrderToken(t))
    .filter((v): v is string => Boolean(v));
  return mixed.sort((a, b) => b.length - a.length)[0];
}

/* ============================================================
 * 对外入口
 * ============================================================ */

/**
 * 识别缴费截图
 *
 * @returns amount / orderNo 都可能为空（识别不到就是空，前端只读展示，不给手填）
 */
export async function recognizePaymentScreenshot(buffer: Buffer): Promise<OcrResult> {
  const run = async (): Promise<OcrResult> => {
    // 1) 先确认图片能解析 —— 解析不了直接按「识别失败」处理，绝不丢给 tesseract
    let image: Buffer;
    try {
      image = await prepare(buffer);
    } catch (e: any) {
      return { recognized: false, rawText: `图片无法解析：${e?.message || e}` };
    }

    const worker = await getWorker();

    // 第一遍：整页识别
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      tessedit_char_whitelist: '',
    });
    const first = await withTimeout(worker.recognize(image), 60000);
    let text = first?.data?.text || '';
    let amount = extractAmount(text);
    let orderNo = extractOrderNo(text);

    // 有一项没认出来 → 补一遍「只认数字」，长数字串的准确率会高不少
    if (amount == null || orderNo == null) {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        tessedit_char_whitelist: '0123456789.,',
      });
      const second = await withTimeout(worker.recognize(image), 60000);
      const text2 = second?.data?.text || '';
      if (amount == null) amount = extractAmount(text2);
      if (orderNo == null) orderNo = extractOrderNo(text2);
      text = `${text}\n${text2}`;

      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        tessedit_char_whitelist: '',
      });
    }

    return {
      // ⚠️ 规范：金额统一「整数、单位分」。截图上认出来的自然是「元」，
      //    所以在这里 ×100 转换，保证从 OCR 到落库全链路都是分。
      amount: amount == null ? undefined : Math.round(amount * 100),
      orderNo: orderNo || undefined,
      // 原始文本只用于排查识别问题，页面上不展示，截断避免传输过大
      rawText: text.replace(/\n{2,}/g, '\n').trim().slice(0, 2000),
      recognized: amount != null || orderNo != null,
    };
  };

  // 串行执行：不管上一个任务成功失败，都要继续跑下一个
  const result = queue.then(run, run);
  queue = result.catch(async (e) => {
    // 识别过程抛错（worker 崩了 / 超时）→ 丢掉 worker 重建，下次请求还能用
    console.error('[ocr] recognize failed:', e?.message || e);
    await dropWorker();
    return undefined;
  });
  return result.catch(() => ({ recognized: false as const, rawText: '识别失败' }));
}
