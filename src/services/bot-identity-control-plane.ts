import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  parseBotId,
  sessionActorRef,
  type ActorRef,
  type BotId,
} from '../core/bot-identity.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { fsyncDirectorySyncPortable } from '../utils/fs-durability.js';
import { withFileLockSync } from '../utils/file-lock.js';

export type BotExternalAddress =
  | { readonly kind: 'lark'; readonly larkAppId: string }
  | { readonly kind: 'coreOnly'; readonly launchId: string };

export interface BotIdentityBinding {
  readonly botId: BotId;
  readonly status: 'active' | 'retired';
  readonly address: BotExternalAddress;
  /** Current JSON file adapter continues to address historical files by this key. */
  readonly legacyOwnerLarkAppId?: string;
}

export interface BotIdentityRegistry {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly operationId: string;
  readonly bindings: readonly BotIdentityBinding[];
}

/**
 * Identity only follows the ACTIVE ADDRESS SET of the config authority — never
 * its full bytes. Display names, secrets, per-bot runtime store fields and any
 * other mutable configuration are outside the identity plane by design (design
 * doc: "显示名、secret 等不改变 BotId"), so the control plane digests a canonical
 * secret-free projection instead of bots.json bytes, and it NEVER writes the
 * config authority: bots.json mutation stays with setup/config flows that
 * enforce the owner-identity boundary.
 */
export interface BotIdentityPlan {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly createdAt: string;
  /** Canonical secret-free active-address projection this plan was minted for. */
  readonly identityProjection: string;
  readonly source: {
    readonly registryDigest: string | null;
  };
  readonly target: {
    readonly registryDigest: string;
  };
  readonly sourceRegistryBytes: string | null;
  readonly targetRegistry: BotIdentityRegistry;
}

export interface BotIdentityIntent {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly planDigest: string;
  readonly preparedAt: string;
}

export type BotIdentityPromotionPhase =
  | 'intentPrepared'
  | 'registryPublished'
  | 'receiptPublished';

export interface BotIdentityReceipt {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly registryDigest: string;
  readonly projectionDigest: string;
  readonly completedAt: string;
}

export type BotIdentityStatus =
  | { readonly kind: 'unmigrated' }
  | { readonly kind: 'planned'; readonly operationId: string }
  | { readonly kind: 'ready'; readonly revision: number; readonly operationId: string }
  /** Registry truth is intact but the config's active address set moved on. */
  | { readonly kind: 'needsPromotion'; readonly revision: number; readonly operationId: string }
  | { readonly kind: 'needsRepair'; readonly reason: string; readonly operationId?: string };

export interface BotIdentityControlPlaneOptions {
  readonly dataDir: string;
  /** Exact mutable bots.json authority for a transport-backed fleet root. */
  readonly configPath?: string;
  /** Exact immutable launch descriptor for a core-only root without bots.json. */
  readonly readOnlyConfigBytes?: () => string;
  readonly allocateBotId?: () => string;
  readonly allocateOperationId?: () => string;
  readonly now?: () => string;
  /** Deterministic process-death seam for commit-protocol fault gates. */
  readonly afterPhase?: (phase: BotIdentityPromotionPhase) => void;
}

export interface BotIdentityControlPlane {
  /** Create and durably persist an immutable plan; never publishes identity truth. */
  report(): BotIdentityPlan;
  /** Reentrant promotion of one immutable plan. Publishes registry truth only. */
  apply(operationId: string): BotIdentityReceipt;
  /** Converge registry truth to its receipted plan. Never touches the config authority. */
  repair(operationId?: string): BotIdentityReceipt;
  rollback(operationId?: string): BotIdentityStatus;
  status(): BotIdentityStatus;
  resolveActive(address: BotExternalAddress): BotIdentityBinding;
  actorRef(address: BotExternalAddress, sessionId: string): ActorRef;
}

function digest(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function addressKey(address: BotExternalAddress): string {
  return address.kind === 'lark'
    ? `lark\0${address.larkAppId}`
    : `coreOnly\0${address.launchId}`;
}

function parseActiveAddresses(configBytes: string): BotExternalAddress[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configBytes);
  } catch {
    throw new Error('bot identity source config is corrupt JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('bot identity source config must be an array');
  const addresses: BotExternalAddress[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`bot identity source config entry ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.apiOnly === true) {
      const launchId = candidate.larkAppId;
      if (typeof launchId !== 'string' || launchId.length === 0) {
        throw new Error(`bot identity source config entry ${index} lacks a core-only launch ID`);
      }
      addresses.push({ kind: 'coreOnly', launchId });
    } else {
      const larkAppId = candidate.larkAppId;
      if (typeof larkAppId !== 'string' || larkAppId.length === 0) {
        throw new Error(`bot identity source config entry ${index} lacks larkAppId`);
      }
      addresses.push({ kind: 'lark', larkAppId });
    }
    const key = addressKey(addresses.at(-1)!);
    if (seen.has(key)) throw new Error(`duplicate active bot address at entry ${index}`);
    seen.add(key);
  }
  return addresses;
}

/** Canonical secret-free projection: the sorted active address set, nothing else. */
function identityProjectionOf(configBytes: string): string {
  const addresses = [...parseActiveAddresses(configBytes)]
    .sort((left, right) => (addressKey(left) < addressKey(right) ? -1 : 1));
  return canonical(addresses);
}

function parseAddress(value: unknown): BotExternalAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('bot identity address must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'lark') {
    exactKeys(record, ['kind', 'larkAppId'], 'Lark bot identity address');
    if (typeof record.larkAppId !== 'string' || record.larkAppId.length === 0) {
      throw new Error('Lark bot identity address lacks larkAppId');
    }
    return { kind: 'lark', larkAppId: record.larkAppId };
  }
  if (record.kind === 'coreOnly') {
    exactKeys(record, ['kind', 'launchId'], 'core-only bot identity address');
    if (typeof record.launchId !== 'string' || record.launchId.length === 0) {
      throw new Error('core-only bot identity address lacks launchId');
    }
    return { kind: 'coreOnly', launchId: record.launchId };
  }
  throw new Error('unknown bot identity address kind');
}

function parseProjectionBytes(bytes: string): BotExternalAddress[] {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('bot identity projection is corrupt JSON'); }
  if (!Array.isArray(value)) throw new Error('bot identity projection must be an array');
  const seen = new Set<string>();
  const addresses = value.map(parseAddress);
  for (const address of addresses) {
    const key = addressKey(address);
    if (seen.has(key)) throw new Error(`duplicate address in bot identity projection: ${key}`);
    seen.add(key);
  }
  return addresses;
}

function parseRegistryBytes(bytes: string): BotIdentityRegistry {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('bot identity registry is corrupt JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('bot identity registry must be an object');
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, ['schemaVersion', 'revision', 'operationId', 'bindings'], 'bot identity registry');
  if (record.schemaVersion !== 1) throw new Error('unsupported bot identity registry schema');
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) {
    throw new Error('invalid bot identity registry revision');
  }
  if (typeof record.operationId !== 'string' || !/^op_[A-Za-z0-9_-]{2,128}$/.test(record.operationId)) {
    throw new Error('invalid bot identity registry operation ID');
  }
  if (!Array.isArray(record.bindings)) throw new Error('bot identity registry bindings must be an array');
  const ids = new Set<string>();
  const activeAddresses = new Set<string>();
  const bindings = record.bindings.map((raw, index): BotIdentityBinding => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`bot identity binding ${index} must be an object`);
    }
    const binding = raw as Record<string, unknown>;
    const hasLegacyOwner = Object.hasOwn(binding, 'legacyOwnerLarkAppId');
    exactKeys(
      binding,
      hasLegacyOwner ? ['botId', 'status', 'address', 'legacyOwnerLarkAppId'] : ['botId', 'status', 'address'],
      `bot identity binding ${index}`,
    );
    const botId = parseBotId(binding.botId);
    if (ids.has(botId)) throw new Error(`duplicate BotId: ${botId}`);
    ids.add(botId);
    if (binding.status !== 'active' && binding.status !== 'retired') {
      throw new Error(`invalid bot identity binding status at ${index}`);
    }
    const address = parseAddress(binding.address);
    if (hasLegacyOwner && (
      typeof binding.legacyOwnerLarkAppId !== 'string'
      || binding.legacyOwnerLarkAppId.length === 0
    )) {
      throw new Error(`invalid legacy owner at bot identity binding ${index}`);
    }
    if (address.kind === 'lark' && binding.legacyOwnerLarkAppId !== address.larkAppId) {
      throw new Error(`Lark bot identity binding ${index} changed its legacy owner`);
    }
    if (address.kind === 'coreOnly' && hasLegacyOwner) {
      throw new Error(`core-only bot identity binding ${index} cannot carry a Lark legacy owner`);
    }
    if (binding.status === 'active') {
      const key = addressKey(address);
      if (activeAddresses.has(key)) throw new Error(`duplicate active bot address: ${key}`);
      activeAddresses.add(key);
    }
    return {
      botId,
      status: binding.status,
      address,
      ...(hasLegacyOwner ? { legacyOwnerLarkAppId: binding.legacyOwnerLarkAppId as string } : {}),
    };
  });
  return {
    schemaVersion: 1,
    revision: record.revision as number,
    operationId: record.operationId,
    bindings,
  };
}

function activeAddressSet(registry: BotIdentityRegistry): Set<string> {
  return new Set(
    registry.bindings
      .filter(binding => binding.status === 'active')
      .map(binding => addressKey(binding.address)),
  );
}

function assertSameAddressSet(
  addresses: readonly BotExternalAddress[],
  registry: BotIdentityRegistry,
  label: string,
): void {
  const expected = new Set(addresses.map(addressKey));
  const actual = activeAddressSet(registry);
  if (expected.size !== actual.size || [...expected].some(key => !actual.has(key))) {
    throw new Error(`${label} active addresses do not match its identity projection`);
  }
}

function validateRegistryTransition(
  source: BotIdentityRegistry | null,
  target: BotIdentityRegistry,
  targetAddresses: readonly BotExternalAddress[],
): void {
  assertSameAddressSet(targetAddresses, target, 'target registry');
  if (source === null) {
    if (target.revision !== 1 || target.bindings.some(binding => binding.status !== 'active')) {
      throw new Error('initial bot identity target must be revision 1 with active bindings only');
    }
    return;
  }
  if (target.revision !== source.revision + 1) {
    throw new Error('bot identity target revision must advance exactly once');
  }
  const targetById = new Map(target.bindings.map(binding => [binding.botId, binding] as const));
  const sourceIds = new Set(source.bindings.map(binding => binding.botId));
  const targetAddressKeys = new Set(targetAddresses.map(addressKey));
  for (const prior of source.bindings) {
    const next = targetById.get(prior.botId);
    if (!next || addressKey(next.address) !== addressKey(prior.address)
      || next.legacyOwnerLarkAppId !== prior.legacyOwnerLarkAppId) {
      throw new Error(`bot identity ${prior.botId} was deleted or rebound`);
    }
    const expectedStatus = prior.status === 'retired'
      ? 'retired'
      : targetAddressKeys.has(addressKey(prior.address)) ? 'active' : 'retired';
    if (next.status !== expectedStatus) {
      throw new Error(`bot identity ${prior.botId} has an invalid lifecycle transition`);
    }
  }
  for (const binding of target.bindings) {
    if (!sourceIds.has(binding.botId) && binding.status !== 'active') {
      throw new Error(`new bot identity ${binding.botId} cannot start retired`);
    }
  }
}

function parsePlanBytes(bytes: string): BotIdentityPlan {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('bot identity plan is corrupt JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bot identity plan must be an object');
  const record = value as Record<string, unknown>;
  exactKeys(record, [
    'schemaVersion', 'operationId', 'createdAt', 'identityProjection',
    'source', 'target', 'sourceRegistryBytes', 'targetRegistry',
  ], 'bot identity plan');
  if (record.schemaVersion !== 1) throw new Error('unsupported bot identity plan schema');
  if (typeof record.operationId !== 'string' || !/^op_[A-Za-z0-9_-]{2,128}$/.test(record.operationId)) {
    throw new Error('invalid bot identity plan operation ID');
  }
  if (typeof record.createdAt !== 'string'
    || typeof record.identityProjection !== 'string'
    || (record.sourceRegistryBytes !== null && typeof record.sourceRegistryBytes !== 'string')) {
    throw new Error('invalid bot identity plan payload');
  }
  for (const [label, raw] of [['source', record.source], ['target', record.target]] as const) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid plan ${label}`);
    const part = raw as Record<string, unknown>;
    exactKeys(part, ['registryDigest'], `bot identity plan ${label}`);
    if (label === 'source'
      ? part.registryDigest !== null && typeof part.registryDigest !== 'string'
      : typeof part.registryDigest !== 'string') {
      throw new Error(`invalid bot identity plan ${label} digest`);
    }
  }
  const targetRegistryBytes = canonical(record.targetRegistry);
  const targetRegistry = parseRegistryBytes(targetRegistryBytes);
  const source = record.source as BotIdentityPlan['source'];
  const target = record.target as BotIdentityPlan['target'];
  if (targetRegistry.operationId !== record.operationId
    || digest(targetRegistryBytes) !== target.registryDigest
    || (record.sourceRegistryBytes === null
      ? source.registryDigest !== null
      : digest(record.sourceRegistryBytes) !== source.registryDigest)) {
    throw new Error('bot identity plan digest mismatch');
  }
  const sourceRegistry = record.sourceRegistryBytes === null
    ? null
    : parseRegistryBytes(record.sourceRegistryBytes);
  validateRegistryTransition(
    sourceRegistry,
    targetRegistry,
    parseProjectionBytes(record.identityProjection),
  );
  return record as unknown as BotIdentityPlan;
}

function parseReceiptBytes(bytes: string): BotIdentityReceipt {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('bot identity receipt is corrupt JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bot identity receipt must be an object');
  const record = value as Record<string, unknown>;
  exactKeys(record, ['schemaVersion', 'operationId', 'registryDigest', 'projectionDigest', 'completedAt'], 'bot identity receipt');
  if (record.schemaVersion !== 1 || typeof record.operationId !== 'string'
    || typeof record.registryDigest !== 'string' || typeof record.projectionDigest !== 'string'
    || typeof record.completedAt !== 'string') {
    throw new Error('invalid bot identity receipt');
  }
  return record as unknown as BotIdentityReceipt;
}

function parseIntentBytes(bytes: string): BotIdentityIntent {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('bot identity intent is corrupt JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bot identity intent must be an object');
  const record = value as Record<string, unknown>;
  exactKeys(record, ['schemaVersion', 'operationId', 'planDigest', 'preparedAt'], 'bot identity intent');
  if (record.schemaVersion !== 1 || typeof record.operationId !== 'string'
    || typeof record.planDigest !== 'string'
    || typeof record.preparedAt !== 'string') {
    throw new Error('invalid bot identity intent');
  }
  return record as unknown as BotIdentityIntent;
}

function writeImmutable(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const prior = readFileSync(path, 'utf8');
    if (prior === bytes) return;
    throw new Error(`immutable bot identity artifact already exists: ${path}`);
  }
  const staging = join(dirname(path), `.${randomUUID()}.immutable-staging`);
  try {
    atomicWriteFileSync(staging, bytes, {
      durable: true,
      mode: 0o600,
      followTargetSymlink: false,
    });
    linkSync(staging, path);
    fsyncDirectorySyncPortable(dirname(path));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined;
    if (code === 'EEXIST' && readFileSync(path, 'utf8') === bytes) return;
    throw error;
  } finally {
    if (existsSync(staging)) {
      unlinkSync(staging);
      fsyncDirectorySyncPortable(dirname(path));
    }
  }
}

function allocateOpaqueBotId(allocate: () => string, used: Set<string>): BotId {
  const value = parseBotId(allocate());
  if (used.has(value)) throw new Error(`BotId collision: ${value}`);
  used.add(value);
  return value;
}

function currentDigest(path: string): string | null {
  return existsSync(path) ? digest(readFileSync(path, 'utf8')) : null;
}

function removeDurably(path: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
  fsyncDirectorySyncPortable(dirname(path));
}

export function createBotIdentityControlPlane(
  options: BotIdentityControlPlaneOptions,
): BotIdentityControlPlane {
  const registryPath = join(options.dataDir, 'bot-identities.json');
  const operationsDir = join(options.dataDir, 'bot-identity-ops');
  const intentPath = join(options.dataDir, 'bot-identity-intent.json');
  const lockPath = join(options.dataDir, 'bot-identity-control');
  const allocateBotId = options.allocateBotId
    ?? (() => `bot_${randomUUID().replaceAll('-', '')}`);
  const allocateOperationId = options.allocateOperationId
    ?? (() => `op_${randomUUID().replaceAll('-', '')}`);
  const now = options.now ?? (() => new Date().toISOString());
  if ((options.configPath === undefined) === (options.readOnlyConfigBytes === undefined)) {
    throw new Error('bot identity control plane requires exactly one config authority');
  }
  const readConfigBytes = (): string => options.configPath !== undefined
    ? readFileSync(options.configPath, 'utf8')
    : options.readOnlyConfigBytes!();
  const projectionNow = (): string => identityProjectionOf(readConfigBytes());
  const projectionDigestNow = (): string => digest(projectionNow());

  const planPath = (operationId: string) => join(operationsDir, `${operationId}.plan.json`);
  const receiptPath = (operationId: string) => join(operationsDir, `${operationId}.receipt.json`);

  const readPlan = (operationId: string): { plan: BotIdentityPlan; bytes: string } => {
    const bytes = readFileSync(planPath(operationId), 'utf8');
    const plan = parsePlanBytes(bytes);
    if (plan.operationId !== operationId) throw new Error('bot identity plan filename mismatch');
    return { plan, bytes };
  };

  const writeIntent = (intent: BotIdentityIntent): void => {
    writeImmutable(intentPath, canonical(intent));
  };

  const exactPublishedReceipt = (plan: BotIdentityPlan): BotIdentityReceipt | null => {
    if (!existsSync(receiptPath(plan.operationId))) return null;
    const receipt = parseReceiptBytes(readFileSync(receiptPath(plan.operationId), 'utf8'));
    if (receipt.operationId !== plan.operationId
      || receipt.registryDigest !== plan.target.registryDigest
      || receipt.projectionDigest !== digest(plan.identityProjection)) {
      throw new Error('bot identity receipt does not match immutable plan');
    }
    return receipt;
  };

  const latestCompletedOperation = (): string | undefined => {
    if (!existsSync(operationsDir)) return undefined;
    const candidates: Array<{ operationId: string; revision: number }> = [];
    for (const name of readdirSync(operationsDir).filter(entry => entry.endsWith('.receipt.json'))) {
      const operationId = name.slice(0, -'.receipt.json'.length);
      const { plan } = readPlan(operationId);
      if (!exactPublishedReceipt(plan)) continue;
      candidates.push({ operationId, revision: plan.targetRegistry.revision });
    }
    candidates.sort((left, right) => right.revision - left.revision);
    if (candidates.length > 1 && candidates[0]!.revision === candidates[1]!.revision) {
      throw new Error('multiple completed bot identity operations claim the same revision');
    }
    return candidates[0]?.operationId;
  };

  const publishRegistry = (registry: BotIdentityRegistry): void => {
    atomicWriteFileSync(registryPath, canonical(registry), {
      durable: true,
      mode: 0o600,
      followTargetSymlink: false,
    });
  };

  return {
    report() {
      mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
      return withFileLockSync(lockPath, () => {
        const identityProjection = projectionNow();
        const addresses = parseProjectionBytes(identityProjection);
        const sourceRegistryBytes = existsSync(registryPath)
          ? readFileSync(registryPath, 'utf8')
          : null;
        const sourceRegistry = sourceRegistryBytes === null
          ? null
          : parseRegistryBytes(sourceRegistryBytes);
        if (sourceRegistry !== null) {
          if (existsSync(intentPath)) {
            throw new Error('cannot report while a bot identity promotion intent is active');
          }
          const { plan: sourcePlan } = readPlan(sourceRegistry.operationId);
          const sourceReceipt = exactPublishedReceipt(sourcePlan);
          if (!sourceReceipt || digest(sourceRegistryBytes!) !== sourceReceipt.registryDigest) {
            throw new Error('cannot report from unreceipted or drifted bot identity registry; repair first');
          }
          if (digest(identityProjection) === sourceReceipt.projectionDigest) {
            throw new Error(
              `active bot address set is unchanged since ${sourceRegistry.operationId}; nothing to promote`,
            );
          }
        }
        const operationId = allocateOperationId();
        if (!/^op_[A-Za-z0-9_-]{2,128}$/.test(operationId)) {
          throw new Error('invalid bot identity operation ID');
        }
        const used = new Set<string>(sourceRegistry?.bindings.map(binding => binding.botId) ?? []);
        const targetAddressKeys = new Set(addresses.map(addressKey));
        const existingActive = new Map(
          sourceRegistry?.bindings
            .filter(binding => binding.status === 'active')
            .map(binding => [addressKey(binding.address), binding] as const) ?? [],
        );
        const bindings: BotIdentityBinding[] = (sourceRegistry?.bindings ?? []).map(binding => (
          binding.status === 'active' && !targetAddressKeys.has(addressKey(binding.address))
            ? { ...binding, status: 'retired' as const }
            : binding
        ));
        for (const address of addresses) {
          if (existingActive.has(addressKey(address))) continue;
          bindings.push({
            botId: allocateOpaqueBotId(allocateBotId, used),
            status: 'active',
            address,
            ...(address.kind === 'lark' ? { legacyOwnerLarkAppId: address.larkAppId } : {}),
          });
        }
        const targetRegistry: BotIdentityRegistry = {
          schemaVersion: 1,
          revision: (sourceRegistry?.revision ?? 0) + 1,
          operationId,
          bindings,
        };
        const targetRegistryBytes = canonical(targetRegistry);
        const plan: BotIdentityPlan = {
          schemaVersion: 1,
          operationId,
          createdAt: now(),
          identityProjection,
          source: {
            registryDigest: sourceRegistryBytes === null ? null : digest(sourceRegistryBytes),
          },
          target: {
            registryDigest: digest(targetRegistryBytes),
          },
          sourceRegistryBytes,
          targetRegistry,
        };
        writeImmutable(join(operationsDir, `${operationId}.plan.json`), canonical(plan));
        return plan;
      });
    },
    apply(operationId) {
      mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
      return withFileLockSync(lockPath, () => {
        const { plan, bytes: planBytes } = readPlan(operationId);
        const planProjectionDigest = digest(plan.identityProjection);
        const completed = exactPublishedReceipt(plan);
        const registryDigest = currentDigest(registryPath);
        if (completed) {
          if (registryDigest !== plan.target.registryDigest) {
            throw new Error('completed bot identity promotion is missing or drifted; fail closed and repair');
          }
          if (projectionDigestNow() !== planProjectionDigest) {
            throw new Error('active bot address set moved past this promotion; run a fresh report');
          }
          removeDurably(intentPath);
          return completed;
        }

        if (existsSync(intentPath)) {
          const intent = parseIntentBytes(readFileSync(intentPath, 'utf8'));
          if (intent.operationId !== operationId || intent.planDigest !== digest(planBytes)) {
            throw new Error('another bot identity promotion intent is active; fail closed');
          }
        } else {
          if (registryDigest !== plan.source.registryDigest) {
            throw new Error('bot identity promotion source digest changed; fail closed');
          }
          if (projectionDigestNow() !== planProjectionDigest) {
            throw new Error('active bot address set changed since this plan; run a fresh report');
          }
          writeIntent({
            schemaVersion: 1,
            operationId,
            planDigest: digest(planBytes),
            preparedAt: now(),
          });
          options.afterPhase?.('intentPrepared');
        }

        const registryNow = currentDigest(registryPath);
        const registryKnown = registryNow === plan.source.registryDigest
          || registryNow === plan.target.registryDigest;
        if (!registryKnown) {
          throw new Error('bot identity promotion state is outside its immutable plan; fail closed');
        }

        if (registryNow !== plan.target.registryDigest) {
          publishRegistry(plan.targetRegistry);
        }
        options.afterPhase?.('registryPublished');

        if (currentDigest(registryPath) !== plan.target.registryDigest) {
          throw new Error('bot identity promotion readback mismatch; fail closed');
        }
        parseRegistryBytes(readFileSync(registryPath, 'utf8'));
        const receipt: BotIdentityReceipt = {
          schemaVersion: 1,
          operationId,
          registryDigest: plan.target.registryDigest,
          projectionDigest: planProjectionDigest,
          completedAt: now(),
        };
        writeImmutable(receiptPath(operationId), canonical(receipt));
        options.afterPhase?.('receiptPublished');
        removeDurably(intentPath);
        return receipt;
      });
    },
    repair(operationId) {
      let selected = operationId;
      if (!selected && existsSync(intentPath)) {
        selected = parseIntentBytes(readFileSync(intentPath, 'utf8')).operationId;
      }
      if (!selected && existsSync(registryPath)) {
        // A corrupt registry is itself a repair target: fall through to the
        // latest receipted operation instead of failing the selection.
        try {
          selected = parseRegistryBytes(readFileSync(registryPath, 'utf8')).operationId;
        } catch { /* fall through */ }
      }
      if (!selected) selected = latestCompletedOperation();
      if (!selected) throw new Error('no bot identity operation is available to repair');
      const chosen = selected;
      const { plan, bytes: planBytes } = readPlan(chosen);
      const receipt = exactPublishedReceipt(plan);
      if (!receipt && !existsSync(intentPath)) return this.apply(chosen);
      return withFileLockSync(lockPath, () => {
        const intent = existsSync(intentPath)
          ? parseIntentBytes(readFileSync(intentPath, 'utf8'))
          : null;
        if (!receipt && (
          !intent
          || intent.operationId !== chosen
          || intent.planDigest !== digest(planBytes)
        )) {
          throw new Error('bot identity repair lacks the exact promotion intent; fail closed');
        }
        const reread = exactPublishedReceipt(plan);
        if (receipt && !reread) throw new Error('completed bot identity receipt disappeared; fail closed');
        publishRegistry(plan.targetRegistry);
        if (currentDigest(registryPath) !== plan.target.registryDigest) {
          throw new Error('bot identity repair readback mismatch; fail closed');
        }
        parseRegistryBytes(readFileSync(registryPath, 'utf8'));
        const result = reread ?? {
          schemaVersion: 1 as const,
          operationId: chosen,
          registryDigest: plan.target.registryDigest,
          projectionDigest: digest(plan.identityProjection),
          completedAt: now(),
        };
        if (!reread) writeImmutable(receiptPath(chosen), canonical(result));
        removeDurably(intentPath);
        return result;
      });
    },
    rollback(operationId) {
      let selected = operationId;
      if (!selected && existsSync(intentPath)) {
        selected = parseIntentBytes(readFileSync(intentPath, 'utf8')).operationId;
      }
      if (!selected) throw new Error('rollback requires an active or explicit bot identity operation');
      const chosen = selected;
      return withFileLockSync(lockPath, () => {
        const { plan } = readPlan(chosen);
        if (existsSync(receiptPath(chosen))) {
          parseReceiptBytes(readFileSync(receiptPath(chosen), 'utf8'));
          throw new Error('completed bot identity operation cannot be rolled back; use forward repair');
        }
        const registryDigest = currentDigest(registryPath);
        if (![plan.source.registryDigest, plan.target.registryDigest].includes(registryDigest)) {
          throw new Error('bot identity rollback state is outside its immutable plan; fail closed');
        }
        if (plan.sourceRegistryBytes === null) {
          removeDurably(registryPath);
        } else {
          atomicWriteFileSync(registryPath, plan.sourceRegistryBytes, {
            durable: true,
            mode: 0o600,
            followTargetSymlink: false,
          });
        }
        removeDurably(intentPath);
        return this.status();
      });
    },
    status() {
      try {
        const receiptFiles = existsSync(operationsDir)
          ? readdirSync(operationsDir).filter(name => name.endsWith('.receipt.json')).sort()
          : [];
        if (!existsSync(registryPath)) {
          if (existsSync(intentPath) || receiptFiles.length > 0) {
            return { kind: 'needsRepair', reason: 'published bot identity registry is missing' };
          }
          const planFiles = existsSync(operationsDir)
            ? readdirSync(operationsDir).filter(name => name.endsWith('.plan.json'))
            : [];
          if (planFiles.length > 0) {
            const plans = planFiles.map(name => {
              const operationId = name.slice(0, -'.plan.json'.length);
              return readPlan(operationId).plan;
            });
            plans.sort((left, right) => (
              left.createdAt === right.createdAt
                ? (left.operationId < right.operationId ? 1 : -1)
                : (left.createdAt < right.createdAt ? 1 : -1)
            ));
            return { kind: 'planned', operationId: plans[0]!.operationId };
          }
          return { kind: 'unmigrated' };
        }
        const registryBytes = readFileSync(registryPath, 'utf8');
        const registry = parseRegistryBytes(registryBytes);
        if (existsSync(intentPath)) {
          const intent = parseIntentBytes(readFileSync(intentPath, 'utf8'));
          return {
            kind: 'needsRepair',
            reason: 'bot identity promotion intent is active',
            operationId: intent.operationId,
          };
        }
        const { plan } = readPlan(registry.operationId);
        const receipt = exactPublishedReceipt(plan);
        if (!receipt || digest(registryBytes) !== receipt.registryDigest) {
          return {
            kind: 'needsRepair',
            reason: 'bot identity registry has no exact completed receipt',
            operationId: registry.operationId,
          };
        }
        if (projectionDigestNow() !== receipt.projectionDigest) {
          return {
            kind: 'needsPromotion',
            revision: registry.revision,
            operationId: registry.operationId,
          };
        }
        return { kind: 'ready', revision: registry.revision, operationId: registry.operationId };
      } catch (error) {
        return {
          kind: 'needsRepair',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    resolveActive(address) {
      const state = this.status();
      if (state.kind !== 'ready') {
        throw new Error(`bot identity registry is not ready; fail closed (${state.kind})`);
      }
      const registry = parseRegistryBytes(readFileSync(registryPath, 'utf8'));
      const match = registry.bindings.find(binding => (
        binding.status === 'active' && addressKey(binding.address) === addressKey(address)
      ));
      if (!match) throw new Error('active bot address has no identity; fail closed');
      return match;
    },
    actorRef(address, sessionId) {
      return sessionActorRef(this.resolveActive(address).botId, sessionId);
    },
  };
}
