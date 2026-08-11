import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBotIdentityCommand } from '../src/cli/bot-identity-command.js';
import { createBotIdentityControlPlane } from '../src/services/bot-identity-control-plane.js';

describe('bot identity operator command', () => {
  let root: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-identity-cli-'));
    configPath = join(root, 'bots.json');
    writeFileSync(configPath, `${JSON.stringify([{
      larkAppId: 'cli_identity_command',
      larkAppSecret: 'must-not-leak',
    }])}\n`);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('provides explicit report/apply/status without leaking config snapshots', () => {
    const control = createBotIdentityControlPlane({
      dataDir: root,
      configPath,
      allocateBotId: () => 'bot_identity_command',
      allocateOperationId: () => 'op_identity_command',
    });
    const reported = runBotIdentityCommand(['report'], { control });
    expect(reported).toMatchObject({ code: 0 });
    expect(reported.stdout).toContain('op_identity_command');
    expect(reported.stdout).not.toContain('must-not-leak');

    expect(runBotIdentityCommand(['apply', 'op_identity_command'], { control }))
      .toMatchObject({ code: 2, stderr: expect.stringMatching(/--yes/) });
    expect(runBotIdentityCommand(['apply', 'op_identity_command', '--yes'], {
      control,
      assertMutationSafe: () => { throw new Error('daemon still online'); },
    })).toMatchObject({ code: 1, stderr: expect.stringMatching(/daemon still online/) });
    expect(runBotIdentityCommand(['apply', 'op_identity_command', '--yes'], { control }))
      .toMatchObject({ code: 0 });
    expect(JSON.parse(runBotIdentityCommand(['status'], { control }).stdout))
      .toMatchObject({ kind: 'ready', revision: 1 });
  });
});
