/**
 * 「@执行bot /<cmd> @目标…」形态元命令的共享 mention 解析。
 *
 * `/grant`、`/invite` 这类命令的同一种 mention 语义：
 *  - 命令词**之前**的 @ 是「点名让哪个 bot 执行」——不是目标（多 bot 群里
 *    owner 常同时 @ 多个操作 bot，位置过滤走错会把操作 bot 当目标，实测踩过：
 *    两 bot 互相 grant）；
 *  - 命令词**之后**的 @ 才是目标；排除执行 bot 自身；
 *  - text 形态（content.text 里是 key 占位符）与 post 富文本形态（inline at
 *    节点、message.mentions 常为空）都要支持；位置信息缺失的合成消息退回
 *    「全部非本 bot mention」的历史宽松行为。
 *
 * 从 grant-command.ts 提炼泛化（2026-07 /invite 落地时）；grant 的对外导出
 * （parseGrantTargets / isGrantTargetOnly / stripAllMentions）保持原样委托到这里。
 */
import { mentionOpenId } from './message-parser.js';

/** 命令正则必须带 `\b` 边界、不带 g 标志（exec/index 语义依赖）。 */
export type CommandPattern = RegExp;

export interface MentionTarget { openId: string; name: string }

/**
 * 从 mention 列表取「cmdPattern 匹配的命令词之后」出现的所有非本 bot @，按
 * open_id 去重、保持 @ 顺序（支持一次命令带多目标）。
 */
export function parseTargetsAfterCommand(
  message: any, botOpenId: string | undefined, cmdPattern: CommandPattern,
): MentionTarget[] {
  let content: any;
  try { content = JSON.parse(message?.content ?? '{}'); } catch { content = undefined; }

  // text 形态：@ 落在 content.text 里，每个 mention 带 key 占位符可定位其位置 → 按命令词位置过滤。
  if (content && typeof content.text === 'string') {
    return parseTextTargetsAfterCommand(content.text, message?.mentions ?? [], botOpenId, cmdPattern);
  }
  // post（富文本）形态：@ 落在 inline `at` 节点（message.mentions 常为空、偶有填充，统一走节点序）→
  // 按命令词节点位置过滤，不被「message.mentions 是否填充」左右。
  const inner = content?.zh_cn ?? content?.en_us ?? content;
  if (Array.isArray(inner?.content)) {
    return parsePostAtMentions(message, botOpenId, cmdPattern);
  }

  // 合成消息（仅 mentions、无 content 结构，多见于单测/旧调用）：无位置信息，退回全部非本 bot。
  const seen = new Set<string>();
  const out: MentionTarget[] = [];
  for (const x of (message?.mentions ?? [])) {
    const oid = mentionOpenId(x);
    if (!oid || oid === botOpenId || seen.has(oid)) continue;
    seen.add(oid);
    out.push({ openId: oid, name: x.name ?? oid });
  }
  return out;
}

/** text 形态：只取「命令词之后」的非本 bot mention。用 mention 的 key 占位符定位其在 text 里的
 *  位置；`key(?!\d)` 边界规避 @_user_1 / @_user_10 前缀歧义（与 isCommandTargetOnly 同款）。
 *  定位不到 key（异常形态）时保守退回「视为目标」，与历史行为一致，不漏真实 target。 */
function parseTextTargetsAfterCommand(
  text: string, mentions: any[], botOpenId: string | undefined, cmdPattern: CommandPattern,
): MentionTarget[] {
  const cmdIdx = text.search(cmdPattern);
  const seen = new Set<string>();
  const out: MentionTarget[] = [];
  for (const m of mentions) {
    const oid = mentionOpenId(m);
    if (!oid || oid === botOpenId || seen.has(oid)) continue;
    const key = m?.key;
    if (cmdIdx >= 0 && typeof key === 'string' && key.length > 0) {
      const km = new RegExp(`${escapeRe(key)}(?!\\d)`).exec(text);
      if (km && km.index <= cmdIdx) continue;   // 命令词之前 = 操作 bot 点名，剔除
    }
    seen.add(oid);
    out.push({ openId: oid, name: m.name ?? oid });
  }
  return out;
}

/** 从 post inline `at` 节点取非本 bot 的目标（user_name 兜 name），按 user_id 去重、保持顺序。
 *  同 text 形态：只收「命令词文本节点之后」的 `at` 节点（前导 @ 是操作 bot 点名，剔除）。 */
function parsePostAtMentions(message: any, botOpenId: string | undefined, cmdPattern: CommandPattern): MentionTarget[] {
  const seen = new Set<string>();
  const out: MentionTarget[] = [];
  let content: any;
  try { content = JSON.parse(message?.content ?? '{}'); } catch { return out; }
  const inner = content?.zh_cn ?? content?.en_us ?? content;
  if (!Array.isArray(inner?.content)) return out;
  // 先定位命令词文本节点的序号，再只收其后的 at 节点。
  let seq = 0, cmdSeq = -1;
  const ats: Array<{ oid: string; name: string; seq: number }> = [];
  for (const para of inner.content) {
    if (!Array.isArray(para)) continue;
    for (const node of para) {
      if (cmdSeq < 0 && node?.tag === 'text' && cmdPattern.test(node.text ?? '')) cmdSeq = seq;
      if (node?.tag === 'at' && node.user_id) ats.push({ oid: node.user_id, name: node.user_name ?? node.user_id, seq });
      seq++;
    }
  }
  for (const a of ats) {
    if (a.oid === botOpenId || seen.has(a.oid)) continue;
    if (cmdSeq >= 0 && a.seq <= cmdSeq) continue;   // 命令词之前 = 操作 bot 点名，剔除
    seen.add(a.oid);
    out.push({ openId: a.oid, name: a.name });
  }
  return out;
}

/**
 * 本 bot 是否「只是作为命令的目标」被 @（@ 出现在命令词之后），而不是被前导 @
 * 点名执行命令的操作 bot。命中（仅目标）返回 true，调用方应静默放手——否则
 * 目标 bot 会误回 owner_only / 把自己剔空后误执行。
 *
 * text 与 post（富文本）两种消息形态都覆盖（同 parseTargetsAfterCommand）：
 *  - text：{"text":"@_user_1 /cmd @_user_2"}，@ 是占位符 key；用「key 后不接数字」
 *    的边界锁定整 token，规避 @_user_1 / @_user_10 这类 key 前缀歧义。
 *  - post：@ 是独立的 `at` 节点（不在 text 里、mentions 可能为空），按文档节点
 *    顺序比较本 bot 的 `at` 节点与含命令词的 text 节点的先后。
 */
export function isCommandTargetOnly(message: any, botOpenId: string | undefined, cmdPattern: CommandPattern): boolean {
  if (!botOpenId) return false;
  let content: any;
  try { content = JSON.parse(message?.content ?? '{}'); } catch { return false; }

  if (typeof content?.text === 'string') {
    const key = (message?.mentions ?? []).find((m: any) => mentionOpenId(m) === botOpenId)?.key;
    if (!key) return false;
    const cmdIdx = content.text.search(cmdPattern);
    const keyMatch = new RegExp(`${escapeRe(key)}(?!\\d)`).exec(content.text);
    const myIdx = keyMatch ? keyMatch.index : -1;
    return cmdIdx >= 0 && myIdx > cmdIdx;
  }

  const inner = content?.zh_cn ?? content?.en_us ?? content;
  if (Array.isArray(inner?.content)) {
    let seq = 0, cmdSeq = -1, mySeq = -1;
    for (const para of inner.content) {
      if (!Array.isArray(para)) continue;
      for (const node of para) {
        if (cmdSeq < 0 && node?.tag === 'text' && cmdPattern.test(node.text ?? '')) cmdSeq = seq;
        if (mySeq < 0 && node?.tag === 'at' && node.user_id === botOpenId) mySeq = seq;
        seq++;
      }
    }
    return cmdSeq >= 0 && mySeq > cmdSeq;
  }
  return false;
}

/** 把文本里所有 `@<name>` mention token 去掉（split/join，防正则注入），归一空白后 trim。 */
export function stripAllMentions(text: string, mentions: any[]): string {
  let s = text;
  for (const m of mentions ?? []) {
    const name = m?.name;
    if (typeof name === 'string' && name.length) s = s.split(`@${name}`).join(' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
