#!/usr/bin/env node
/**
 * 模型原始输出 JSON 修复脚本：截取第一个 { 到最后一个 }（含两端大括号）之间的内容，用 JSON.parse 解析。
 *
 * 场景：视觉模型输出偶发带 markdown 围栏 / 前后缀文本，不满足「只输出 JSON」要求，
 * 此时分析流程（src/analyze/refine.ts）调用本脚本尝试从噪声中救回 JSON；
 * 救回成功则本轮模型输出视作合法，失败则进入下一轮自修正重试。
 *
 * 用法：
 *   node scripts/extract-json-from-raw-output.mjs <输入文件> <输出文件>
 *   - 输入文件：模型 raw output 原文
 *   - 输出文件：解析成功时写入格式化 JSON 并 exit 0；解析失败不写文件且 exit 1
 *
 * 纯 Node 可运行（.mjs 免编译），运行时以 process.execPath 调用，dev（tsx）与 dist 产物均可用。
 */
import fs from 'node:fs';

/**
 * 截取 raw 中第一个 {@code {} 到最后一个 {@code }}（含两端大括号），JSON.parse 成功后返回格式化 JSON 文本；
 * 无大括号、截取段非法 JSON 或首尾大括号乱序时返回 null。
 */
export function extractJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || start > end) return null;
  try {
    return JSON.stringify(JSON.parse(raw.slice(start, end + 1)), null, 2);
  } catch {
    return null;
  }
}

function main(argv) {
  const [inFile, outFile] = argv;
  if (!inFile || !outFile) {
    console.error('用法：node scripts/extract-json-from-raw-output.mjs <输入文件> <输出文件>');
    return 2;
  }
  let raw;
  try {
    raw = fs.readFileSync(inFile, 'utf8');
  } catch (e) {
    console.error(`读取输入文件失败：${e.message}`);
    return 1;
  }
  const repaired = extractJson(raw);
  if (repaired === null) {
    console.error('未能从模型原始输出中截取并解析出合法 JSON（首尾大括号缺失或截取段非法）');
    return 1;
  }
  try {
    fs.writeFileSync(outFile, repaired, 'utf8');
  } catch (e) {
    console.error(`写入输出文件失败：${e.message}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, '/')}`).href) {
  process.exitCode = main(process.argv.slice(2));
}