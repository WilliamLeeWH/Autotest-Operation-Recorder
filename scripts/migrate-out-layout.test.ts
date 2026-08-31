import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSession, parseSessionDate, todayStamp } from './migrate-out-layout.js';

/** 构造一个旧布局会话目录（种在独立 tmp 目录里，即会话根） */
function oldSession(): { root: string; names: { shot: string; step: string; fail: string } } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-mig-'));
  fs.mkdirSync(path.join(root, 'recording', 'screens'), { recursive: true });
  fs.writeFileSync(path.join(root, 'recording', 'screens', 'frame_0001.png'), 'png-1');
  fs.writeFileSync(path.join(root, 'recording', 'screens', 'frame_0002.png'), 'png-2');
  fs.writeFileSync(path.join(root, 'recording', 'video.mp4'), 'video-data');
  fs.writeFileSync(path.join(root, 'session.json'), '{"root":1}');
  fs.writeFileSync(path.join(root, 'steps.json'), '{"root":2}');
  fs.writeFileSync(path.join(root, 'failure.json'), '{"root":3}');
  return {
    root,
    names: { shot: 'frame_0001.png', step: 'steps.json', fail: 'failure.json' },
  };
}

describe('migrateSession', () => {
  it('老布局整体迁移为新结构：截图→screenshots/，json→results/，video 不动', async () => {
    const { root, names } = oldSession();
    const r = await migrateSession(root);

    // 截图
    expect(fs.readFileSync(path.join(root, 'screenshots', 'frame_0001.png'), 'utf8')).toBe('png-1');
    expect(fs.readFileSync(path.join(root, 'screenshots', 'frame_0002.png'), 'utf8')).toBe('png-2');
    expect(fs.existsSync(path.join(root, 'recording', 'screens'))).toBe(false); // 空目录已删除
    expect(fs.existsSync(path.join(root, 'recording', 'video.mp4'))).toBe(true); // 录像不动
    // 结果 json
    for (const f of ['session.json', 'steps.json', 'failure.json']) {
      expect(fs.existsSync(path.join(root, 'results', f))).toBe(true);
      expect(fs.existsSync(path.join(root, f))).toBe(false);
    }
    // 计数
    expect(r.screenshotsMoved).toBe(2);
    expect(r.resultsMoved).toHaveLength(3);
    expect(r.skipped).toEqual([]);
  });

  it('幂等：第二次运行不再产生任何移动', async () => {
    const { root } = oldSession();
    await migrateSession(root);
    const again = await migrateSession(root);
    expect(again.screenshotsMoved).toBe(0);
    expect(again.resultsMoved).toEqual([]);
    expect(again.skipped).toEqual([]);
    expect(fs.existsSync(path.join(root, 'screenshots', 'frame_0001.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'results', 'steps.json'))).toBe(true);
  });

  it('目标文件已存在时跳过不覆盖', async () => {
    const { root, names } = oldSession();
    fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(root, 'screenshots', names.shot), 'keep-me');
    const r = await migrateSession(root);
    // 预置文件原样保留，另一个截图照常迁移
    expect(fs.readFileSync(path.join(root, 'screenshots', names.shot), 'utf8')).toBe('keep-me');
    expect(fs.readFileSync(path.join(root, 'screenshots', 'frame_0002.png'), 'utf8')).toBe('png-2');
    expect(r.skipped).toEqual([path.join(root, 'screenshots', names.shot)]);
    expect(r.screenshotsMoved).toBe(1);
  });

  it('没有旧结构的目录直接返回空结果', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-mig-'));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    const r = await migrateSession(root);
    expect(r.screenshotsMoved).toBe(0);
    expect(r.resultsMoved).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('x');
  });
});

describe('parseSessionDate / todayStamp', () => {
  it('识别 YYYYMMDD-HHMMSS 会话目录名并返回日期前缀', () => {
    expect(parseSessionDate('20260831-102824')).toBe('20260831');
    expect(parseSessionDate('noise')).toBeNull();
    expect(parseSessionDate('.hidden')).toBeNull();
    expect(parseSessionDate('20260831')).toBeNull();
  });

  it('todayStamp 取本地日期 YYYYMMDD', () => {
    expect(todayStamp(new Date('2026-08-31T10:00:00'))).toBe('20260831');
    expect(todayStamp(new Date('2026-01-05T23:59:59'))).toBe('20260105');
  });
});