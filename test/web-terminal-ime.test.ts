import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-level regression guard for the iOS third-party IME fix injected into
// the web terminal page (getTerminalHtml in src/worker.ts). That block is a
// string of browser JS, so — like web-terminal-touch-scroll.test.ts — we assert
// on its source rather than execute a DOM. These assertions lock the two
// double-emit hardening invariants a Codex review flagged (composed gate +
// _claim reset on keydown/blur, not just keyup) so a future edit can't silently
// regress them, plus the core dead-path takeover behaviour.
const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

function imeBlock(): string {
  const start = workerSource.indexOf('// ── iOS third-party IME fix');
  const end = workerSource.indexOf('})();}', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // include the closing IIFE
  return workerSource.slice(start, end + '})();}'.length);
}

describe('web terminal iOS IME fix', () => {
  it('claims the keyCode=229 dead path (returns false so xterm skips its broken fallback)', () => {
    const block = imeBlock();
    expect(block).toContain('if(e.keyCode===229){ _claim=true; return false; }');
  });

  it('claims Backspace ONLY when the textarea is non-empty (empty = normal terminal backspace)', () => {
    const block = imeBlock();
    // The non-empty guard is what keeps a plain shell-line backspace flowing to
    // xterm (which sends its standard \x7f) instead of being swallowed.
    expect(block).toContain('if(e.keyCode===8 && _ta && _ta.value.length>0){ _claim=true; return false; }');
  });

  it('resets _claim at the START of every keydown (iOS IME keys often fire no keyup)', () => {
    const block = imeBlock();
    // Must reset before deciding to claim, so a stuck-open _claim from a prior
    // cycle (missing keyup) cannot leak into the next key.
    const keydownIdx = block.indexOf("if(e.type==='keydown'){");
    const resetIdx = block.indexOf('_claim=false;', keydownIdx);
    const claim229Idx = block.indexOf('if(e.keyCode===229)', keydownIdx);
    expect(keydownIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(keydownIdx);
    // reset happens before the claim decision
    expect(resetIdx).toBeLessThan(claim229Idx);
  });

  it('also closes the cycle on keyup AND blur (belt-and-suspenders against stuck-open _claim)', () => {
    const block = imeBlock();
    expect(block).toContain("_ta.addEventListener('keyup',function(){_claim=false;}");
    expect(block).toContain("_ta.addEventListener('blur',function(){_claim=false;}");
  });

  it('forwards inserted text ONLY when composed (mutually exclusive with xterm’s own _inputEvent)', () => {
    const block = imeBlock();
    // A composed=false insertText is one xterm's _inputEvent will emit itself
    // (its guard passes when !composed); gating our forward on e.composed keeps
    // the two paths from both firing = the double-emit fix.
    expect(block).toContain('if(e.data&&e.composed){try{term.input(e.data,true)}catch(_e){}}');
    expect(block).not.toContain('if(e.data){try{term.input(e.data,true)}catch(_e){}}');
  });

  it('maps each textarea delete to one terminal backspace (whole-run erase stays 1:1)', () => {
    const block = imeBlock();
    expect(block).toContain("if(it.indexOf('delete')===0){");
    expect(block).toContain("term.input('\\\\x7f',true)");
  });

  it('never takes over while a real composition is active (WeChat Chinese stays on xterm)', () => {
    const block = imeBlock();
    expect(block).toContain("_ta.addEventListener('compositionstart',function(){_composing=true;_claim=false;}");
    expect(block).toContain("_ta.addEventListener('compositionend',function(){_composing=false;_claim=false;}");
    // the input handler bails while composing
    expect(block).toContain('if(!_claim||_composing)return;');
  });

  it('uses term.input (not term.paste) so per-char input is not bracketed-paste-wrapped', () => {
    const block = imeBlock();
    expect(block).toContain('term.input(e.data,true)');
    expect(block).not.toContain('term.paste(e.data)');
  });

  it('is gated behind hasToken and an ?imefix=0 escape hatch', () => {
    const block = imeBlock();
    expect(block).toContain('if(hasToken && !/[?&]imefix=0');
  });
});
