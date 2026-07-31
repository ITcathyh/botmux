/**
 * team-bot-directory：平台团队名册 + 联邦（本地托管 + spoke→hub HTTP）三源合并目录。
 * Run: pnpm vitest run test/team-bot-directory.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readLocalTeamBotDirectory, fetchRemoteHubBotDirectory, fetchTeamBotDirectory,
  hasAnyTeamDirectorySource,
} from '../src/services/team-bot-directory.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'team-bot-dir-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writePlatformSync(teams: any[]) {
  writeFileSync(join(dir, 'platform-team-sync.json'), JSON.stringify({ rev: 'r1', teams, updatedAt: Date.now() }));
}
function writeHostedFederations(teams: Record<string, any[]>) {
  writeFileSync(join(dir, 'federations.json'), JSON.stringify({ version: 1, teams }));
}
function writeMemberships(memberships: Record<string, any>) {
  writeFileSync(join(dir, 'federation-memberships.json'), JSON.stringify(memberships));
}

const SG_TEAM = [{
  teamId: 't1', teamName: '大厅', groupChatIds: [], memberUnionIds: [],
  bots: [
    { appId: 'cli_sg1', unionId: 'on_x', name: 'botmux开发者(claude@sg1)' },
    { appId: 'cli_cn2', name: 'Botmux开发者(claude@cn2)' },
    { appId: 'cli_noname' },
  ],
}];

describe('readLocalTeamBotDirectory（平台名册 + 本机托管联邦）', () => {
  it('reads platform team sync bots with platform source tag', () => {
    writePlatformSync(SG_TEAM);
    const out = readLocalTeamBotDirectory(dir);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ larkAppId: 'cli_sg1', botName: 'botmux开发者(claude@sg1)', source: 'platform:t1' });
  });

  it('reads hosted federation deployments with federation source tag incl. teamId/depName', () => {
    writeHostedFederations({
      default: [{ deploymentId: 'dep_1', name: 'sg-box', syncToken: 'x', joinedAt: 1, lastSeenAt: 2, bots: [
        { larkAppId: 'cli_fed', botName: 'Codex远程', cliId: 'codex' },
      ] }],
    });
    const out = readLocalTeamBotDirectory(dir);
    expect(out).toEqual([{ larkAppId: 'cli_fed', botName: 'Codex远程', source: 'federation:default/sg-box' }]);
  });

  it('dedupes the same appId appearing in both sources (first wins)', () => {
    writePlatformSync(SG_TEAM);
    writeHostedFederations({
      default: [{ deploymentId: 'dep_1', name: 'sg-box', syncToken: 'x', joinedAt: 1, lastSeenAt: 2, bots: [
        { larkAppId: 'cli_sg1', botName: 'botmux开发者(claude@sg1)', cliId: 'claude-code' },
      ] }],
    });
    const out = readLocalTeamBotDirectory(dir);
    expect(out.filter(b => b.larkAppId === 'cli_sg1')).toHaveLength(1);
    expect(out.find(b => b.larkAppId === 'cli_sg1')!.source).toBe('platform:t1');
  });

  it('empty dataDir → empty directory and no sources', () => {
    expect(readLocalTeamBotDirectory(dir)).toEqual([]);
    expect(hasAnyTeamDirectorySource(dir)).toBe(false);
  });
});

describe('fetchRemoteHubBotDirectory（spoke→hub HTTP）', () => {
  it('fetches hub roster with Bearer syncToken and tags deployment', async () => {
    writeMemberships({ 'http://hub:1::default': { hubUrl: 'http://hub:1', teamId: 'default', teamName: '默认团队', syncToken: 'tok_1', deploymentId: 'dep_me', joinedAt: 1 } });
    const fetcher = vi.fn(async (_url: string, _init?: any) => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, bots: [
        { larkAppId: 'cli_sg1', name: 'botmux开发者(claude@sg1)', deployment: { name: 'sg1' } },
      ] }),
    }));
    const out = await fetchRemoteHubBotDirectory(dir, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('http://hub:1/api/federation/roster');
    expect((init as any).headers.authorization).toBe('Bearer tok_1');
    expect(out).toEqual([{ larkAppId: 'cli_sg1', botName: 'botmux开发者(claude@sg1)', source: 'http://hub:1/sg1' }]);
  });

  it('single-hub failure does not poison other hubs / local sources', async () => {
    writeMemberships({
      'http://bad::default': { hubUrl: 'http://bad', teamId: 'default', teamName: 'a', syncToken: 't1', deploymentId: 'd1', joinedAt: 1 },
      'http://good::default': { hubUrl: 'http://good', teamId: 'default', teamName: 'b', syncToken: 't2', deploymentId: 'd2', joinedAt: 1 },
    });
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).startsWith('http://bad')) throw new Error('conn refused');
      return { ok: true, status: 200, json: async () => ({ ok: true, bots: [{ larkAppId: 'cli_g', name: 'G' }] }) };
    });
    const out = await fetchRemoteHubBotDirectory(dir, { fetcher });
    expect(out).toEqual([{ larkAppId: 'cli_g', botName: 'G', source: 'http://good' }]);
  });

  it('non-ok hub response is skipped', async () => {
    writeMemberships({ 'http://hub::default': { hubUrl: 'http://hub', teamId: 'default', teamName: 'a', syncToken: 't', deploymentId: 'd', joinedAt: 1 } });
    const fetcher = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'unknown_token' }) }));
    expect(await fetchRemoteHubBotDirectory(dir, { fetcher })).toEqual([]);
  });
});

describe('fetchTeamBotDirectory（三源合并）', () => {
  it('merges all sources and dedupes cross-source duplicates', async () => {
    writePlatformSync(SG_TEAM);
    writeMemberships({ 'http://hub::default': { hubUrl: 'http://hub', teamId: 'default', teamName: 'a', syncToken: 't', deploymentId: 'd', joinedAt: 1 } });
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, bots: [
      { larkAppId: 'cli_sg1', name: 'botmux开发者(claude@sg1)', deployment: { name: 'sg1' } },  // dup of platform
      { larkAppId: 'cli_extra', name: 'Extra', deployment: { name: 'sg1' } },
    ] }) }));
    const out = await fetchTeamBotDirectory(dir, { fetcher });
    expect(out.map(b => b.larkAppId).sort()).toEqual(['cli_cn2', 'cli_extra', 'cli_sg1']);
    expect(out.find(b => b.larkAppId === 'cli_sg1')!.source).toBe('platform:t1');
  });
});

describe('hasAnyTeamDirectorySource', () => {
  it('true with only a membership', () => {
    writeMemberships({ 'http://hub::default': { hubUrl: 'http://hub', teamId: 'default', teamName: 'a', syncToken: 't', deploymentId: 'd', joinedAt: 1 } });
    expect(hasAnyTeamDirectorySource(dir)).toBe(true);
  });
  it('true with only hosted federation members', () => {
    writeHostedFederations({ default: [{ deploymentId: 'dep_1', name: 'x', syncToken: 's', joinedAt: 1, lastSeenAt: 2, bots: [] }] });
    expect(hasAnyTeamDirectorySource(dir)).toBe(true);
  });
});
