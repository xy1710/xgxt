/**
 * toast —— 原型 #toastW / .toast 的等价实现
 *
 * 原型的 toast() 是往 #toastW 里 append 一个 .toast 节点，3 秒后淡出移除。
 * 这里保持完全一样的 DOM 结构与生命周期，所以样式（prototype.css 里的
 * #toastW / .toast / .toast.ok / .toast.err / .toast.warn）直接复用，视觉 1:1。
 *
 * 用法：toast('已保存')  /  toast('保存失败', 'err')  /  toast('请注意', 'warn')
 */

export type ToastType = 'ok' | 'err' | 'warn';

/** 极简 HTML 转义（toast 内容可能带用户输入的职位名、部门名） */
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 取（或按需创建）全局 toast 容器 */
function container(): HTMLElement {
  let w = document.getElementById('toastW');
  if (!w) {
    w = document.createElement('div');
    w.id = 'toastW';
    document.body.appendChild(w);
  }
  return w;
}

export function toast(msg: string, type: ToastType = 'ok'): void {
  const w = container();
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  const ic = type === 'err' ? '✕' : type === 'warn' ? '⚠' : '✓';
  d.innerHTML = `<span>${ic}</span><span>${esc(msg)}</span>`;
  w.appendChild(d);

  window.setTimeout(() => {
    d.style.transition = '.3s';
    d.style.opacity = '0';
    d.style.transform = 'translateY(-12px)';
    window.setTimeout(() => d.remove(), 300);
  }, 2400);
}

export default toast;
