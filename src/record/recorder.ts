import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { ACTIVITY_INJECT_SCRIPT } from './activity-inject.js';
import { CLICK_HIGHLIGHT_INJECT_SCRIPT } from './click-highlight-inject.js';
import { writeSessionMeta } from '../output/writer.js';
import { ensureFfmpeg, probeVideoDurationMs, transcodeVideoToMp4 } from '../lib/ffmpeg.js';

export interface RecordOptions {
  targetUrl: string;
  outDir: string;
  recordingDir: string;
  screensDir: string;
  maxDurationMin: number;
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  /** 鼠标点击高亮（点击处扩散涟漪），默认开启：帮助视觉模型定位点击位置 */
  clickHighlight?: boolean;
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
const VIDEO_READY_RETRY_MS = 500;
const VIDEO_READY_MAX_WAIT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询 ffprobe 直到录制文件可解析（时长可读取）。
 * 窗口被外部关闭后 Playwright 仍会异步最终化录制缓冲：实测 context.close() 后
 * 文件先在约 4-5s 内保持 0 字节,随后一次性写入完整容器——用“尺寸稳定”判断会被
 * 空文件误导,固定 sleep 又可能读到半写入状态(转码报 EBML header parsing failed),
 * 因此以“文件可读”这一真实条件为准。上限 VIDEO_READY_MAX_WAIT_MS,超时按现状继续,
 * 转码若仍失败会走统一报错并由 finally 关闭浏览器,进程不会挂死。
 */
export async function waitForVideoReadable(videoPath: string, maxWaitMs = VIDEO_READY_MAX_WAIT_MS): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await probeVideoDurationMs(videoPath); // 未最终化的文件解析不到时长,会抛错
      return;
    } catch {
      if (Date.now() + VIDEO_READY_RETRY_MS >= deadline) return; // 再等一轮即到上限 → 直接继续
      await sleep(VIDEO_READY_RETRY_MS);
    }
  }
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
  if (opts.clickHighlight !== false) await page.addInitScript(CLICK_HIGHLIGHT_INJECT_SCRIPT);
  let screenshotCount = 0;

  const closed = new Promise<void>((resolve) => {
    context.on('close', () => resolve());
    browser.on('disconnected', () => resolve());
    // 用户关闭最后一个窗口时只触发 page close：Playwright 启动的 Chromium
    // 在窗口全部关闭后进程不会自行退出，context 'close' 与 browser 'disconnected'
    // 都不会触发——只等这两个信号会把命令困到 RECORD_MAX_DURATION_MIN 超时。
    page.on('close', () => resolve());
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

  // 等待用户关闭窗口（page close / context close / browser disconnect），或 maxDurationMin 超时后自动收尾
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
  await closed; // 断言录制已结束：context close / browser disconnect / page window close 三选一

  if (!timedOut) {
    // 用户外部关闭窗口时 context 仍存活,而 Playwright 只在 context 关闭时才最终化录制
    // 文件:主动 close 触发落盘(实测不 close 可能要数分钟,close 后约 5s 内完成)
    await context.close().catch(() => {});
  }

  const video = page.video();
  const rawPath = (await video?.path().catch(() => null)) ?? null;
  if (rawPath) await waitForVideoReadable(rawPath); // 等 Playwright 异步落盘完成,避免读到半写入的 webm
  try {
    if (rawPath && fs.existsSync(rawPath) && fs.statSync(rawPath).size > 0) {
      const target = path.join(opts.recordingDir, 'video.mp4');
      await transcodeVideoToMp4(rawPath, target);
      videoPath = target;
      // 产物契约只含 video.mp4 + screens/：转码成功后删除 Playwright 原始 webm
      await fs.promises.unlink(rawPath).catch(() => {});
    }
    await poller; // 轮询到 stop 标志后退出
  } finally {
    // 转码成败都必须关闭浏览器：否则 Chromium 子进程的管道会一直挂住事件循环，CLI 永不退出
    await browser.close().catch(() => {});
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  if (!videoPath) throw new Error('录制结束但未产生视频文件（操作过于短暂？请稍长一些再录），请重新录制');
  return { videoPath, screenshotCount, durationSec, viewport: fitted, deviceScaleFactor: dsf };
}