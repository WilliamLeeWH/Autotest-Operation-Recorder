import { describe, expect, it } from 'vitest';
import { validateSteps } from './steps.schema.js';

const validFile = {
  version: '1.0',
  meta: {
    generated_at: '2026-08-26T10:30:00+08:00',
    target_url: 'http://localhost:8080/login',
    video: 'recording/video.mp4',
    model: 'qwen2.5-vl-max',
    input_mode: 'frames',
    frame_count: 30,
  },
  steps: [
    { id: 1, description: '点击页面右上角的「登录」按钮', action_type: 'click', target: '登录按钮', value: null, start_sec: 3.5 },
    { id: 2, description: '在「用户名」输入框输入 test01', action_type: 'input', target: '用户名输入框', value: 'test01', start_sec: 6.0 },
  ],
};

describe('validateSteps', () => {
  it('合法样本通过', () => {
    const r = validateSteps(validFile);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.steps).toHaveLength(2);
  });

  it('非法 action_type 被拒绝', () => {
    const bad = structuredClone(validFile);
    bad.steps[0].action_type = 'Drag';
    const r = validateSteps(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('action_type');
  });

  it('缺 description 被拒绝', () => {
    const bad = structuredClone(validFile) as any;
    delete bad.steps[0].description;
    expect(validateSteps(bad).ok).toBe(false);
  });

  it('非 JSON 文本返回解析错误', () => {
    const r = validateSteps('not json at all');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('JSON');
  });

  it('步骤为空的裸 JSON 对象按缺字段拒绝', () => {
    expect(validateSteps(JSON.parse('{"foo":1}')).ok).toBe(false);
  });
});
