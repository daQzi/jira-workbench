import { PARENT_LINK_TYPE } from './tree';

// Jira 链接方向（已在本 Jira 上实测）：
// - 新建时 update.issuelinks.add.outwardIssue = X  => 新问题 [outward 动词] X（如 新问题 blocks X）
// - 新建时 update.issuelinks.add.inwardIssue  = X  => X [outward 动词] 新问题
// - POST issueLink {inwardIssue: A, outwardIssue: B} => A [outward 动词] B

export interface LinkTypeDef {
  name: string;
  inward: string;
  outward: string;
}

/** 一个可选的关系：链接类型 + 当前问题处于哪一端 */
export interface LinkOption {
  id: string; // `${type}:${dir}`
  type: string;
  /** out：当前问题 [outward] 目标；in：目标 [outward] 当前问题 */
  dir: 'out' | 'in';
  label: string;
  /** 一句话解释，显示在下拉框下方 */
  hint: string;
}

// 常用链接类型的通俗说法，统一按「当前问题 ___ 目标问题」来读；未知类型用 Jira 自带描述
// order 越小越靠前：日常最常用的「相关」放第一
const ZH: Record<string, { order: number; out: string; in: string; outHint: string; inHint: string }> = {
  Relates: { order: 0, out: '相关', in: '相关', outHint: '两者有关系，方便互相查看，没有先后约束', inHint: '两者有关系，方便互相查看，没有先后约束' },
  Blocks: { order: 1, out: '卡住它', in: '被它卡住', outHint: '对方要等当前这条做完才能继续', inHint: '当前这条要等对方做完才能继续' },
  Duplicate: { order: 2, out: '与它重复', in: '被它重复', outHint: '当前这条和对方是同一件事，当前这条是多余的', inHint: '对方和当前这条是同一件事，对方是多余的' },
  Cloners: { order: 3, out: '复制自它', in: '被复制为它', outHint: '当前这条是从对方复制出来的', inHint: '对方是从当前这条复制出来的' },
};

/** 链接在「当前问题」视角下的通俗说法；dir=in 表示对方在 Jira 里是 inwardIssue */
export function relationLabel(type: string, dir: 'out' | 'in', fallback: string): string {
  const zh = ZH[type];
  return zh ? zh[dir] : fallback;
}

/** 普通关联选项（父子关系单独处理，不在这里出现） */
export function linkOptions(types: LinkTypeDef[]): LinkOption[] {
  const out: LinkOption[] = [];
  const rank = (t: LinkTypeDef) => ZH[t.name]?.order ?? 99;
  const sorted = [...types].sort((a, b) => rank(a) - rank(b));
  for (const t of sorted) {
    const zh = ZH[t.name];
    out.push({ id: `${t.name}:out`, type: t.name, dir: 'out', label: zh?.out ?? t.outward, hint: zh?.outHint ?? '' });
    // 对称关系（relates to）只保留一个方向
    if (t.inward !== t.outward) {
      out.push({ id: `${t.name}:in`, type: t.name, dir: 'in', label: zh?.in ?? t.inward, hint: zh?.inHint ?? '' });
    }
  }
  return out;
}

export interface PendingLink {
  option: Pick<LinkOption, 'type' | 'dir'>;
  key: string;
}

/** 父子：子项 blocks 父需求 */
export const PARENT_OPTION: Pick<LinkOption, 'type' | 'dir'> = { type: PARENT_LINK_TYPE, dir: 'out' };
export const CHILD_OPTION: Pick<LinkOption, 'type' | 'dir'> = { type: PARENT_LINK_TYPE, dir: 'in' };

/** 新建时随请求提交的 update.issuelinks */
export function createLinkUpdates(links: PendingLink[]) {
  return links.map((l) => ({
    add: {
      type: { name: l.option.type },
      ...(l.option.dir === 'out' ? { outwardIssue: { key: l.key } } : { inwardIssue: { key: l.key } }),
    },
  }));
}

/** 已有问题之间建链接的 POST issueLink 请求体 */
export function issueLinkBody(currentKey: string, link: PendingLink) {
  const [a, b] = link.option.dir === 'out' ? [currentKey, link.key] : [link.key, currentKey];
  return { type: { name: link.option.type }, inwardIssue: { key: a }, outwardIssue: { key: b } };
}

/** 去重：同类型同方向同目标只保留一条 */
export function dedupeLinks(links: PendingLink[]): PendingLink[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = `${l.option.type}:${l.option.dir}:${l.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
