import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { ACTIVITY_INJECT_SCRIPT } from './activity-inject.js';
import { writeSessionMeta } from '../output/writer.js';
import { ensureFfmpeg, transcodeVideoToMp4 } from '../lib/ffmpeg.js';

export interface RecordOptions {
  targetUrl: string;
  outDir: string;
  recordingDir: string;
  screensDir: string;
  maxDurationMin: number;
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  onOpened?: (page: Page) => void | Promise<void>;
}

export interface RecordResult {
  videoPath: string;
  screenshotCount: number;
  durationSec: number;
  /** 实际生效的视口(请求的视口超出屏幕可容纳区域时会被钳制) */
  viewport: { width: number; height: number };
  /** 实际生效的设备像素比(对齐显示器真实缩放,消除 1.0↔真实 DSF 的合成器翻转) */
  deviceScaleFactor?: number;
}

export type ViewportSize = { width: number; height: number };

export interface ScreenMetrics {
  dpr: number;
  availW: number;
  availH: number;
  chromeW: number;
  chromeH: number;
}

/** 视口下限:即使工作区极小也不裁到 0,保持可用 */
const MIN_VIEWPORT_PX = 320;

/**
 * 按屏幕可容纳区域钳制视口:
 * 窗口总高 = 视口 + 窗口边框(chrome),必须 ≤ 工作区,否则 Windows 会裁剪窗口,
 * 再叠加 DPI 缩放换算(100% 物理=逻辑,125%/150% 物理≠逻辑)会产生周期性的窗口尺寸抖动/视频闪烁。
 * chromeW/H 用真实窗口的 outer-inner 度量(会随 DPI 缩放),avail 用真实工作区(DIP)。
 */
export function fitViewport(requested: ViewportSize, m: ScreenMetrics): ViewportSize {
  const maxW = Math.max(MIN_VIEWPORT_PX, Math.round(m.availW - m.chromeW));
  const maxH = Math.max(MIN_VIEWPORT_PX, Math.round(m.availH - m.chromeH));
  // h264 编码要求宽高为偶数,否则转码失败:最终值一律偶数对齐
  const evenAlign = (v: number) => Math.max(2, v - (v % 2));
  return {
    width: evenAlign(Math.min(requested.width, maxW)),
    height: evenAlign(Math.min(requested.height, maxH)),
  };
}

let cachedScreenMetrics: ScreenMetrics | null = null;

/**
 * 探测真实显示器参数:用 viewport:null 的探针窗口(Playwright 接管视口后 screen.* 会被
 * 欺骗为窗口尺寸),拿到真实的 devicePixelRatio 与工作区(avail,精确处理 DPI 缩放的任务栏扣除)。
 */
export async function measureScreen(browser: Browser): Promise<ScreenMetrics | null> {
  if (cachedScreenMetrics) return cachedScreenMetrics;
  try {
    const probeCtx = await browser.newContext({ viewport: null });
    try {
      const probePage = await probeCtx.newPage();
      const m = await probePage.evaluate(() => ({
        dpr: window.devicePixelRatio,
        availW: Math.round(window.screen.availWidth),
        availH: Math.round(window.screen.availHeight),
        chromeW: window.outerWidth - window.innerWidth,
        chromeH: window.outerHeight - window.innerHeight,
      }));
      cachedScreenMetrics = m;
      return m;
    } finally {
      await probeCtx.close().catch(() => {});
    }
  } catch {
    return null; // 探测失败时退化为原行为(不钳制、不强对齐 DSF)
  }
}

const POLL_INTERVAL_MS = 500;
const DEBOUNCE_MS = 800;
const FINALIZE_GRACE_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function recordAndWait(opts: RecordOptions): Promise<RecordResult> {
  await ensureFfmpeg(); // 结束阶段需要转码为 mp4，前置探测
  const startedAt = Date.now();
  const browser = await chromium.launch({ headless: false });

  // 屏幕适配:探针窗口读取真实 DPI/工作区 → 视口钳制 + deviceScaleFactor 对齐显示器真实缩放
  const probe = await measureScreen(browser);
  const fitted = probe ? fitViewport(opts.viewport, probe) : { width: opts.viewport.width, height: opts.viewport.height };
  const dsf =
    opts.deviceScaleFactor ?? (probe && probe.dpr > 1.05 ? probe.dpr : undefined);
  if (fitted.width !== opts.viewport.width || fitted.height !== opts.viewport.height) {
    console.error(
      `[record] 屏幕可容纳区域不足以放下 ${opts.viewport.width}x${opts.viewport.height}，已调整为 ${fitted.width}x${fitted.height}（缩小视口以消除窗口被系统裁剪导致的尺寸抖动）`,
    );
  }

  const context = await browser.newContext({
    viewport: fitted,
    deviceScaleFactor: dsf,
    recordVideo: { dir: opts.recordingDir, size: { width: fitted.width, height: fitted.height } },
  });
  const page = await context.newPage();
  await page.addInitScript(ACTIVITY_INJECT_SCRIPT);
  let screenshotCount = 0;

  const closed = new Promise<void>((resolve) => {
    context.on('close', () => resolve());
    browser.on('disconnected', () => resolve());
  });

  // 浏览器/页面关闭后置位，轮询优雅退出，不做永久空转
  let stopPolling = false;
  void closed.then(() => {
    stopPolling = true;
  });

  let videoPath = '';
  const poller = (async () => {
    let lastShotAt = 0;
    while (!stopPolling && !page.isClosed()) {
      const now = Date.now();
      const dirty = await page
        .evaluate(() => (window as any).__opRecorderDirty === true)
        .catch(() => false);
      if (dirty && now - lastShotAt >= DEBOUNCE_MS) {
        lastShotAt = now;
        const seq = String(screenshotCount + 1).padStart(4, '0');
        await page
          .screenshot({ path: path.join(opts.screensDir, `frame_${seq}.png`) })
          .then(() => {
            screenshotCount += 1;
          })
          .catch(() => {});
        await page.evaluate(() => ((window as any).__opRecorderDirty = false)).catch(() => {});
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })();

  try {
    await page.goto(opts.targetUrl, { waitUntil: 'domcontentloaded' });
  } catch {
    stopPolling = true;
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw new Error(`无法访问目标地址：${opts.targetUrl}（请确认地址可访问）`);
  }
  await writeSessionMeta(opts.outDir, { targetUrl: opts.targetUrl, startedAt: new Date(startedAt) });
  if (opts.onOpened) await opts.onOpened(page);

  // 等待用户关闭窗口（context close / browser disconnect），或 maxDurationMin 超时后自动收尾
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(true), opts.maxDurationMin * 60_000);
    }),
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (timedOut) {
    await context.close().catch(() => {});
  }
  await closed; // 保证 context 已 close，再等 Playwright finalize 视频

  const video = page.video();
  await sleep(FINALIZE_GRACE_MS);
  const rawPath = (await video?.path().catch(() => null)) ?? null;
  if (rawPath && fs.existsSync(rawPath)) {
    const target = path.join(opts.recordingDir, 'video.mp4');
    await transcodeVideoToMp4(rawPath, target);
    videoPath = target;
  }
  await poller; // 轮询到 stop 标志后退出
  await browser.close().catch(() => {});

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  if (!videoPath) throw new Error('录制结束但未产生视频文件（操作过于短暂？请稍长一些再录），请重新录制');
  return { videoPath, screenshotCount, durationSec, viewport: fitted, deviceScaleFactor: dsf };
}