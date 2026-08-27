import path from 'node:path';
import fs from 'node:fs';
import { Command, CommanderError } from 'commander';
import { loadConfig, ConfigError } from '../config/env.js';
import { ensureDirs } from '../output/writer.js';
import { recordAndWait } from '../record/recorder.js';
import { analyzeVideo } from '../analyze/refine.js';

const stdout = (line: string) => console.log(line);

function parseViewport(v: string): { width: number; height: number } {
  const [w, h] = v.split('x').map(Number);
  return { width: w, height: h };
}

function resolveAnalyzeOutDir(videoPath: string): string {
  if (path.basename(videoPath) === 'video.mp4') {
    return path.join(path.dirname(videoPath), '..'); // recording/../ → 会话目录
  }
  return path.dirname(videoPath);
}

export async function main(argv: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => process.stderr.write(s), writeOut: (s) => process.stdout.write(s) });

  program.description('录制浏览器操作 → 视觉大模型 → 结构化操作步骤（供 midscene.js 脚本）');

  program
    .command('record')
    .description('录制：弹出有头浏览器，等待用户操作后关闭窗口，产出 mp4 + 活动截图')
    .requiredOption('--target <url>', '目标页面地址')
    .option('--out <dir>', '产物根目录（默认 out/）', 'out')
    .option('--max-duration-min <n>', '最长录制分钟数')
    .option('--viewport <WxH>', '浏览器视口')
    .option('--env-file <path>', '.env 文件路径（默认 .env）', '.env')
    .option('--verbose', '输出调试日志到 stderr', false)
    .action(async (opts) => {
      const cfg = loadConfig({}, opts.envFile);
      const dirs = await ensureDirs(opts.out);
      if (opts.verbose) console.error(`[record] target=${opts.target} out=${dirs.outDir}`);
      const result = await recordAndWait({
        targetUrl: opts.target,
        ...dirs,
        maxDurationMin: opts.maxDurationMin ? Number(opts.maxDurationMin) : cfg.record.maxDurationMin,
        viewport: opts.viewport ? parseViewport(opts.viewport) : cfg.record.viewport,
      });
      stdout(`output: ${dirs.outDir}`);
      stdout(`video: ${result.videoPath}`);
      stdout(`screenshots: ${result.screenshotCount}`);
    });

  program
    .command('analyze')
    .description('分析：抽帧 → 视觉大模型 → steps.json（可对同一视频无限重跑）')
    .requiredOption('--video <path>', '视频文件路径')
    .option('--out <dir>', '产物目录（默认：视频所在会话目录）')
    .option('--format <json|yaml>', '输出格式')
    .option('--model <m>', '覆盖 VLM_MODEL')
    .option('--base-url <u>', '覆盖 VLM_BASE_URL')
    .option('--api-key <k>', '覆盖 VLM_API_KEY')
    .option('--vlm-input-mode <frames|video>', '覆盖 VLM_INPUT_MODE')
    .option('--env-file <path>', '.env 文件路径（默认 .env）', '.env')
    .option('--verbose', '输出调试日志到 stderr', false)
    .action(async (opts) => {
      if (!fs.existsSync(opts.video)) throw new Error(`视频文件不存在：${opts.video}`);
      const overrides: Record<string, string> = {};
      if (opts.model) overrides.VLM_MODEL = opts.model;
      if (opts.baseUrl) overrides.VLM_BASE_URL = opts.baseUrl;
      if (opts.apiKey) overrides.VLM_API_KEY = opts.apiKey;
      if (typeof opts.vlmInputMode === 'string') overrides.VLM_INPUT_MODE = opts.vlmInputMode;
      if (typeof opts.format === 'string') overrides.OUTPUT_FORMAT = opts.format;
      const cfg = loadConfig(overrides, opts.envFile);
      const outDir = opts.out ?? resolveAnalyzeOutDir(opts.video);
      if (opts.verbose) console.error(`[analyze] video=${opts.video} out=${outDir} model=${cfg.vlm.model}`);
      const result = await analyzeVideo({ outDir, videoPath: opts.video, cfg });
      if (result.ok) {
        stdout(`steps: ${result.stepsPath}`);
      } else {
        console.error(`[analyze] 失败：${result.reason}`);
        stdout(`failure: ${result.failurePath}`);
        process.exitCode = 1;
      }
    });

  program
    .command('run')
    .description('录制 + 分析 一步到位')
    .requiredOption('--target <url>', '目标页面地址')
    .option('--out <dir>', '产物根目录（默认 out/）', 'out')
    .option('--max-duration-min <n>', '最长录制分钟数')
    .option('--viewport <WxH>', '浏览器视口')
    .option('--format <json|yaml>', '输出格式')
    .option('--model <m>', '覆盖 VLM_MODEL')
    .option('--base-url <u>', '覆盖 VLM_BASE_URL')
    .option('--api-key <k>', '覆盖 VLM_API_KEY')
    .option('--vlm-input-mode <frames|video>', '覆盖 VLM_INPUT_MODE')
    .option('--env-file <path>', '.env 文件路径（默认 .env）', '.env')
    .option('--verbose', '输出调试日志到 stderr', false)
    .action(async (opts) => {
      const cfg = loadConfig({}, opts.envFile);
      const dirs = await ensureDirs(opts.out);
      if (opts.verbose) console.error(`[run] target=${opts.target} out=${dirs.outDir}`);
      const recordResult = await recordAndWait({
        targetUrl: opts.target,
        ...dirs,
        maxDurationMin: opts.maxDurationMin ? Number(opts.maxDurationMin) : cfg.record.maxDurationMin,
        viewport: opts.viewport ? parseViewport(opts.viewport) : cfg.record.viewport,
      });
      const overrides: Record<string, string> = {};
      if (typeof opts.vlmInputMode === 'string') overrides.VLM_INPUT_MODE = opts.vlmInputMode;
      if (typeof opts.format === 'string') overrides.OUTPUT_FORMAT = opts.format;
      if (opts.model) overrides.VLM_MODEL = opts.model;
      if (opts.baseUrl) overrides.VLM_BASE_URL = opts.baseUrl;
      if (opts.apiKey) overrides.VLM_API_KEY = opts.apiKey;
      const analyzeCfg = loadConfig(overrides, opts.envFile);
      const result = await analyzeVideo({ outDir: dirs.outDir, videoPath: recordResult.videoPath, cfg: analyzeCfg });
      stdout(`output: ${dirs.outDir}`);
      stdout(`video: ${recordResult.videoPath}`);
      if (result.ok) {
        stdout(`steps: ${result.stepsPath}`);
      } else {
        console.error(`[run] 分析失败：${result.reason}`);
        stdout(`failure: ${result.failurePath}`);
        process.exitCode = 1;
      }
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return Number(process.exitCode) || 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`配置错误：${e.message}`);
      return 2;
    }
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return e.exitCode ?? 0;
      console.error(`参数错误：${e.message}`);
      return 2;
    }
    if (e instanceof Error) {
      console.error(`失败：${e.message}`);
      if (process.env.OP_RECORDER_DEBUG) console.error(e.stack);
      return 1;
    }
    return 1;
  } finally {
    process.exitCode = 0;
  }
}

// bin 入口
if (import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, '/')}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}