/**
 * 一次性迁移脚本：把旧产物布局的会话目录迁移为新结构。
 *
 * 旧：recording/screens/*.png + 会话根散落 session.json/steps.json(steps.yaml)/failure.json
 * 新：screenshots/*.png + results/{session,steps,failure}.json（三个平级子目录 recording/ screenshots/ results/）
 *
 * 用法：
 *   npx tsx scripts/migrate-out-layout.ts [--out <dir>] [--date <YYYYMMDD> | --all] [--dry-run]
 * 默认扫描 out/ 下今天（本地日期）的会话目录；--dry-run 只打印计划不动文件。
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SESSION_RE = /^(\d{8})-\d{6}$/;
const SCREENSHOT_RE = /\.(png|jpg)$/i;
const RESULT_FILES = ['session.json', 'steps.json', 'steps.yaml', 'failure.json'];

export function parseSessionDate(name: string): string | null {
  const m = SESSION_RE.exec(name);
  return m ? m[1] : null;
}

export function todayStamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

export interface PlannedMove {
  from: string;
  to: string;
  isScreenshot: boolean;
}

export interface MigrateResult {
  sessionDir: string;
  screenshotsMoved: number;
  resultsMoved: string[];
  skipped: string[];
}

/** 规划一个会话目录的移动（不落盘，dry-run 预览与执行共用同一份计划） */
export async function planMoves(sessionDir: string): Promise<PlannedMove[]> {
  const moves: PlannedMove[] = [];
  const screensDir = path.join(sessionDir, 'recording', 'screens');
  if (existsSync(screensDir)) {
    const shots = (await fs.readdir(screensDir)).filter((f) => SCREENSHOT_RE.test(f));
    for (const f of shots) {
      moves.push({ from: path.join(screensDir, f), to: path.join(sessionDir, 'screenshots', f), isScreenshot: true });
    }
  }
  for (const f of RESULT_FILES) {
    const from = path.join(sessionDir, f);
    if (existsSync(from)) moves.push({ from, to: path.join(sessionDir, 'results', f), isScreenshot: false });
  }
  return moves;
}

export async function migrateSession(sessionDir: string): Promise<MigrateResult> {
  const moved: string[] = [];
  const skipped: string[] = [];
  let screenshotCount = 0;
  for (const m of await planMoves(sessionDir)) {
    if (existsSync(m.to)) {
      skipped.push(m.to); // 目标已存在：不覆盖，保持幂等
      continue;
    }
    await fs.mkdir(path.dirname(m.to), { recursive: true });
    await fs.rename(m.from, m.to);
    if (m.isScreenshot) screenshotCount += 1;
    moved.push(m.to);
  }
  // 截图全部移走后清掉旧 screens/ 目录；若残留非截图文件则原样保留
  const screensDir = path.join(sessionDir, 'recording', 'screens');
  if (screenshotCount > 0 && (await fs.readdir(screensDir).catch(() => [] as string[])).length === 0) {
    await fs.rmdir(screensDir);
  }
  return { sessionDir, screenshotsMoved: screenshotCount, resultsMoved: moved.filter((p) => !SCREENSHOT_RE.test(p)), skipped };
}

interface Args {
  outRoot: string;
  date: string | null;
  all: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { outRoot: 'out', date: null, all: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.outRoot = next();
    else if (a === '--date') args.date = next();
    else if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法：npx tsx scripts/migrate-out-layout.ts [--out <dir>] [--date <YYYYMMDD> | --all] [--dry-run]');
      throw new StopRun(0);
    } else throw new Error(`未知参数：${a}`);
  }
  if (args.date && !/^\d{8}$/.test(args.date)) throw new Error(`--date 需为 YYYYMMDD 格式：${args.date}`);
  return args;
}

class StopRun extends Error {
  constructor(public code: number) {
    super('stop');
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const stamp = args.all ? null : (args.date ?? todayStamp());
  const names = (await fs.readdir(args.outRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && SESSION_RE.test(e.name))
    .map((e) => e.name)
    .filter((n) => stamp === null || parseSessionDate(n) === stamp)
    .sort();

  if (names.length === 0) {
    console.log(`没有找到${args.all ? '任何' : `日期 ${stamp} 的`}会话目录（${args.outRoot}/）`);
    return 0;
  }

  let failed = 0;
  for (const name of names) {
    const sessionDir = path.join(args.outRoot, name);
    if (args.dryRun) {
      const moves = await planMoves(sessionDir);
      const shots = moves.filter((m) => m.isScreenshot).length;
      console.log(`[dry-run] ${name}: 截图 ${shots} 个、结果文件 ${moves.length - shots} 个，未改动`);
      continue;
    }
    try {
      const r = await migrateSession(sessionDir);
      const results = r.resultsMoved.map((p) => path.basename(p));
      const skipNote = r.skipped.length ? `，跳过 ${r.skipped.length} 个（目标已存在）` : '';
      console.log(`${name}: 截图 ${r.screenshotsMoved} 个 → screenshots/，结果 ${results.length} 个${results.length ? `（${results.join('、')}）` : ''} → results/${skipNote}`);
    } catch (e) {
      failed += 1;
      console.error(`${name}: 迁移失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, '/')}`).href) {
  let code: number;
  try {
    code = await main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof StopRun) {
      code = e.code;
    } else {
      console.error(`失败：${e instanceof Error ? e.message : String(e)}`);
      code = 2;
    }
  }
  process.exitCode = code;
}