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
    stderr: 'Usage: botmux identity status|report|apply <operation> --yes|repair [operation] --yes|rollback [operation] --yes\n',
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
      // Identity follows the config authority: the plan is always derived from
      // the live bots.json / launch descriptor. Editing the bot set belongs to
      // setup/config flows (owner-identity enforced), never to this command —
      // reject extra arguments (notably the retired --target-config) instead
      // of silently ignoring them.
      if (args.length > 1) return usage();
      const plan = deps.control.report();
      return {
        code: 0,
        stdout: json({
          kind: 'planned',
          operationId: plan.operationId,
          targetRevision: plan.targetRegistry.revision,
          activeAddresses: plan.targetRegistry.bindings
            .filter(binding => binding.status === 'active')
            .map(binding => binding.address),
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
