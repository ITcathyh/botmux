import type { ProjectInfo } from '../../services/project-scanner.js';
import type {
  PendingTraexInitialization,
  TraexInitializationMode,
} from '../../core/traex-initialization.js';
import { TRAEX_INITIAL_PROMPT_MAX_LENGTH } from '../../core/traex-initialization.js';
import { t, type Locale } from '../../i18n/index.js';

export const TRAEX_INIT_ACTION_START = 'traex_init_start';
export const TRAEX_INIT_ACTION_CANCEL = 'traex_init_cancel';

function callback(value: Record<string, unknown>): Array<Record<string, unknown>> {
  return [{ type: 'callback', value }];
}

function actionValue(
  action: string,
  rootId: string,
  nonce: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { action, root_id: rootId, nonce, ...extra };
}

function startButton(
  mode: TraexInitializationMode,
  text: string,
  type: string,
  rootId: string,
  nonce: string,
): Record<string, unknown> {
  return {
    tag: 'button',
    name: `traex_init_start_${mode}`,
    text: { tag: 'plain_text', content: text },
    type,
    action_type: 'form_submit',
    value: actionValue(TRAEX_INIT_ACTION_START, rootId, nonce, { mode }),
  };
}

export function buildTraexInitializationCard(input: {
  rootId: string;
  pending: PendingTraexInitialization;
  projects: ProjectInfo[];
  locale?: Locale;
}): string {
  const { rootId, pending, projects, locale } = input;
  const repoOptions = projects.map((project, index) => ({
    text: {
      tag: 'plain_text',
      content: `📁 ${index + 1}. ${project.name} (${project.branch})${project.type === 'worktree' ? ' [worktree]' : ''}`,
    },
    value: `dir:${project.path}`,
  }));
  const worktreeOptions = projects
    .filter(project => project.type === 'repo')
    .map(project => ({
      text: { tag: 'plain_text', content: `🌿 ${project.name} (${project.branch})` },
      value: `worktree:${project.path}`,
    }));
  const targetOptions = [...repoOptions, ...worktreeOptions];

  const selectedPath = pending.selection.kind === 'worktree'
    ? pending.selection.repoPaths[0]
    : pending.selection.path;
  const selectedTarget = pending.selection.kind === 'worktree' || pending.selection.kind === 'auto-worktree'
    ? `worktree:${selectedPath}`
    : `dir:${selectedPath}`;
  const selectedLabel = pending.selection.kind === 'worktree'
    ? t('card.traex_init.selection_worktree', { name: pending.selection.label }, locale)
    : pending.selection.kind === 'auto-worktree'
      ? t('card.traex_init.selection_auto_worktree', { path: pending.selection.path }, locale)
      : pending.selection.label;

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: t('card.traex_init.intro', undefined, locale),
    },
    {
      tag: 'markdown',
      content: `${t('card.traex_init.selected_dir', undefined, locale)} **${selectedLabel}**`,
    },
    {
      tag: 'form',
      name: 'traex_initialization_form',
      elements: [
        ...(targetOptions.length > 0 ? [{
          tag: 'select_static',
          name: 'traex_init_target',
          width: 'fill',
          initial_option: targetOptions.some(option => option.value === selectedTarget) ? selectedTarget : undefined,
          placeholder: { tag: 'plain_text', content: t('card.traex_init.target_placeholder', undefined, locale) },
          options: targetOptions,
        }] : []),
        {
          tag: 'input',
          name: 'traex_init_manual_path',
          width: 'fill',
          placeholder: { tag: 'plain_text', content: t('card.traex_init.manual_placeholder', undefined, locale) },
        },
        {
          tag: 'input',
          name: 'initial_prompt',
          label: { tag: 'plain_text', content: t('card.traex_init.prompt_label', undefined, locale) },
          default_value: pending.originalPrompt,
          placeholder: { tag: 'plain_text', content: t('card.traex_init.prompt_placeholder', undefined, locale) },
          input_type: 'multiline_text',
          rows: 6,
          max_rows: 12,
          auto_resize: true,
          width: 'fill',
          max_length: TRAEX_INITIAL_PROMPT_MAX_LENGTH,
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: 'small',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              vertical_align: 'center',
              elements: [
                startButton('traex', t('card.traex_init.start_traex', undefined, locale), 'default', rootId, pending.nonce),
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              vertical_align: 'center',
              elements: [
                startButton('forge-pipeline', t('card.traex_init.start_pipeline', undefined, locale), 'primary_filled', rootId, pending.nonce),
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              vertical_align: 'center',
              elements: [
                startButton('forge-pilot', t('card.traex_init.start_pilot', undefined, locale), 'default', rootId, pending.nonce),
              ],
            },
          ],
        },
      ],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.traex_init.cancel', undefined, locale) },
      type: 'danger',
      width: 'fill',
      behaviors: callback(actionValue(TRAEX_INIT_ACTION_CANCEL, rootId, pending.nonce)),
    },
  ];

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: t('card.traex_init.title', undefined, locale) },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'medium',
      elements,
    },
  });
}

export function buildTraexInitializationCancelledCard(locale?: Locale): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: t('card.traex_init.cancelled_title', undefined, locale) },
    },
    body: {
      elements: [
        { tag: 'markdown', content: t('card.traex_init.cancelled_body', undefined, locale) },
      ],
    },
  });
}
