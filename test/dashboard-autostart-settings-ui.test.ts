import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AutostartState } from '../src/autostart.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { AutostartCard } from '../src/dashboard/web/settings-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function state(overrides: Partial<AutostartState> = {}): AutostartState {
  return {
    supported: true,
    platform: 'macos',
    manager: 'launchd',
    scope: 'user-login',
    registration: 'enabled',
    enabled: true,
    installed: true,
    loaded: false,
    active: false,
    managerReachable: true,
    manageable: true,
    lingerEnabled: null,
    targetExists: true,
    targetMatchesCurrentRuntime: true,
    localDevTarget: false,
    warnings: ['pending_login'],
    ...overrides,
  };
}

function render(overrides: Partial<React.ComponentProps<typeof AutostartCard>> = {}) {
  const props: React.ComponentProps<typeof AutostartCard> = {
    canWrite: true,
    desktopShell: false,
    state: state(),
    loading: false,
    error: null,
    busy: false,
    message: null,
    onChange: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(React.createElement(AutostartCard, props)); });
  return { renderer, props };
}

describe('Dashboard autostart settings UI', () => {
  it('shows the platform manager, authoritative toggle, and next-login semantics', () => {
    const { renderer } = render();
    const checkbox = renderer.root.findByProps({ type: 'checkbox' });
    const target = renderer.root.findByProps({ 'data-autostart-target-status': 'healthy' });
    const json = JSON.stringify(renderer.toJSON());

    expect(checkbox.props.checked).toBe(true);
    expect(checkbox.props.disabled).toBe(false);
    expect(JSON.stringify(target.children)).toContain('启动目标健康');
    expect(json).toContain('macOS · launchd');
    expect(json).toContain('下次登录');
  });

  it('invokes the requested boolean and disables the toggle while saving', () => {
    const onChange = vi.fn();
    const normal = render({ onChange });
    const checkbox = normal.renderer.root.findByProps({ type: 'checkbox' });
    act(() => checkbox.props.onChange({ currentTarget: { checked: false } }));
    expect(onChange).toHaveBeenCalledWith(false);

    const busy = render({ busy: true });
    expect(busy.renderer.root.findByProps({ type: 'checkbox' }).props.disabled).toBe(true);
  });

  it('offers explicit enable/disable recovery when registration is partial', () => {
    const onChange = vi.fn();
    const { renderer } = render({
      onChange,
      state: state({
        registration: 'partial',
        enabled: null,
        warnings: ['registration_partial'],
      }),
    });
    expect(renderer.root.findAllByProps({ type: 'checkbox' })).toHaveLength(0);
    const buttons = renderer.root.findAllByType('button');
    const enable = buttons.find(button => JSON.stringify(button.props.children).includes('启用自启'))!;
    const disable = buttons.find(button => JSON.stringify(button.props.children).includes('关闭自启'))!;
    act(() => enable.props.onClick());
    act(() => disable.props.onClick());
    expect(onChange).toHaveBeenNthCalledWith(1, true);
    expect(onChange).toHaveBeenNthCalledWith(2, false);
  });

  it('blocks enable but still permits cleanup when the runtime target is unavailable', () => {
    const { renderer } = render({
      state: state({
        registration: 'partial',
        enabled: null,
        targetExists: false,
        targetMatchesCurrentRuntime: null,
        warnings: ['registration_partial', 'target_missing'],
      }),
    });
    const buttons = renderer.root.findAllByType('button');
    const enable = buttons.find(button => JSON.stringify(button.props.children).includes('启用自启'))!;
    const disable = buttons.find(button => JSON.stringify(button.props.children).includes('关闭自启'))!;
    expect(enable.props.disabled).toBe(true);
    expect(disable.props.disabled).toBe(false);
    const target = renderer.root.findByProps({ 'data-autostart-target-status': 'missing' });
    expect(JSON.stringify(target.children)).toContain('启动目标不可用');
  });

  it('renders Desktop host status as read-only and points users to Desktop or OS login items', () => {
    const onChange = vi.fn();
    const onRetry = vi.fn();
    const { renderer } = render({ desktopShell: true, onChange, onRetry });
    const json = JSON.stringify(renderer.toJSON());

    expect(renderer.root.findAllByProps({ type: 'checkbox' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-autostart-target-status': 'healthy' })).toBeTruthy();
    expect(json).toContain('Desktop 设置');
    expect(json).toContain('操作系统');
    expect(json).toContain('登录项');
    expect(json).toContain('开机启动 App');

    const buttons = renderer.root.findAllByType('button');
    expect(buttons).toHaveLength(1);
    expect(JSON.stringify(buttons[0].props.children)).toContain('刷新状态');
    act(() => buttons[0].props.onClick());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps stale-target repair in Web mode and hides it in Desktop mode', () => {
    const stale = state({
      targetMatchesCurrentRuntime: false,
      warnings: ['target_mismatch'],
    });
    const web = render({ state: stale });
    expect(web.renderer.root.findByProps({ 'data-autostart-target-status': 'mismatch' })).toBeTruthy();
    expect(JSON.stringify(web.renderer.toJSON())).toContain('重新注册当前版本');

    const desktop = render({ desktopShell: true, state: stale });
    const desktopJson = JSON.stringify(desktop.renderer.toJSON());
    expect(desktop.renderer.root.findAllByProps({ type: 'checkbox' })).toHaveLength(0);
    expect(desktop.renderer.root.findByProps({ 'data-autostart-target-status': 'mismatch' })).toBeTruthy();
    expect(desktopJson).toContain('启动目标需修复');
    expect(desktopJson).not.toContain('重新注册当前版本');
    expect(desktop.renderer.root.findAllByType('button')).toHaveLength(1);
  });

  it('does not request or invent host state for a public read-only visitor', () => {
    const { renderer } = render({ canWrite: false, state: null });
    expect(renderer.root.findAllByProps({ type: 'checkbox' })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('登录 Dashboard');
  });

  it('renders a retry action after an initial status failure', () => {
    const onRetry = vi.fn();
    const { renderer } = render({ state: null, error: 'probe failed', onRetry });
    const button = renderer.root.findByType('button');
    expect(JSON.stringify(renderer.toJSON())).toContain('probe failed');
    act(() => button.props.onClick());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('retains accessible live loading and mutation status announcements', () => {
    const loading = render({ state: null, loading: true });
    const loadingStatus = loading.renderer.root.findByProps({ role: 'status', 'aria-live': 'polite' });
    expect(loadingStatus).toBeTruthy();
    expect(JSON.stringify(loading.renderer.toJSON())).toContain('正在读取系统自启状态');
    expect(loading.renderer.root.findAllByType('button')).toHaveLength(0);

    const busy = render({ busy: true, message: { text: '正在注册开机自启…' } });
    expect(busy.renderer.root.findByProps({ type: 'checkbox' }).props.disabled).toBe(true);
    const mutationStatus = busy.renderer.root.findByProps({ role: 'status', 'aria-live': 'polite' });
    expect(mutationStatus).toBeTruthy();
    expect(JSON.stringify(busy.renderer.toJSON())).toContain('正在注册开机自启');
  });

  it.each([
    {
      kind: 'ready',
      expected: '启动目标就绪',
      value: state({
        registration: 'disabled',
        enabled: false,
        installed: false,
        loaded: false,
        targetMatchesCurrentRuntime: null,
        warnings: [],
      }),
    },
    {
      kind: 'unknown',
      expected: '启动目标待确认',
      value: state({
        registration: 'partial',
        enabled: null,
        targetMatchesCurrentRuntime: null,
        warnings: ['registration_partial'],
      }),
    },
  ])('describes the $kind target state even without an exceptional warning code', ({ kind, expected, value }) => {
    const { renderer } = render({ state: value });
    const target = renderer.root.findByProps({ 'data-autostart-target-status': kind });
    expect(JSON.stringify(target.children)).toContain(expected);
  });

  it('provides equivalent English target-health and Desktop instructions', () => {
    const en = createDashboardTranslator('en');
    expect(en('settings.autostartTargetHealthy')).toContain('Launch target healthy');
    expect(en('settings.autostartTargetMissingStatus')).toContain('Launch target unavailable');
    expect(en('settings.autostartTargetMismatchStatus')).toContain('Launch target needs repair');
    expect(en('settings.autostartTargetUnknownStatus')).toContain('Launch target unverified');
    expect(en('settings.autostartDesktopManaged')).toContain('read-only');
    expect(en('settings.autostartDesktopManaged')).toContain('Login Items');
  });
});
