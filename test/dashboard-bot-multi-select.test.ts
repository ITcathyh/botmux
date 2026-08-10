/**
 * dashboard-bot-multi-select.test.ts
 *
 * Render tests for the shared searchable bot multi-select (used by the
 * new-group modal, add-bots dialog, and create-session composer). Verifies:
 *  - every row emits a real `<input type="checkbox" name="bot">` so callers
 *    submitting through a <form> can still read ids via FormData.getAll('bot');
 *  - `checked` reflects the controlled `selected` Set;
 *  - the empty roster renders the empty label, not the list;
 *  - the selected-count label appears only when something is selected.
 *
 * The search box filters client-side via component-local state, which
 * renderToStaticMarkup cannot drive (no events); the filtering predicate is
 * exercised indirectly — full-roster render shows all rows, matching the
 * create-session behavior the shared component replaced.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BotMultiSelect } from '../src/dashboard/web/bot-multi-select.js';

const BOTS = [
  { larkAppId: 'cli_a', botName: 'Alpha(Claude)' },
  { larkAppId: 'cli_b', botName: 'Beta(Codex)' },
  { larkAppId: 'cli_c', botName: 'Gamma' },
];

function render(props: Partial<Parameters<typeof BotMultiSelect>[0]> = {}): string {
  return renderToStaticMarkup(createElement(BotMultiSelect, {
    bots: BOTS,
    selected: new Set<string>(),
    onToggle: () => {},
    searchPlaceholder: 'search',
    noMatchLabel: 'no-match',
    emptyLabel: 'empty',
    selectedCountLabel: (n: number) => `${n} selected`,
    ...props,
  }));
}

describe('BotMultiSelect', () => {
  it('renders one name="bot" checkbox per bot (FormData contract)', () => {
    const html = render();
    const checkboxes = html.match(/type="checkbox"[^>]*name="bot"/g) ?? [];
    expect(checkboxes.length).toBe(BOTS.length);
    // each bot's larkAppId appears as an input value
    for (const bot of BOTS) expect(html).toContain(`value="${bot.larkAppId}"`);
  });

  it('honors a custom inputName for FormData', () => {
    const html = render({ inputName: 'targetBot' });
    expect(html).toContain('name="targetBot"');
    expect(html).not.toContain('name="bot"');
  });

  it('reflects the controlled selected Set in checked state', () => {
    const html = render({ selected: new Set(['cli_b']) });
    // exactly one checkbox is checked, and it is Beta's
    const checkedCount = (html.match(/checked=""|checked="checked"/g) ?? []).length;
    expect(checkedCount).toBe(1);
    // the checked input carries cli_b's value
    expect(/value="cli_b"[^>]*checked|checked[^>]*value="cli_b"/.test(html)).toBe(true);
  });

  it('shows the selected-count label only when something is selected', () => {
    expect(render({ selected: new Set() })).not.toContain('selected');
    expect(render({ selected: new Set(['cli_a', 'cli_c']) })).toContain('2 selected');
  });

  it('renders the empty label (not the list) for an empty roster', () => {
    const html = render({ bots: [] });
    expect(html).toContain('empty');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('type="search"');
  });

  it('renders the search box and all rows for a non-empty roster', () => {
    const html = render();
    expect(html).toContain('type="search"');
    for (const bot of BOTS) expect(html).toContain(bot.botName);
  });
});
