import { describe, expect, it } from 'vitest';
import { buildTraexInitializationCard } from '../src/im/lark/traex-initialization-card.js';
import type { PendingTraexInitialization } from '../src/core/traex-initialization.js';
import type { ProjectInfo } from '../src/services/project-scanner.js';

function walk(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  out.push(record);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, out));
    else if (value && typeof value === 'object') walk(value, out);
  }
  return out;
}

describe('TraeX 统一初始化卡', () => {
  const pending: PendingTraexInitialization = {
    nonce: 'nonce-1',
    ownerOpenId: 'ou_owner',
    originalPrompt: '帮我实现统一初始化卡',
    promptPrefix: '',
    selection: {
      kind: 'directory',
      path: '/repo/alpha',
      label: 'alpha (main)',
      pinWorkingDir: true,
    },
  };
  const projects: ProjectInfo[] = [
    { name: 'alpha', path: '/repo/alpha', type: 'repo', branch: 'main' },
    { name: 'beta', path: '/repo/beta', type: 'worktree', branch: 'feat/beta' },
  ];

  it('同一张卡包含选仓、worktree、手动目录、提示词和三种启动按钮', () => {
    const card = JSON.parse(buildTraexInitializationCard({
      rootId: 'om_root',
      pending,
      projects,
      locale: 'zh',
    }));
    const nodes = walk(card);

    const target = nodes.find(node => node.tag === 'select_static' && node.name === 'traex_init_target');
    expect(target).toBeDefined();
    expect((target?.options as Array<Record<string, unknown>>).map(option => option.value))
      .toEqual(['dir:/repo/alpha', 'dir:/repo/beta', 'worktree:/repo/alpha']);
    expect(nodes.find(node => node.tag === 'input' && node.name === 'traex_init_manual_path')).toBeDefined();
    expect(nodes.find(node => node.tag === 'input' && node.name === 'initial_prompt')).toMatchObject({
      default_value: pending.originalPrompt,
      input_type: 'multiline_text',
    });

    const modes = nodes
      .filter(node => node.action_type === 'form_submit')
      .map(node => (node.value as Record<string, unknown>)?.mode);
    expect(modes).toEqual(['traex', 'forge-pipeline', 'forge-pilot']);
  });

  it('仓库、worktree、目录和提示词都在同一个表单内一次提交', () => {
    const card = JSON.parse(buildTraexInitializationCard({
      rootId: 'om_root',
      pending,
      projects,
      locale: 'zh',
    }));
    const nodes = walk(card);
    const form = nodes.find(node => node.tag === 'form' && node.name === 'traex_initialization_form')!;
    const formNodes = walk(form);

    expect(formNodes.find(node => node.tag === 'select_static' && node.name === 'traex_init_target')).toBeDefined();
    expect(formNodes.find(node => node.tag === 'input' && node.name === 'traex_init_manual_path')).toBeDefined();
    expect(formNodes.find(node => node.tag === 'input' && node.name === 'initial_prompt')).toBeDefined();
  });
});
