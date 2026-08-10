/**
 * Detached worktree preparation for pending-repository completion.
 *
 * The Module owns Git effect classification and returns transport-neutral
 * evidence. Callers retain Session authority and decide how to publish the
 * result or warning events.
 */

import { join } from 'node:path';
import { types as nodeUtilTypes } from 'node:util';

import { dirSuffixForBranch } from '../services/git-worktree.js';

export interface PendingWorktreeRepository {
  readonly sourcePath: string;
  readonly childName: string;
}

export type PendingWorktreeLayout =
  | { readonly kind: 'sibling' }
  | { readonly kind: 'group'; readonly parentRoot: string };

interface PendingWorktreePreparationContext {
  readonly title?: string;
  readonly prompt?: string;
  readonly pushForRiff: boolean;
}

export type PendingWorktreePreparationInput =
  | PendingWorktreePreparationContext & {
      readonly kind: 'autoWorktree';
      readonly baseDir: string;
    }
  | PendingWorktreePreparationContext & {
      readonly kind: 'manual';
      readonly repositories: readonly PendingWorktreeRepository[];
      readonly branch?: string;
      readonly layout: PendingWorktreeLayout;
    };

export interface PendingWorktreeCreateOptions {
  readonly branch?: string;
  readonly slug?: string;
  readonly worktreePath?: string;
}

export type PendingWorktreeCreateResult =
  | {
      readonly kind: 'created';
      readonly path: string;
      readonly branch: string;
      readonly baseRef: string;
    }
  | { readonly kind: 'refused'; readonly message: string };

export interface PreparedPendingWorktree {
  readonly sourcePath: string;
  readonly path: string;
  readonly branch: string;
  readonly baseRef: string;
}

export interface PendingWorktreePushWarning {
  readonly kind: 'riffPushFailed';
  readonly sourcePath: string;
  readonly path: string;
  readonly branch: string;
  readonly message: string;
}

export interface PendingWorktreeAutoFallback {
  readonly kind: 'autoWorktreeFallback';
  readonly reason: 'notGit' | 'preflightFailed' | 'slugFailed' | 'createRefused';
  readonly message: string;
}

export interface PendingWorktreeRollbackEvidence {
  readonly failedSourcePath: string;
  readonly rolledBackCount: number;
}

export type PendingWorktreePreparationResult =
  | {
      readonly kind: 'ready';
      readonly workingDir: string;
      readonly riffRepoDirs?: readonly string[];
      readonly worktrees: readonly PreparedPendingWorktree[];
      readonly warnings: readonly PendingWorktreePushWarning[];
      readonly fallback?: PendingWorktreeAutoFallback;
    }
  | {
      readonly kind: 'refused';
      readonly message: string;
      readonly rollback?: PendingWorktreeRollbackEvidence;
    }
  | { readonly kind: 'unknown'; readonly message: string };

export interface PendingWorktreePreparationPrimitives {
  readonly slug: (
    title: string | undefined,
    prompt: string | undefined,
  ) => Promise<string | undefined>;
  readonly isGit: (path: string) => Promise<boolean>;
  readonly create: (
    sourcePath: string,
    options: PendingWorktreeCreateOptions,
  ) => Promise<PendingWorktreeCreateResult>;
  readonly remove: (sourcePath: string, worktreePath: string) => Promise<void>;
  readonly push: (worktreePath: string, branch: string) => Promise<void>;
}

export interface PendingWorktreePreparation {
  prepare(input: PendingWorktreePreparationInput): Promise<PendingWorktreePreparationResult>;
}

function baseDirectoryReady(
  baseDir: string,
  fallback?: PendingWorktreeAutoFallback,
): PendingWorktreePreparationResult {
  return Object.freeze({
    kind: 'ready',
    workingDir: baseDir,
    worktrees: Object.freeze([]),
    warnings: Object.freeze([]),
    ...(fallback === undefined ? {} : { fallback: Object.freeze(fallback) }),
  });
}

function createdReady(
  workingDir: string,
  worktrees: readonly PreparedPendingWorktree[],
  warnings: readonly PendingWorktreePushWarning[],
  riffRepoDirs?: readonly string[],
): PendingWorktreePreparationResult {
  return Object.freeze({
    kind: 'ready',
    workingDir,
    ...(riffRepoDirs === undefined
      ? {}
      : { riffRepoDirs: Object.freeze([...riffRepoDirs]) }),
    worktrees: Object.freeze([...worktrees]),
    warnings: Object.freeze([...warnings]),
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error || 'unknown thrown value';
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try {
      if (nodeUtilTypes.isProxy(error)) return 'unknown thrown value';
      const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
      if (descriptor
        && 'value' in descriptor
        && typeof descriptor.value === 'string'
        && descriptor.value.length > 0) {
        return descriptor.value;
      }
    } catch {
      return 'unknown thrown value';
    }
  }
  try {
    const rendered = String(error);
    return rendered || 'unknown thrown value';
  } catch {
    return 'unknown thrown value';
  }
}

function inspectCreateResult(value: unknown): PendingWorktreeCreateResult | undefined {
  try {
    if (value === null
      || typeof value !== 'object'
      || nodeUtilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const kindDescriptor = descriptors.kind;
    if (!kindDescriptor
      || !kindDescriptor.enumerable
      || !('value' in kindDescriptor)
      || (kindDescriptor.value !== 'created' && kindDescriptor.value !== 'refused')) {
      return undefined;
    }
    const expectedKeys = kindDescriptor.value === 'created'
      ? ['kind', 'path', 'branch', 'baseRef']
      : ['kind', 'message'];
    if (keys.length !== expectedKeys.length
      || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) {
      return undefined;
    }
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor
        || !descriptor.enumerable
        || !('value' in descriptor)) {
        return undefined;
      }
    }
    if (kindDescriptor.value === 'created') {
      const path = descriptors.path!.value;
      const branch = descriptors.branch!.value;
      const baseRef = descriptors.baseRef!.value;
      if (typeof path !== 'string'
        || path.trim().length === 0
        || typeof branch !== 'string'
        || branch.trim().length === 0
        || typeof baseRef !== 'string'
        || baseRef.trim().length === 0) {
        return undefined;
      }
      return Object.freeze({ kind: 'created', path, branch, baseRef });
    }
    const message = descriptors.message!.value;
    if (typeof message !== 'string' || message.trim().length === 0) return undefined;
    return Object.freeze({ kind: 'refused', message });
  } catch {
    return undefined;
  }
}

async function pushCreatedForRiff(
  primitives: PendingWorktreePreparationPrimitives,
  worktrees: readonly PreparedPendingWorktree[],
): Promise<readonly PendingWorktreePushWarning[]> {
  const warnings: PendingWorktreePushWarning[] = [];
  for (const worktree of worktrees) {
    try {
      await primitives.push(worktree.path, worktree.branch);
    } catch (error) {
      warnings.push(Object.freeze({
        kind: 'riffPushFailed',
        sourcePath: worktree.sourcePath,
        path: worktree.path,
        branch: worktree.branch,
        message: errorMessage(error),
      }));
    }
  }
  return Object.freeze(warnings);
}

async function cleanCreatedPrefix(
  primitives: PendingWorktreePreparationPrimitives,
  worktrees: readonly PreparedPendingWorktree[],
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const worktree of worktrees) {
    try {
      await primitives.remove(worktree.sourcePath, worktree.path);
    } catch (error) {
      failures.push(`${worktree.path}: ${errorMessage(error)}`);
    }
  }
  return Object.freeze(failures);
}

export function createPendingWorktreePreparation(
  primitives: PendingWorktreePreparationPrimitives,
): PendingWorktreePreparation {
  return Object.freeze({
    async prepare(
      input: PendingWorktreePreparationInput,
    ): Promise<PendingWorktreePreparationResult> {
      if (input.kind === 'autoWorktree') {
        let git: unknown;
        try {
          git = await primitives.isGit(input.baseDir);
        } catch (error) {
          return baseDirectoryReady(input.baseDir, {
            kind: 'autoWorktreeFallback',
            reason: 'preflightFailed',
            message: errorMessage(error),
          });
        }
        if (typeof git !== 'boolean') {
          return baseDirectoryReady(input.baseDir, {
            kind: 'autoWorktreeFallback',
            reason: 'preflightFailed',
            message: 'auto-worktree Git preflight returned an invalid result',
          });
        }
        if (!git) {
          return baseDirectoryReady(input.baseDir, {
            kind: 'autoWorktreeFallback',
            reason: 'notGit',
            message: 'base directory is not a Git worktree',
          });
        }
        let slug: unknown;
        try {
          slug = await primitives.slug(input.title, input.prompt);
        } catch (error) {
          return baseDirectoryReady(input.baseDir, {
            kind: 'autoWorktreeFallback',
            reason: 'slugFailed',
            message: errorMessage(error),
          });
        }
        if (slug !== undefined
          && (typeof slug !== 'string' || slug.trim().length === 0)) {
          return baseDirectoryReady(input.baseDir, {
            kind: 'autoWorktreeFallback',
            reason: 'slugFailed',
            message: 'auto-worktree slug primitive returned an invalid result',
          });
        }
        let rawResult: unknown;
        try {
          rawResult = await primitives.create(input.baseDir, {
            ...(slug === undefined ? {} : { slug }),
          });
        } catch (error) {
          return Object.freeze({
            kind: 'unknown',
            message: `auto-worktree creation outcome is unknown: ${errorMessage(error)}`,
          });
        }
        const result = inspectCreateResult(rawResult);
        if (!result) {
          return Object.freeze({
            kind: 'unknown',
            message: 'auto-worktree create primitive returned an invalid result',
          });
        }
        if (result.kind === 'created') {
          const created = Object.freeze({
            sourcePath: input.baseDir,
            path: result.path,
            branch: result.branch,
            baseRef: result.baseRef,
          });
          const warnings = input.pushForRiff
            ? await pushCreatedForRiff(primitives, [created])
            : [];
          return createdReady(result.path, [created], warnings);
        }
        return baseDirectoryReady(input.baseDir, {
          kind: 'autoWorktreeFallback',
          reason: 'createRefused',
          message: result.message,
        });
      }
      const repositories = input.repositories.map(repository => Object.freeze({
        sourcePath: repository.sourcePath,
        childName: repository.childName,
      }));
      if (repositories.length === 0) {
        return Object.freeze({
          kind: 'refused',
          message: 'manual worktree selection has no repositories',
        });
      }
      if (input.layout.kind === 'sibling' && repositories.length !== 1) {
        return Object.freeze({
          kind: 'refused',
          message: 'sibling worktree layout requires exactly one repository',
        });
      }
      if (repositories.some(repository => {
        const name = repository.childName;
        return name.trim().length === 0
          || name === '.'
          || name === '..'
          || /[\\/\0]/.test(name)
          || /^[A-Za-z]:/.test(name);
      })) {
        return Object.freeze({
          kind: 'refused',
          message: 'manual worktree child names must be safe path segments',
        });
      }
      if (new Set(repositories.map(repository => repository.childName)).size !== repositories.length) {
        return Object.freeze({
          kind: 'refused',
          message: 'manual worktree child names must be unique',
        });
      }
      const branch = input.branch?.trim() || undefined;
      let slug: unknown;
      if (branch === undefined) {
        try {
          slug = await primitives.slug(input.title, input.prompt);
        } catch (error) {
          return Object.freeze({
            kind: 'refused',
            message: `manual worktree slug preparation failed: ${errorMessage(error)}`,
          });
        }
        if (slug !== undefined
          && (typeof slug !== 'string' || slug.trim().length === 0)) {
          return Object.freeze({
            kind: 'refused',
            message: 'manual worktree slug primitive returned an invalid result',
          });
        }
      }
      const exactSlug = typeof slug === 'string' ? slug : undefined;
      const parentPath = input.layout.kind === 'group'
        ? join(input.layout.parentRoot, dirSuffixForBranch(branch ?? exactSlug ?? 'worktree'))
        : undefined;
      const created: PreparedPendingWorktree[] = [];
      for (const repository of repositories) {
        const requestedWorktreePath = parentPath === undefined
          ? undefined
          : join(parentPath, repository.childName);
        let rawResult: unknown;
        try {
          rawResult = await primitives.create(repository.sourcePath, {
            ...(branch === undefined ? {} : { branch }),
            ...(exactSlug === undefined ? {} : { slug: exactSlug }),
            ...(requestedWorktreePath === undefined
              ? {}
              : { worktreePath: requestedWorktreePath }),
          });
        } catch (error) {
          const cleanupFailures = await cleanCreatedPrefix(primitives, created);
          return Object.freeze({
            kind: 'unknown',
            message: `manual worktree creation outcome is unknown for ${repository.sourcePath}: `
              + `${errorMessage(error)}`
              + (cleanupFailures.length === 0
                ? ''
                : `; prefix cleanup unproved: ${cleanupFailures.join('; ')}`),
          });
        }
        const result = inspectCreateResult(rawResult);
        if (!result) {
          const cleanupFailures = await cleanCreatedPrefix(primitives, created);
          return Object.freeze({
            kind: 'unknown',
            message: `manual worktree create primitive returned an invalid result for `
              + `${repository.sourcePath}`
              + (cleanupFailures.length === 0
                ? ''
                : `; prefix cleanup unproved: ${cleanupFailures.join('; ')}`),
          });
        }
        if (result.kind === 'refused') {
          const cleanupFailures = await cleanCreatedPrefix(primitives, created);
          if (cleanupFailures.length > 0) {
            return Object.freeze({
              kind: 'unknown',
              message: `manual worktree cleanup outcome is unknown after refusal for `
                + `${repository.sourcePath}: ${cleanupFailures.join('; ')}`,
            });
          }
          return Object.freeze({
            kind: 'refused',
            message: `manual worktree creation refused for ${repository.sourcePath}: ${result.message}`,
            rollback: Object.freeze({
              failedSourcePath: repository.sourcePath,
              rolledBackCount: created.length,
            }),
          });
        }
        if (result.kind === 'created'
          && requestedWorktreePath !== undefined
          && result.path !== requestedWorktreePath) {
          const mismatched = Object.freeze({
            sourcePath: repository.sourcePath,
            path: result.path,
            branch: result.branch,
            baseRef: result.baseRef,
          });
          const cleanupFailures = await cleanCreatedPrefix(
            primitives,
            [...created, mismatched],
          );
          return Object.freeze({
            kind: 'unknown',
            message: `manual grouped worktree path mismatch for ${repository.sourcePath}: `
              + `expected ${requestedWorktreePath}, received ${result.path}`
              + (cleanupFailures.length === 0
                ? ''
                : `; cleanup unproved: ${cleanupFailures.join('; ')}`),
          });
        }
        created.push(Object.freeze({
          sourcePath: repository.sourcePath,
          path: result.path,
          branch: result.branch,
          baseRef: result.baseRef,
        }));
      }
      const workingDir = parentPath ?? created[0]!.path;
      const warnings = input.pushForRiff
        ? await pushCreatedForRiff(primitives, created)
        : [];
      return createdReady(
        workingDir,
        created,
        warnings,
        parentPath === undefined ? undefined : created.map(worktree => worktree.path),
      );
    },
  });
}
