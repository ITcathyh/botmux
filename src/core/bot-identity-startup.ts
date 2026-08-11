import type { BotConfig } from '../bot-registry.js';
import type {
  BotExternalAddress,
  BotIdentityBinding,
  BotIdentityControlPlane,
  BotIdentityStatus,
} from '../services/bot-identity-control-plane.js';
import { createBotIdentityControlPlane } from '../services/bot-identity-control-plane.js';
import type { BotsConfigProvenance } from './config-dir.js';

export type BotIdentityStartupAction = 'report' | 'apply' | 'repair';

/** Typed startup refusal so daemon/CLI adapters can render actionable guidance. */
export class BotIdentityStartupBlockedError extends Error {
  readonly action: BotIdentityStartupAction;
  readonly operationId?: string;
  readonly status: BotIdentityStatus;

  constructor(status: BotIdentityStatus) {
    const action: BotIdentityStartupAction = status.kind === 'unmigrated'
      ? 'report'
      : status.kind === 'planned' ? 'apply' : 'repair';
    const operationId = status.kind === 'planned' || status.kind === 'ready'
      ? status.operationId
      : status.kind === 'needsRepair' ? status.operationId : undefined;
    const command = action === 'report'
      ? 'botmux identity report'
      : `botmux identity ${action}${operationId ? ` ${operationId}` : ''} --yes`;
    super(`stable Bot identity is not ready; run \`${command}\``);
    this.name = 'BotIdentityStartupBlockedError';
    this.action = action;
    this.operationId = operationId;
    this.status = status;
  }
}

export function botIdentityAddressForConfig(
  config: Pick<BotConfig, 'apiOnly' | 'larkAppId'>,
): BotExternalAddress {
  return config.apiOnly === true
    ? { kind: 'coreOnly', launchId: config.larkAppId }
    : { kind: 'lark', larkAppId: config.larkAppId };
}

/**
 * Read-only daemon startup gate. Identity allocation and promotion remain
 * explicit operator actions through report/apply/repair.
 */
export function requireReadyDaemonBotIdentities(
  control: BotIdentityControlPlane,
  configs: readonly Pick<BotConfig, 'apiOnly' | 'larkAppId'>[],
): ReadonlyMap<string, BotIdentityBinding> {
  const status = control.status();
  if (status.kind !== 'ready') throw new BotIdentityStartupBlockedError(status);
  const identities = new Map<string, BotIdentityBinding>();
  for (const config of configs) {
    if (identities.has(config.larkAppId)) {
      throw new Error(`duplicate daemon bot config identity: ${config.larkAppId}`);
    }
    identities.set(
      config.larkAppId,
      control.resolveActive(botIdentityAddressForConfig(config)),
    );
  }
  return identities;
}

/** Stable, secret-free authority bytes for a core-only root without bots.json. */
export function coreOnlyBotIdentityAuthorityBytes(
  configs: readonly Pick<BotConfig, 'apiOnly' | 'cliId' | 'larkAppId'>[],
): string {
  return `${JSON.stringify(configs.map(config => ({
    larkAppId: config.larkAppId,
    apiOnly: config.apiOnly === true,
    cliId: config.cliId,
  })), null, 2)}\n`;
}

export function createDaemonBotIdentityControlPlane(input: {
  readonly dataDir: string;
  readonly configPath: string | undefined;
  readonly configProvenance: BotsConfigProvenance | undefined;
  readonly configs: readonly Pick<BotConfig, 'apiOnly' | 'cliId' | 'larkAppId'>[];
}): BotIdentityControlPlane {
  if (input.configProvenance === 'loaded' && input.configPath) {
    return createBotIdentityControlPlane({
      dataDir: input.dataDir,
      configPath: input.configPath,
    });
  }
  if (input.configProvenance === 'synthetic'
    && input.configs.length === 1
    && input.configs[0]?.apiOnly === true) {
    const authorityBytes = coreOnlyBotIdentityAuthorityBytes(input.configs);
    return createBotIdentityControlPlane({
      dataDir: input.dataDir,
      readOnlyConfigBytes: () => authorityBytes,
    });
  }
  throw new Error('daemon Bot identity config authority is unresolved; fail closed');
}
