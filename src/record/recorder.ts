import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
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
  onOpened?: (page: Page) => void | Promise<void>;
}

export interface RecordResult {
  videoPath: string;
  screenshotCount: number;
  durationSec: number;
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
  const context = await browser.newContext({
    viewport: opts.viewport,
    recordVideo: { dir: opts.recordingDir, size: { width: opts.viewport.width, height: opts.viewport.height } },
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
  return { videoPath, screenshotCount, durationSec };
}