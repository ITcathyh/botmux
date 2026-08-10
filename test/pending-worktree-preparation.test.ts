import { describe, expect, it, vi } from 'vitest';

import {
  createPendingWorktreePreparation,
  type PendingWorktreeCreateResult,
  type PendingWorktreePreparationPrimitives,
} from '../src/core/current-pending-worktree-preparation.js';

function primitives(
  overrides: Partial<PendingWorktreePreparationPrimitives> = {},
): PendingWorktreePreparationPrimitives {
  return {
    slug: vi.fn(async () => 'opening-slug'),
    isGit: vi.fn(async () => true),
    create: vi.fn(async () => ({
      kind: 'created',
      path: '/repos/app-wt-opening-slug',
      branch: 'wt/opening-slug',
      baseRef: 'origin/main',
    })),
    remove: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('pending worktree preparation', () => {
  it('falls back to the frozen auto-worktree base directory when it is not a Git worktree', async () => {
    const adapters = primitives({ isGit: vi.fn(async () => false) });
    const preparation = createPendingWorktreePreparation(adapters);

    const result = await preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/plain',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    });

    expect(result).toEqual({
      kind: 'ready',
      workingDir: '/repos/plain',
      worktrees: [],
      warnings: [],
      fallback: {
        kind: 'autoWorktreeFallback',
        reason: 'notGit',
        message: 'base directory is not a Git worktree',
      },
    });
    expect(adapters.isGit).toHaveBeenCalledOnce();
    expect(adapters.isGit).toHaveBeenCalledWith('/repos/plain');
    expect(adapters.slug).not.toHaveBeenCalled();
    expect(adapters.create).not.toHaveBeenCalled();
    expect(adapters.remove).not.toHaveBeenCalled();
    expect(adapters.push).not.toHaveBeenCalled();
  });

  it('returns preflight failure evidence while safely falling back before Git effects', async () => {
    const adapters = primitives({
      isGit: vi.fn(async () => {
        throw new Error('git probe unavailable');
      }),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/app',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'ready',
      workingDir: '/repos/app',
      worktrees: [],
      warnings: [],
      fallback: {
        kind: 'autoWorktreeFallback',
        reason: 'preflightFailed',
        message: 'git probe unavailable',
      },
    });
    expect(adapters.create).not.toHaveBeenCalled();
  });

  it('treats a non-boolean Git preflight result as a proven fallback failure before create', async () => {
    const adapters = primitives({
      isGit: vi.fn(async () => 'false' as unknown as boolean),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/app',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'ready',
      workingDir: '/repos/app',
      worktrees: [],
      warnings: [],
      fallback: {
        kind: 'autoWorktreeFallback',
        reason: 'preflightFailed',
        message: 'auto-worktree Git preflight returned an invalid result',
      },
    });
    expect(adapters.slug).not.toHaveBeenCalled();
    expect(adapters.create).not.toHaveBeenCalled();
  });

  it('creates one auto worktree from the frozen opening context', async () => {
    const adapters = primitives();
    const preparation = createPendingWorktreePreparation(adapters);

    const result = await preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/app',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    });

    expect(adapters.slug).toHaveBeenCalledWith('Frozen title', 'Frozen prompt');
    expect(adapters.create).toHaveBeenCalledWith('/repos/app', {
      slug: 'opening-slug',
    });
    expect(result).toEqual({
      kind: 'ready',
      workingDir: '/repos/app-wt-opening-slug',
      worktrees: [{
        sourcePath: '/repos/app',
        path: '/repos/app-wt-opening-slug',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      }],
      warnings: [],
    });
  });

  it('falls back to the base directory after a proven auto-worktree refusal', async () => {
    const adapters = primitives({
      create: vi.fn(async () => ({ kind: 'refused', message: 'branch is already checked out' })),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/app',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'ready',
      workingDir: '/repos/app',
      worktrees: [],
      warnings: [],
      fallback: {
        kind: 'autoWorktreeFallback',
        reason: 'createRefused',
        message: 'branch is already checked out',
      },
    });
  });

  it('classifies an auto create throw as response-loss unknown instead of falling back', async () => {
    const adapters = primitives({
      create: vi.fn(async () => {
        throw new Error('connection dropped after git worktree add');
      }),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/app',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'unknown',
      message: 'auto-worktree creation outcome is unknown: connection dropped after git worktree add',
    });
    expect(adapters.remove).not.toHaveBeenCalled();
  });

  it('rejects malformed, accessor-backed, and Proxy create results as auto outcome unknown', async () => {
    const accessor = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      kind: { enumerable: true, get: () => 'created' },
      path: { enumerable: true, value: '/repos/accessor' },
      branch: { enumerable: true, value: 'wt/accessor' },
      baseRef: { enumerable: true, value: 'origin/main' },
    });
    const candidates: unknown[] = [
      { kind: 'created', path: '', branch: 'wt/empty', baseRef: 'origin/main' },
      { kind: 'refused', message: '' },
      {
        kind: 'created',
        path: '/repos/extra',
        branch: 'wt/extra',
        baseRef: 'origin/main',
        extra: true,
      },
      accessor,
      new Proxy({
        kind: 'created',
        path: '/repos/proxy',
        branch: 'wt/proxy',
        baseRef: 'origin/main',
      }, {}),
    ];

    for (const candidate of candidates) {
      const adapters = primitives({
        create: vi.fn(async () => candidate as PendingWorktreeCreateResult),
      });
      const preparation = createPendingWorktreePreparation(adapters);

      await expect(preparation.prepare({
        kind: 'autoWorktree',
        baseDir: '/repos/app',
        title: 'Frozen title',
        prompt: 'Frozen prompt',
        pushForRiff: false,
      })).resolves.toEqual({
        kind: 'unknown',
        message: 'auto-worktree create primitive returned an invalid result',
      });
      expect(adapters.remove).not.toHaveBeenCalled();
      expect(adapters.push).not.toHaveBeenCalled();
    }
  });

  it('falls back after an auto slug failure because no Git effect has started', async () => {
    const adapters = primitives({
      slug: vi.fn(async () => {
        throw new Error('slug provider unavailable');
      }),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/app',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'ready',
      workingDir: '/repos/app',
      worktrees: [],
      warnings: [],
      fallback: {
        kind: 'autoWorktreeFallback',
        reason: 'slugFailed',
        message: 'slug provider unavailable',
      },
    });
    expect(adapters.create).not.toHaveBeenCalled();
  });

  it('falls back before create when the auto slug primitive returns an invalid value', async () => {
    const adapters = primitives({
      slug: vi.fn(async () => ({}) as unknown as Promise<string | undefined>),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/app',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'ready',
      workingDir: '/repos/app',
      worktrees: [],
      warnings: [],
      fallback: {
        kind: 'autoWorktreeFallback',
        reason: 'slugFailed',
        message: 'auto-worktree slug primitive returned an invalid result',
      },
    });
    expect(adapters.create).not.toHaveBeenCalled();
  });

  it('keeps a created auto worktree ready when its Riff push fails and emits a warning', async () => {
    const adapters = primitives({
      push: vi.fn(async () => {
        throw new Error('origin rejected the branch');
      }),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    const result = await preparation.prepare({
      kind: 'autoWorktree',
      baseDir: '/repos/app',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: true,
    });

    expect(adapters.push).toHaveBeenCalledWith(
      '/repos/app-wt-opening-slug',
      'wt/opening-slug',
    );
    expect(result).toEqual({
      kind: 'ready',
      workingDir: '/repos/app-wt-opening-slug',
      worktrees: [{
        sourcePath: '/repos/app',
        path: '/repos/app-wt-opening-slug',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      }],
      warnings: [{
        kind: 'riffPushFailed',
        sourcePath: '/repos/app',
        path: '/repos/app-wt-opening-slug',
        branch: 'wt/opening-slug',
        message: 'origin rejected the branch',
      }],
    });
  });

  it('creates an ordered manual group under one canonical parent with explicit child paths', async () => {
    const create = vi.fn(async (sourcePath: string) => sourcePath.endsWith('/alpha')
      ? {
          kind: 'created' as const,
          path: '/repos/opening-slug/alpha',
          branch: 'wt/opening-slug',
          baseRef: 'origin/main',
        }
      : {
          kind: 'created' as const,
          path: '/repos/opening-slug/beta',
          branch: 'wt/opening-slug-2',
          baseRef: 'origin/main',
        });
    const adapters = primitives({ create });
    const preparation = createPendingWorktreePreparation(adapters);

    const result = await preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    });

    expect(adapters.slug).toHaveBeenCalledOnce();
    expect(adapters.slug).toHaveBeenCalledWith('Frozen title', 'Frozen prompt');
    expect(create.mock.calls).toEqual([
      ['/repos/alpha', {
        slug: 'opening-slug',
        worktreePath: '/repos/opening-slug/alpha',
      }],
      ['/repos/beta', {
        slug: 'opening-slug',
        worktreePath: '/repos/opening-slug/beta',
      }],
    ]);
    expect(result).toEqual({
      kind: 'ready',
      workingDir: '/repos/opening-slug',
      riffRepoDirs: [
        '/repos/opening-slug/alpha',
        '/repos/opening-slug/beta',
      ],
      worktrees: [
        {
          sourcePath: '/repos/alpha',
          path: '/repos/opening-slug/alpha',
          branch: 'wt/opening-slug',
          baseRef: 'origin/main',
        },
        {
          sourcePath: '/repos/beta',
          path: '/repos/opening-slug/beta',
          branch: 'wt/opening-slug-2',
          baseRef: 'origin/main',
        },
      ],
      warnings: [],
    });
  });

  it('rejects duplicate manual child names before slug or Git I/O', async () => {
    const adapters = primitives();
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'same' },
        { sourcePath: '/repos/beta', childName: 'same' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'refused',
      message: 'manual worktree child names must be unique',
    });
    expect(adapters.slug).not.toHaveBeenCalled();
    expect(adapters.create).not.toHaveBeenCalled();
    expect(adapters.remove).not.toHaveBeenCalled();
    expect(adapters.push).not.toHaveBeenCalled();
  });

  it('rejects unsafe manual child path segments before slug or Git I/O', async () => {
    for (const childName of ['', '.', '..', 'nested/alpha', 'nested\\alpha', '/absolute']) {
      const adapters = primitives();
      const preparation = createPendingWorktreePreparation(adapters);

      await expect(preparation.prepare({
        kind: 'manual',
        repositories: [{ sourcePath: '/repos/alpha', childName }],
        layout: { kind: 'group', parentRoot: '/repos' },
        title: 'Frozen title',
        prompt: 'Frozen prompt',
        pushForRiff: false,
      })).resolves.toEqual({
        kind: 'refused',
        message: 'manual worktree child names must be safe path segments',
      });
      expect(adapters.slug).not.toHaveBeenCalled();
      expect(adapters.create).not.toHaveBeenCalled();
    }
  });

  it('rejects an empty manual repository selection before slug or Git I/O', async () => {
    const adapters = primitives();
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'refused',
      message: 'manual worktree selection has no repositories',
    });
    expect(adapters.slug).not.toHaveBeenCalled();
    expect(adapters.create).not.toHaveBeenCalled();
  });

  it('rejects multiple repositories in sibling layout before slug or Git I/O', async () => {
    const adapters = primitives();
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      layout: { kind: 'sibling' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'refused',
      message: 'sibling worktree layout requires exactly one repository',
    });
    expect(adapters.slug).not.toHaveBeenCalled();
    expect(adapters.create).not.toHaveBeenCalled();
  });

  it('returns a typed manual refusal when slug preparation fails before Git I/O', async () => {
    const adapters = primitives({
      slug: vi.fn(async () => {
        throw new Error('slug provider unavailable');
      }),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [{ sourcePath: '/repos/alpha', childName: 'alpha' }],
      layout: { kind: 'sibling' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'refused',
      message: 'manual worktree slug preparation failed: slug provider unavailable',
    });
    expect(adapters.create).not.toHaveBeenCalled();
  });

  it('returns a typed manual refusal when the slug primitive returns an empty or invalid value', async () => {
    for (const invalidSlug of ['', '   ', 42, null, {}]) {
      const adapters = primitives({
        slug: vi.fn(async () => invalidSlug as unknown as string | undefined),
      });
      const preparation = createPendingWorktreePreparation(adapters);

      await expect(preparation.prepare({
        kind: 'manual',
        repositories: [{ sourcePath: '/repos/alpha', childName: 'alpha' }],
        layout: { kind: 'sibling' },
        title: 'Frozen title',
        prompt: 'Frozen prompt',
        pushForRiff: false,
      })).resolves.toEqual({
        kind: 'refused',
        message: 'manual worktree slug primitive returned an invalid result',
      });
      expect(adapters.create).not.toHaveBeenCalled();
    }
  });

  it('returns a refusal only after cleaning the full created prefix in selection order', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/feat-grouped/alpha',
        branch: 'feat/grouped',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/feat-grouped/beta',
        branch: 'feat/grouped',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({ kind: 'refused', message: 'gamma branch is busy' });
    const remove = vi.fn(async () => undefined);
    const adapters = primitives({ create, remove });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
        { sourcePath: '/repos/gamma', childName: 'gamma' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      branch: 'feat/grouped',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'refused',
      message: 'manual worktree creation refused for /repos/gamma: gamma branch is busy',
      rollback: {
        failedSourcePath: '/repos/gamma',
        rolledBackCount: 2,
      },
    });
    expect(remove.mock.calls).toEqual([
      ['/repos/alpha', '/repos/feat-grouped/alpha'],
      ['/repos/beta', '/repos/feat-grouped/beta'],
    ]);
    expect(adapters.push).not.toHaveBeenCalled();
  });

  it('reports a zero rollback count when the first manual create is proven refused', async () => {
    const adapters = primitives({
      create: vi.fn(async () => ({ kind: 'refused', message: 'alpha branch is busy' })),
    });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [{ sourcePath: '/repos/alpha', childName: 'alpha' }],
      layout: { kind: 'sibling' },
      branch: 'feat/alpha',
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'refused',
      message: 'manual worktree creation refused for /repos/alpha: alpha branch is busy',
      rollback: {
        failedSourcePath: '/repos/alpha',
        rolledBackCount: 0,
      },
    });
    expect(adapters.remove).not.toHaveBeenCalled();
  });

  it('cleans the known prefix but remains unknown when create may have succeeded before throwing', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/alpha',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      })
      .mockRejectedValueOnce(new Error('response lost after creating beta'));
    const remove = vi.fn(async () => undefined);
    const adapters = primitives({ create, remove });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'unknown',
      message: 'manual worktree creation outcome is unknown for /repos/beta: response lost after creating beta',
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('/repos/alpha', '/repos/opening-slug/alpha');
  });

  it('cleans the known prefix and returns unknown for a malformed manual create result', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/alpha',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({
        kind: 'created',
        path: '',
        branch: 'wt/opening-slug-2',
        baseRef: 'origin/main',
      });
    const remove = vi.fn(async () => undefined);
    const adapters = primitives({ create, remove });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'unknown',
      message: 'manual worktree create primitive returned an invalid result for /repos/beta',
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('/repos/alpha', '/repos/opening-slug/alpha');
  });

  it('cleans the returned worktree and prefix but remains unknown when a group path contradicts the request', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/alpha',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/elsewhere/beta',
        branch: 'wt/opening-slug-2',
        baseRef: 'origin/main',
      });
    const remove = vi.fn(async () => undefined);
    const preparation = createPendingWorktreePreparation(primitives({ create, remove }));

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'unknown',
      message: 'manual grouped worktree path mismatch for /repos/beta: '
        + 'expected /repos/opening-slug/beta, received /elsewhere/beta',
    });
    expect(remove.mock.calls).toEqual([
      ['/repos/alpha', '/repos/opening-slug/alpha'],
      ['/repos/beta', '/elsewhere/beta'],
    ]);
  });

  it('pushes every prepared manual Riff branch in order and reports failures without blocking ready', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/alpha',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/beta',
        branch: 'wt/opening-slug-2',
        baseRef: 'origin/main',
      });
    const push = vi.fn()
      .mockRejectedValueOnce(new Error('alpha push refused'))
      .mockResolvedValueOnce(undefined);
    const adapters = primitives({ create, push });
    const preparation = createPendingWorktreePreparation(adapters);

    const result = await preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: true,
    });

    expect(push.mock.calls).toEqual([
      ['/repos/opening-slug/alpha', 'wt/opening-slug'],
      ['/repos/opening-slug/beta', 'wt/opening-slug-2'],
    ]);
    expect(result).toMatchObject({
      kind: 'ready',
      workingDir: '/repos/opening-slug',
      warnings: [{
        kind: 'riffPushFailed',
        sourcePath: '/repos/alpha',
        path: '/repos/opening-slug/alpha',
        branch: 'wt/opening-slug',
        message: 'alpha push refused',
      }],
    });
  });

  it('keeps the Riff push loop total when a primitive throws a null-prototype value', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/alpha',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/beta',
        branch: 'wt/opening-slug-2',
        baseRef: 'origin/main',
      });
    const nullPrototypeError = Object.create(null) as object;
    const push = vi.fn()
      .mockRejectedValueOnce(nullPrototypeError)
      .mockResolvedValueOnce(undefined);
    const preparation = createPendingWorktreePreparation(primitives({ create, push }));

    const result = await preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: true,
    });

    expect(push).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      kind: 'ready',
      warnings: [{
        kind: 'riffPushFailed',
        sourcePath: '/repos/alpha',
        message: 'unknown thrown value',
      }],
    });
  });

  it('keeps a typed create refusal unknown when prefix cleanup cannot be proven', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/alpha',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({ kind: 'refused', message: 'beta branch is busy' });
    const remove = vi.fn(async () => {
      throw new Error('cleanup response lost');
    });
    const adapters = primitives({ create, remove });
    const preparation = createPendingWorktreePreparation(adapters);

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'unknown',
      message: 'manual worktree cleanup outcome is unknown after refusal for /repos/beta: '
        + '/repos/opening-slug/alpha: cleanup response lost',
    });
  });

  it('continues prefix cleanup after a hostile thrown value cannot be rendered', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/alpha',
        branch: 'wt/opening-slug',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({
        kind: 'created',
        path: '/repos/opening-slug/beta',
        branch: 'wt/opening-slug-2',
        baseRef: 'origin/main',
      })
      .mockResolvedValueOnce({ kind: 'refused', message: 'gamma branch is busy' });
    const hostileError = {
      get message(): never {
        throw new Error('message getter must not run');
      },
      [Symbol.toPrimitive](): never {
        throw new Error('coercion must stay contained');
      },
    };
    const remove = vi.fn()
      .mockRejectedValueOnce(hostileError)
      .mockResolvedValueOnce(undefined);
    const preparation = createPendingWorktreePreparation(primitives({ create, remove }));

    await expect(preparation.prepare({
      kind: 'manual',
      repositories: [
        { sourcePath: '/repos/alpha', childName: 'alpha' },
        { sourcePath: '/repos/beta', childName: 'beta' },
        { sourcePath: '/repos/gamma', childName: 'gamma' },
      ],
      layout: { kind: 'group', parentRoot: '/repos' },
      title: 'Frozen title',
      prompt: 'Frozen prompt',
      pushForRiff: false,
    })).resolves.toEqual({
      kind: 'unknown',
      message: 'manual worktree cleanup outcome is unknown after refusal for /repos/gamma: '
        + '/repos/opening-slug/alpha: unknown thrown value',
    });
    expect(remove.mock.calls).toEqual([
      ['/repos/alpha', '/repos/opening-slug/alpha'],
      ['/repos/beta', '/repos/opening-slug/beta'],
    ]);
  });
});
