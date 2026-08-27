/** 注入所有页面：监听用户交互事件并置脏标记，供录制器轮询截图 */
export const ACTIVITY_INJECT_SCRIPT = `
(() => {
  const flagKey = '__opRecorderDirty';
  window[flagKey] = false;
  const mark = () => { window[flagKey] = true; };
  for (const evt of ['click', 'keydown', 'wheel', 'input', 'change', 'submit']) {
    document.addEventListener(evt, mark, true);
  }
})();
`;