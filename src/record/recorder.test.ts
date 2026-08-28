import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { fitViewport, recordAndWait, waitForVideoReadable, type ScreenMetrics } from './recorder.js';
import { startPageServer } from '../../tests/fixtures/page-server.js';
import { ensureDirs, readSessionMeta } from '../output/writer.js';
import { ffmpegPath } from '../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  server = await startPageServer();
});
afterAll(async () => {
  await server.close();
});

describe('recordAndWait', () => {
  test(
    '录制一次点击+输入，产出 mp4、截图与 session.json',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-rec-'));
      const dirs = await ensureDirs(root, 'test-session');

      let openedPage: import('playwright').Page | null = null;
      const promise = recordAndWait({
        targetUrl: server.url,
        ...dirs,
        maxDurationMin: 1,
        viewport: { width: 960, height: 600 },
        onOpened: (page) => {
          openedPage = page;
        },
      });

      await expect
        .poll(() => openedPage, { timeout: 15000, message: '浏览器页面应在 15s 内完成打开' })
        .not.toBeNull(); // 有界轮询等待页面打开（避免与有头 Chromium 冷启动赛跑）
      const page = openedPage as unknown as import('playwright').Page;

      await page.fill('#username', 'test01'); // 触发 input 事件 → 脏标记
      await page.click('#login'); // 触发 click → 脏标记
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      await openedPage!.context().close(); // 模拟用户关闭浏览器 → 结束录制

      const result = await promise;
      expect(fs.existsSync(result.videoPath)).toBe(true);
      expect(fs.statSync(result.videoPath).size).toBeGreaterThan(1000);
      expect(result.screenshotCount).toBeGreaterThanOrEqual(1);
      const meta = await readSessionMeta(dirs.outDir);
      expect(meta?.targetUrl).toBe(server.url);
    },
    60_000
  );

  test(
    '用户只关窗口(page close 而 context 仍在)时立即结束录制,不等 maxDurationMin 超时',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-winclose-'));
      const dirs = await ensureDirs(root, 'winclose-session');

      let openedPage: import('playwright').Page | null = null;
      const startedAt = Date.now();
      const promise = recordAndWait({
        targetUrl: server.url,
        ...dirs,
        maxDurationMin: 1,
        viewport: { width: 960, height: 600 },
        onOpened: (page) => {
          openedPage = page;
        },
      });

      await expect
        .poll(() => openedPage, { timeout: 15000, message: '浏览器页面应在 15s 内完成打开' })
        .not.toBeNull();
      const page = openedPage as unknown as import('playwright').Page;

      await page.fill('#username', 'test01'); // 触发 input 事件 → 脏标记
      await new Promise<void>((resolve) => setTimeout(resolve, 1200));
      await page.close(); // 模拟用户关闭窗口：只触发 page close，context 与浏览器进程仍然存活

      const result = await promise;
      // 收尾应在几十秒内完成；旧实现(只等 context close / browser disconnect)会卡到 60s 超时才退出
      expect(Date.now() - startedAt).toBeLessThan(30_000);
      expect(fs.existsSync(result.videoPath)).toBe(true);
      expect(fs.statSync(result.videoPath).size).toBeGreaterThan(1000);
    },
    60_000
  );

  test(
    '超尺寸视口请求会被钳制到屏幕可容纳尺寸,真实窗口内尺寸与钳制后一致',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-fit-'));
      const dirs = await ensureDirs(root, 'fit-session');

      let openedPage: import('playwright').Page | null = null;
      const promise = recordAndWait({
        targetUrl: server.url,
        ...dirs,
        maxDurationMin: 1,
        viewport: { width: 4000, height: 3000 }, // 任何常见屏幕都放不下
        onOpened: (page) => {
          openedPage = page;
        },
      });

      await expect
        .poll(() => openedPage, { timeout: 20000, message: '浏览器页面应在 20s 内完成打开' })
        .not.toBeNull();
      const page = openedPage as unknown as import('playwright').Page;

      const inner = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));

      await page.context().close().catch(() => {});
      const result = await promise;

      // 钳制后:窗口真实内尺寸必须恰好等于声明的视口(窗口未被系统二次裁剪)
      expect(result.viewport.width).toBeLessThan(4000);
      expect(result.viewport.height).toBeLessThan(3000);
      expect(inner).toEqual({ w: result.viewport.width, h: result.viewport.height });
    },
    60_000
  );
});

describe('waitForVideoReadable', () => {
  it('可解析的视频文件立即返回', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ready-'));
    const f = path.join(dir, 'x.webm');
    await execFileAsync(ffmpegPath(), [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=black:size=64x64:duration=1',
      '-c:v', 'libvpx', '-an', f,
    ]);
    await expect(waitForVideoReadable(f)).resolves.toBeUndefined();
  });

  it('不可解析的文件会等到上限后继续(不抛错、不无限等)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-ready-'));
    const f = path.join(dir, 'garbage.webm');
    fs.writeFileSync(f, 'this is not a webm at all');
    const t0 = Date.now();
    await expect(waitForVideoReadable(f, 3_000)).resolves.toBeUndefined();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(2_000); // 没有立刻返回,确实轮询到了上限
    expect(elapsed).toBeLessThan(10_000);
  });

  it('文件不存在时同样轮询到上限后继续', async () => {
    const t0 = Date.now();
    await expect(waitForVideoReadable(path.join(os.tmpdir(), `oprec-missing-${Date.now()}.webm`), 2_000)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThan(1_000);
  });
});

describe('fitViewport', () => {
  const m100: ScreenMetrics = { dpr: 1, availW: 1920, availH: 1040, chromeW: 16, chromeH: 95 };
  const m125: ScreenMetrics = { dpr: 1.25, availW: 1536, availH: 824, chromeW: 20, chromeH: 119 };
  const m150: ScreenMetrics = { dpr: 1.5, availW: 1280, availH: 693, chromeW: 24, chromeH: 143 };

  it('屏幕可容纳时保持请求的视口不变', () => {
    expect(fitViewport({ width: 1280, height: 800 }, m100)).toEqual({ width: 1280, height: 800 });
  });

  it('125% 屏幕放不下 1280x800 时按工作区钳制且偶数对齐', () => {
    expect(fitViewport({ width: 1280, height: 800 }, m125)).toEqual({ width: 1280, height: 704 });
  });

  it('150% 屏幕下宽度与高度同时钳制', () => {
    const fitted = fitViewport({ width: 1280, height: 800 }, m150);
    expect(fitted.width).toBeLessThanOrEqual(1280 - 24);
    expect(fitted.height).toBeLessThanOrEqual(693 - 143);
    expect(fitted.width % 2).toBe(0);
    expect(fitted.height % 2).toBe(0);
  });

  it('请求本就容纳不下时钳制并保证偶数(h264 兼容)', () => {
    const m = m100;
    const fitted = fitViewport({ width: 1921, height: 1041 }, m);
    expect(fitted.width % 2).toBe(0);
    expect(fitted.height % 2).toBe(0);
    expect(fitted.width).toBeLessThanOrEqual(1920 - 16);
    expect(fitted.height).toBeLessThanOrEqual(1040 - 95);
  });

  it('工作区过小时保留下限,不为 0', () => {
    const tiny: ScreenMetrics = { dpr: 1.5, availW: 600, availH: 400, chromeW: 24, chromeH: 143 };
    const fitted = fitViewport({ width: 1280, height: 800 }, tiny);
    expect(fitted.width).toBeGreaterThan(100);
    expect(fitted.height).toBeGreaterThan(100);
  });
});