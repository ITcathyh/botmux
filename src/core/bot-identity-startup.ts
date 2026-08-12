import type { BotConfig } from '../bot-registry.js';
import type {
  BotExternalAddress,
  BotIdentityBinding,
  BotIdentityControlPlane,
  BotIdentityStatus,
} from '../services/bot-identity-control-plane.js';
import { createBotIdentityControlPlane } from '../services/bot-identity-control-plane.js';
import { logger } from '../utils/logger.js';
import type { BotsConfigProvenance } from './config-dir.js';

export type BotIdentityStartupAction = 'report' | 'apply' | 'repair';

/** Typed startup refusal so daemon/CLI adapters can render actionable guidance. */
export class BotIdentityStartupBlockedError extends Error {
  readonly action: BotIdentityStartupAction;
  readonly operationId?: string;
  readonly status: BotIdentityStatus;

  constructor(status: BotIdentityStatus) {
    // needsPromotion = registry truth intact but the active address set moved
    // on; the fix is a fresh report+apply cycle, never repair (repair only
    // converges registry artifacts and would not absorb the new address set).
    const action: BotIdentityStartupAction = status.kind === 'unmigrated' || status.kind === 'needsPromotion'
      ? 'report'
      : status.kind === 'planned' ? 'apply' : 'repair';
    const operationId = status.kind === 'unmigrated' ? undefined : status.operationId;
    const command = action === 'report'
      ? 'botmux identity report && botmux identity apply <operation> --yes'
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
 * Daemon startup gate with first-boot auto-migration: a virgin (unmigrated)
 * root is bootstrapped in place so a fresh install or a first upgrade onto
 * the identity control plane can boot without an operator step. Every other
 * non-ready state still fails closed into the explicit report/apply/repair
 * flow.
 */
export function ensureReadyDaemonBotIdentities(
  control: BotIdentityControlPlane,
  configs: readonly Pick<BotConfig, 'apiOnly' | 'larkAppId'>[],
): ReadonlyMap<string, BotIdentityBinding> {
  // The lock-free sample is only a fast path for the one stable kind: `ready`
  // never regresses concurrently (operator identity mutations require an
  // offline fleet). Every other kind — including the transient mid-promotion
  // states a sibling daemon's in-flight bootstrap makes visible — must be
  // re-derived under the control lock inside bootstrap(), never judged here.
  if (control.status().kind !== 'ready') {
    const after = control.bootstrap();
    if (after.kind === 'ready') {
      logger.info(
        `[bot-identity] stable Bot identity ready after first-boot bootstrap `
        + `(operation=${after.operationId}, revision=${after.revision})`,
      );
    }
  }
  return requireReadyDaemonBotIdentities(control, configs);
}

/**
 * Read-only daemon startup gate. Identity allocation and promotion remain
 * explicit operator actions through report/apply/repair; first-boot
 * auto-migration composes in via ensureReadyDaemonBotIdentities.
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

/**
 * Stable, secret-free authority bytes for a core-only root without bots.json.
 * Address fields only: env-derived launch knobs (cliId, model, workingDir) are
 * mutable operator choices and must never shift the identity projection.
 */
export function coreOnlyBotIdentityAuthorityBytes(
  configs: readonly Pick<BotConfig, 'apiOnly' | 'larkAppId'>[],
): string {
  return `${JSON.stringify(configs.map(config => ({
    larkAppId: config.larkAppId,
    apiOnly: config.apiOnly === true,
  })), null, 2)}\n`;
}

export function createDaemonBotIdentityControlPlane(input: {
  readonly dataDir: string;
  readonly configPath: string | undefined;
  readonly configProvenance: BotsConfigProvenance | undefined;
  readonly configs: readonly Pick<BotConfig, 'apiOnly' | 'larkAppId'>[];
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
