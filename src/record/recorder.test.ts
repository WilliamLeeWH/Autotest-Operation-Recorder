import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { recordAndWait } from './recorder.js';
import { startPageServer } from '../../tests/fixtures/page-server.js';
import { ensureDirs, readSessionMeta } from '../output/writer.js';

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

      await new Promise<void>((resolve) => setTimeout(resolve, 4000)); // 等页面打开+截帧启动
      expect(openedPage).not.toBeNull();
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
});