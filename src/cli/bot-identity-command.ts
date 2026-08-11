import { readFileSync } from 'node:fs';

import type { BotIdentityControlPlane } from '../services/bot-identity-control-plane.js';

export interface BotIdentityCommandResult {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function usage(): BotIdentityCommandResult {
  return {
    code: 2,
    stdout: '',
    stderr: 'Usage: botmux identity status|report [--target-config PATH]|apply <operation> --yes|repair [operation] --yes|rollback [operation] --yes\n',
  };
}

function operationArg(args: readonly string[]): string | undefined {
  return args.slice(1).find(value => !value.startsWith('-'));
}

export function runBotIdentityCommand(
  args: readonly string[],
  deps: {
    readonly control: BotIdentityControlPlane;
    readonly assertMutationSafe?: () => void;
  },
): BotIdentityCommandResult {
  const subcommand = args[0] ?? 'status';
  try {
    if (subcommand === 'status') {
      return { code: 0, stdout: json(deps.control.status()), stderr: '' };
    }
    if (subcommand === 'report') {
      const targetIndex = args.indexOf('--target-config');
      if (targetIndex >= 0 && !args[targetIndex + 1]) return usage();
      const targetBytes = targetIndex >= 0
        ? readFileSync(args[targetIndex + 1]!, 'utf8')
        : undefined;
      const plan = deps.control.report(targetBytes);
      return {
        code: 0,
        stdout: json({
          kind: 'planned',
          operationId: plan.operationId,
          source: plan.source,
          target: plan.target,
          targetRevision: plan.targetRegistry.revision,
        }),
        stderr: '',
      };
    }
    if (subcommand === 'apply' || subcommand === 'repair' || subcommand === 'rollback') {
      if (!args.includes('--yes')) {
        return {
          code: 2,
          stdout: '',
          stderr: `botmux identity ${subcommand} mutates durable identity state; pass --yes\n`,
        };
      }
      deps.assertMutationSafe?.();
      const operationId = operationArg(args);
      if (subcommand === 'apply') {
        if (!operationId) return usage();
        const receipt = deps.control.apply(operationId);
        return { code: 0, stdout: json({ kind: 'complete', ...receipt }), stderr: '' };
      }
      if (subcommand === 'repair') {
        const receipt = deps.control.repair(operationId);
        return { code: 0, stdout: json({ kind: 'complete', ...receipt }), stderr: '' };
      }
      return {
        code: 0,
        stdout: json(deps.control.rollback(operationId)),
        stderr: '',
      };
    }
    return usage();
  } catch (error) {
    return {
      code: 1,
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
