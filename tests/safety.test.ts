import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** The PS forbids eval() / new Function(): arithmetic must go through our own parser. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|js|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

/** Strip comments but keep "://" inside URLs (the self-tests below check this). */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Online URLs in code (the SVG namespace is an identifier, not a network address). */
export function findUrls(code: string): string[] {
  return (stripComments(code).match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s'"`)]*/gi) ?? []).filter(
    (u) => !/^https?:\/\/www\.w3\.org\//i.test(u),
  );
}

describe('the scanners themselves work (so a green run means something)', () => {
  it('finds a URL in code', () => {
    expect(findUrls(`fetch('https://api.example.com/v1/ocr')`)).toEqual(['https://api.example.com/v1/ocr']);
    expect(findUrls('const u = "http://evil.io/x"; // comment')).toEqual(['http://evil.io/x']);
  });
  it('ignores URLs that are only in comments, and the SVG namespace', () => {
    expect(findUrls('// see https://github.com/x/y\nconst a = 1;')).toEqual([]);
    expect(findUrls('/* https://a.example.com */ const ns = "http://www.w3.org/2000/svg";')).toEqual([]);
  });
});

describe('no dynamic code execution', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('scripts')];

  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('never calls eval() or the Function constructor', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (/(^|[^.\w])eval\s*\(/.test(code) || /new\s+Function\s*\(/.test(code) || /(^|[^.\w])Function\s*\(/.test(code)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('makes no network calls to cloud APIs at runtime (only same-origin assets)', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles('src')) {
      const urls = findUrls(fs.readFileSync(f, 'utf8'));
      if (urls.length > 0) offenders.push(`${f}: ${urls.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
