import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Page } from 'playwright';
import { CLICK_HIGHLIGHT_INJECT_SCRIPT } from './click-highlight-inject.js';
import { startPageServer } from '../../tests/fixtures/page-server.js';

let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  server = await startPageServer();
});
afterAll(async () => {
  await server.close();
});

async function withInjectedPage(fn: (page: Page) => Promise<void>): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(CLICK_HIGHLIGHT_INJECT_SCRIPT);
    await page.goto(server.url);
    await fn(page);
  } finally {
    await browser.close();
  }
}

function readMarker(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-op-click-highlight]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      position: getComputedStyle(el).position,
      pointerEvents: getComputedStyle(el).pointerEvents,
      zIndex: getComputedStyle(el).zIndex,
      hasDot: Boolean(el.querySelector('[data-op-click-dot]')),
      hasRing: Boolean(el.querySelector('[data-op-click-ring]')),
      count: document.querySelectorAll('[data-op-click-highlight]').length,
    };
  });
}

describe('CLICK_HIGHLIGHT_INJECT_SCRIPT', () => {
  it('主键按下时在按下坐标绘制高亮(固定定位/不拦截事件/含中心点与扩散环)', async () => {
    await withInjectedPage(async (page) => {
      await page.mouse.move(120, 85);
      await page.mouse.down();
      const marker = await readMarker(page);
      expect(marker).not.toBeNull();
      expect(marker!.x).toBeCloseTo(120, -1); // 外容器定位在点击坐标上
      expect(marker!.y).toBeCloseTo(85, -1);
      expect(marker!.position).toBe('fixed'); // 跟随视口,不随页面滚动
      expect(marker!.pointerEvents).toBe('none'); // 不拦截目标页面的真实点击
      expect(marker!.zIndex).toBe('2147483647'); // 覆盖层最顶
      expect(marker!.hasDot).toBe(true); // 中心圆点
      expect(marker!.hasRing).toBe(true); // 扩散圆环
      expect(marker!.count).toBe(1);
      await page.mouse.up();
    });
  });

  it('非主键(右键)不绘制高亮', async () => {
    await withInjectedPage(async (page) => {
      await page.mouse.move(200, 130);
      await page.mouse.down({ button: 'right' });
      expect(await readMarker(page)).toBeNull();
      await page.mouse.up({ button: 'right' });
    });
  });

  it('约 1.4s 后高亮自动移除(覆盖 800ms 截图去抖窗口后不残留)', async () => {
    await withInjectedPage(async (page) => {
      await page.mouse.move(90, 60);
      await page.mouse.down();
      await page.mouse.up();
      expect(await readMarker(page)).not.toBeNull();
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      expect(await readMarker(page)).toBeNull();
    });
  });

  it('快速连点时新的高亮替换旧的高亮,页面上始终只剩一个', async () => {
    await withInjectedPage(async (page) => {
      await page.mouse.move(70, 50);
      await page.mouse.down();
      await page.mouse.up();
      await page.mouse.move(300, 200);
      await page.mouse.down();
      await page.mouse.up();
      const marker = await readMarker(page);
      expect(marker!.x).toBeCloseTo(300, -1);
      expect(marker!.y).toBeCloseTo(200, -1);
      expect(marker!.count).toBe(1);
    });
  });
});