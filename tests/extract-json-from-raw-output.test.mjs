import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { extractJson } from '../scripts/extract-json-from-raw-output.mjs';

const SCRIPT = path.resolve('scripts/extract-json-from-raw-output.mjs');

describe('extractJson', () => {
  it('去掉 markdown 围栏与前后缀文本，截取首尾大括号之间的 JSON', () => {
    const raw = '以下是分析结果：\n```json\n{"version":"1.0","steps":[{"description":"打开登录页面"}]}\n```\n希望有帮助';
    const out = extractJson(raw);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ version: '1.0' });
    expect(parsed.steps[0].description).toBe('打开登录页面');
  });

  it('本来就是合法 JSON：原样截取解析成功', () => {
    const raw = JSON.stringify({ steps: [{ description: '点击按钮' }] });
    expect(JSON.parse(extractJson(raw))).toEqual(JSON.parse(raw));
  });

  it('没有大括号 → null', () => {
    expect(extractJson('这是一段纯文本，没有 JSON')).toBeNull();
  });

  it('有大括号但截取段不是合法 JSON → null', () => {
    expect(extractJson('{"steps":')).toBeNull();
  });

  it('只有结束大括号没有开始大括号 → null', () => {
    expect(extractJson('} 结束')).toBeNull();
  });

  it('多个 JSON 对象时首尾截取段非法 → null，不伪造结果', () => {
    expect(extractJson('{"a":1} 中间文本 {"b":2}')).toBeNull();
  });
});

describe('脚本进程调用', () => {
  it('输入含围栏 → exit 0 且输出文件为可解析 JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-script-'));
    const inFile = path.join(dir, 'raw.txt');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(inFile, '```json\n{"steps":[]}\n```', 'utf8');
    execFileSync(process.execPath, [SCRIPT, inFile, outFile]);
    expect(JSON.parse(fs.readFileSync(outFile, 'utf8'))).toEqual({ steps: [] });
  });

  it('无法提取 → exit 非 0 且不写输出文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oprec-script-'));
    const inFile = path.join(dir, 'raw.txt');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(inFile, '纯文本没有大括号', 'utf8');
    expect(() => execFileSync(process.execPath, [SCRIPT, inFile, outFile])).toThrow();
    expect(fs.existsSync(outFile)).toBe(false);
  });

  it('缺少输出参数 → exit 非 0', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT])).toThrow();
  });
});