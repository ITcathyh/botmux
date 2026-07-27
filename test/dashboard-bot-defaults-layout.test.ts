import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/dashboard/web/i18n.ts', import.meta.url), 'utf8');

describe('bot defaults focused layout', () => {
  it('keeps every task panel mounted while hiding inactive categories', () => {
    for (const tab of ['common', 'sessions', 'security', 'cards', 'advanced']) {
      expect(page).toContain(`id="bd-panel-${tab}"`);
      expect(page).toContain(`hidden={props.activeTab !== '${tab}'}`);
    }

    expect(page).toContain('<BotAgentSection');
    expect(page).toContain('<SessionModeSection');
    expect(page).toContain('<SandboxSection');
    expect(page).toContain('<CardBehaviorSection');
    expect(page).toContain('<RuntimeEnvironmentSection');
  });

  it('uses content-width-driven cards and a bounded mobile roster', () => {
    expect(css).toContain('container-type: inline-size');
    expect(css).toMatch(/\.bot-defaults-page \.bd-tab-grid\s*\{[\s\S]*?repeat\(auto-fit,\s*minmax\(min\(100%, 500px\), 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.bot-defaults-page \.bd-roster-list\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(180px,\s*1fr\)\);[\s\S]*?overflow-y:\s*auto;/);
  });

  it('gives the mobile roster list a real scrollport instead of clipping', () => {
    // Grid auto rows keep max-content height, so the list row must be
    // forced into the remaining space (minmax(0,1fr) + min-height:0) or
    // overflow-y:auto never produces a scrollport and long rosters clip.
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.bot-defaults-page \.bd-roster\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\(0,\s*1fr\);/);
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.bot-defaults-page \.bd-roster-list\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  });

  it('ships localized labels for every task category', () => {
    for (const key of ['tabCommon', 'tabSessions', 'tabSecurity', 'tabCards', 'tabAdvanced']) {
      expect(i18n.match(new RegExp(`'botDefaults\\.${key}'`, 'g'))).toHaveLength(2);
    }
  });
});
