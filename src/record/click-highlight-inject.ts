/**
 * 注入所有页面：主键按下时在点击坐标绘制扩散涟漪高亮（中心圆点 + 扩散圆环），
 * 供录屏视频/活动截图捕获鼠标点击位置（Playwright 录制的视频本身不含光标）。
 * 快照轮询去抖 800ms 截图仍能捕捉到高亮，故高亮总保留时长取 1.25s。
 */
export const CLICK_HIGHLIGHT_INJECT_SCRIPT = `
(() => {
  const RING_SCALE_END = 2.2;  // 圆环从 36px 扩散到约 79px
  const RING_MS = 1150;        // 圆环扩散动画时长
  const HOLD_MS = 1250;        // 高亮总保留时长，动画结束后整体移除
  let activeEl = null;

  const make = (x, y) => {
    const root = document.createElement('div');
    root.setAttribute('data-op-click-highlight', '');
    root.style.cssText = [
      'position:fixed',
      'left:' + x + 'px',
      'top:' + y + 'px',
      'width:0',
      'height:0',
      'z-index:2147483647',
      'pointer-events:none',
    ].join(';');

    // 中心圆点：红色填充 + 白色描边 + 微弱黑边，明暗背景下都可辨识
    const dot = document.createElement('div');
    dot.setAttribute('data-op-click-dot', '');
    dot.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'width:14px',
      'height:14px',
      'margin-left:-7px',
      'margin-top:-7px',
      'border-radius:50%',
      'background:#ff2d2d',
      'border:2px solid rgba(255,255,255,0.85)',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.25)',
    ].join(';');

    // 扩散圆环：红色主环以根元素为圆心向外扩散并淡出
    const ring = document.createElement('div');
    ring.setAttribute('data-op-click-ring', '');
    ring.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'width:36px',
      'height:36px',
      'margin-left:-18px',
      'margin-top:-18px',
      'border-radius:50%',
      'border:3px solid #ff2d2d',
      'opacity:1',
      'animation:opClickRing ' + RING_MS + 'ms ease-out forwards',
    ].join(';');

    root.appendChild(dot);
    root.appendChild(ring);
    document.documentElement.appendChild(root);
    return root;
  };

  // 动画关键帧单例注入：首次点击时才注入（init script 执行时 document.head 尚为 null）
  const ensureKeyframes = () => {
    if (document.getElementById('opClickRingKeyframes')) return;
    const style = document.createElement('style');
    style.id = 'opClickRingKeyframes';
    style.textContent =
      '@keyframes opClickRing{from{transform:scale(1);opacity:1}' +
      'to{transform:scale(' + RING_SCALE_END + ');opacity:0}}';
    document.head.appendChild(style);
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return; // 仅主键（触摸/触控笔主触点同样为 0，天然覆盖）
      ensureKeyframes();
      const el = make(e.clientX, e.clientY);
      if (activeEl) activeEl.remove(); // 快速连点时新亮点替换旧亮点，DOM 中始终只有一个
      activeEl = el;
      setTimeout(() => {
        if (activeEl === el) {
          el.remove();
          activeEl = null;
        }
      }, HOLD_MS);
    },
    true, // 捕获阶段：即使目标页在任意监听器中 stopPropagation 也能先一步绘制
  );
})();
`;