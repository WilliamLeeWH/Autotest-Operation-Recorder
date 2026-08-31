import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStderrProgressPrinter, formatDuration, formatProgress, maskSecret, startRoundTimer } from './progress.js';

function collect(): { lines: string[]; stream: { write: (s: string) => void; isTTY?: boolean } } {
  const lines: string[] = [];
  const stream = {
    write: (s: string) => {
      lines.push(s);
    },
  };
  return { lines, stream };
}

describe('formatProgress', () => {
  it('stepStart：阶段名 +「中」+ 配置摘要', () => {
    expect(
      formatProgress({ kind: 'stepStart', phase: '视频抽帧预处理', detail: '模式=interval 间隔=1s 上限=30帧' }),
    ).toBe('▸ 视频抽帧预处理中：模式=interval 间隔=1s 上限=30帧');
  });

  it('stepOk：✔ + 阶段名 +「完成」+ 结果摘要', () => {
    expect(formatProgress({ kind: 'stepOk', phase: '视频抽帧预处理', detail: '提取 30 帧' })).toBe(
      '✔ 视频抽帧预处理完成：提取 30 帧',
    );
  });

  it('stepFail：✘ + 阶段名 +「失败」+ 原因', () => {
    expect(formatProgress({ kind: 'stepFail', phase: '模型分析', reason: '网络错误' })).toBe('✘ 模型分析失败：网络错误');
  });

  it('空 detail 时不输出尾随冒号', () => {
    expect(formatProgress({ kind: 'stepOk', phase: '提示词组装', detail: '' })).toBe('✔ 提示词组装完成');
  });
});

describe('maskSecret', () => {
  it('长密钥：保留前 3 与后 3，中间打码', () => {
    expect(maskSecret('sk-abcdef1234567890')).toBe('sk-***890');
  });

  it('短密钥：整体打码', () => {
    expect(maskSecret('abc')).toBe('***');
  });
});

describe('createStderrProgressPrinter', () => {
  it('将格式化事件逐行写入 stderr', () => {
    const { lines, stream } = collect();
    const printer = createStderrProgressPrinter(stream);
    printer({ kind: 'stepOk', phase: '结果校验与装配', detail: 'steps.json 已写入（2 步）' });
    expect(lines).toEqual(['✔ 结果校验与装配完成：steps.json 已写入（2 步）\n']);
  });
});

describe('formatDuration', () => {
  it('不足 1 秒保留一位小数', () => {
    expect(formatDuration(340)).toBe('0.3s');
  });

  it('整秒省略小数位', () => {
    expect(formatDuration(12000)).toBe('12s');
  });
});

describe('startRoundTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('TTY 下每秒刷新计行，stop 时清行并返回真实耗时', () => {
    const { lines, stream } = collect();
    stream.isTTY = true;
    const timer = startRoundTimer({ round: 1, rounds: 3, stream });
    expect(lines[0]).toBe('\r⏱ 第 1/3 轮思考中：已用时 0s\x1b[K');

    vi.advanceTimersByTime(2500);
    expect(lines.at(-1)).toBe('\r⏱ 第 1/3 轮思考中：已用时 2s\x1b[K');

    const { elapsedMs } = timer.stop();
    expect(elapsedMs).toBe(2500);
    expect(lines.at(-1)).toBe('\r\x1b[K');
  });

  it('非 TTY（管道/测试）不进行秒级刷新', () => {
    const { lines, stream } = collect();
    const timer = startRoundTimer({ round: 1, rounds: 3, stream });
    vi.advanceTimersByTime(5000);
    const { elapsedMs } = timer.stop();
    expect(elapsedMs).toBe(5000);
    expect(lines).toEqual([]);
  });
});