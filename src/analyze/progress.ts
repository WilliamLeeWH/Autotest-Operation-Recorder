/**
 * 视频分析分步进度日志：每阶段「开始 → 成功/失败」通过 ProgressPrinter 对外输出。
 * 默认写 stderr（默认开启，与 stdout 稳定行契约解耦）；测试可注入收集器。
 */

export type ProgressEvent =
  | { kind: 'stepStart'; phase: string; detail: string }
  | { kind: 'stepOk'; phase: string; detail: string }
  | { kind: 'stepFail'; phase: string; reason: string };

export type ProgressPrinter = (evt: ProgressEvent) => void;

export function formatProgress(evt: ProgressEvent): string {
  switch (evt.kind) {
    case 'stepStart': {
      const suffix = evt.detail ? `：${evt.detail}` : '';
      return `▸ ${evt.phase}中${suffix}`;
    }
    case 'stepOk': {
      const suffix = evt.detail ? `：${evt.detail}` : '';
      return `✔ ${evt.phase}完成${suffix}`;
    }
    case 'stepFail': {
      return `✘ ${evt.phase}失败：${evt.reason}`;
    }
  }
}

export function createStderrProgressPrinter(stream: { write: (s: string) => unknown } = process.stderr): ProgressPrinter {
  return (evt) => stream.write(`${formatProgress(evt)}\n`);
}

/** 密钥打码：保留前 3 与后 3 位，绝不完整输出明文密钥 */
export function maskSecret(secret: string): string {
  if (secret.length <= 6) return '***';
  return `${secret.slice(0, 3)}***${secret.slice(-3)}`;
}

/** 毫秒 → 可读时长：0.3s / 12s（整秒省略小数位） */
export function formatDuration(ms: number): string {
  const s = (ms / 1000).toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}s`;
}

export interface RoundTimerOptions {
  round: number;
  rounds: number;
  stream?: { write: (s: string) => unknown; isTTY?: boolean };
}

export interface RoundTimerHandle {
  /** 停止刷新，返回该轮真实耗时（毫秒） */
  stop(): { elapsedMs: number };
}

/**
 * 单轮思考计时器：TTY 下立即打印并每秒刷新同一行（\r 覆盖），stop 时清行；
 * 非 TTY（管道/测试）不输出任何字符，但 stop 仍返回耗时。
 */
export function startRoundTimer(opts: RoundTimerOptions): RoundTimerHandle {
  const stream = opts.stream ?? process.stderr;
  const startedAt = Date.now();
  const tty = !!stream.isTTY;
  const tick = () =>
    stream.write(`\r⏱ 第 ${opts.round}/${opts.rounds} 轮思考中：已用时 ${Math.floor((Date.now() - startedAt) / 1000)}s\x1b[K`);
  let interval: ReturnType<typeof setInterval> | null = null;
  if (tty) {
    tick();
    interval = setInterval(tick, 1000);
  }
  return {
    stop() {
      if (interval !== null) clearInterval(interval);
      if (tty) stream.write('\r\x1b[K');
      return { elapsedMs: Date.now() - startedAt };
    },
  };
}