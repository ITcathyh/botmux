// Markdown rendering for dashboard session-card exchange previews.
//
// Bot replies posted via `botmux send` are Markdown; the preview overlay
// renders them so `**bold**` / `` `code` `` / lists / links read as formatting
// instead of raw syntax. Mirrors the hardening of insights.ts's prompt
// renderer (html:false blocks raw HTML injection, links open in a new tab with
// noopener) but is kept standalone so the sessions page doesn't pull in the
// insights model module.
import MarkdownIt from 'markdown-it';
import { escapeHtml } from './ui.js';

const previewMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
previewMd.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url.trim());
const linkOpen = previewMd.renderer.rules.link_open;
previewMd.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('target', '_blank');
  tokens[idx]!.attrSet('rel', 'noopener noreferrer nofollow');
  return linkOpen ? linkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

/** Render preview Markdown to sanitized HTML. Raw HTML is disabled at the
 *  parser level; on any failure we fall back to an escaped plain-text
 *  paragraph so a malformed marker can never break the card. */
export function previewMarkdownHtml(text: string): string {
  const source = String(text ?? '');
  if (!source.trim()) return '';
  try {
    const html = previewMd.render(source).trim();
    return html || `<p>${escapeHtml(source)}</p>`;
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  }
}
