import type { JiraUser } from './types';

export function userName(u: unknown): string {
  const user = u as JiraUser | null | undefined;
  return user?.displayName || user?.name || '';
}

export function relativeTime(iso?: string, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatDate(iso);
}

export function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 自定义字段值转为展示文本；无法识别的结构返回 null，交由调用方跳过 */
export function fieldText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(fieldText).filter((x): x is string => !!x);
    return parts.length ? parts.join('、') : null;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.displayName === 'string') return v.displayName;
    // 级联选择：{ value, child: { value } }
    if (typeof v.value === 'string') {
      const child = v.child ? fieldText(v.child) : null;
      return child ? `${v.value} / ${child}` : v.value;
    }
    if (typeof v.name === 'string') return v.name;
  }
  return null;
}

/** 清洗 Jira 渲染出的 HTML：去掉脚本、事件属性和 javascript: 链接，相对地址补全到 Jira */
export function sanitizeHtml(html: string, jiraBase: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,link,meta,base').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'src') {
        const val = attr.value.trim();
        if (/^(javascript|data|vbscript):/i.test(val)) {
          el.removeAttribute(attr.name);
        } else if (val.startsWith('/')) {
          el.setAttribute(attr.name, jiraBase + val);
        }
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return doc.body.innerHTML;
}
