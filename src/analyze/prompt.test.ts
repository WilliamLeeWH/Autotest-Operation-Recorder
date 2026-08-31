import { describe, expect, it } from 'vitest';
import { buildUserMessage, loadPromptTemplate } from './prompt.js';

describe('prompt', () => {
  it('frames 模板可加载且含关键约束', async () => {
    const t = await loadPromptTemplate('frames');
    expect(t).toContain('{{FRAME_COUNT}}');
    expect(t).toContain('action_type');
    expect(t).toContain('midscene');
    expect(t).toContain('只输出');
    expect(t).toContain('assertion');
    expect(t).toContain('aiAssert');
    // 录制侧新增鼠标点击高亮：模板必须告知模型其含义
    expect(t).toContain('红色');
    expect(t).toContain('高亮');
    expect(t).toContain('涟漪');
  });

  it('video 模板可加载且结构同构', async () => {
    const t = await loadPromptTemplate('video');
    expect(t).toContain('action_type');
    expect(t).toContain('midscene');
    expect(t).toContain('assertion');
    expect(t).toContain('aiAssert');
    expect(t).toContain('红色');
    expect(t).toContain('高亮');
    expect(t).toContain('涟漪');
  });

  it('未知模式抛错', async () => {
    await expect(loadPromptTemplate('nope' as any)).rejects.toThrow();
  });

  it('buildUserMessage 替换帧数标记', async () => {
    const msg = buildUserMessage('共 {{FRAME_COUNT}} 帧', { mode: 'frames', frameCount: 12 });
    expect(msg).toContain('共 12 帧');
  });
});
