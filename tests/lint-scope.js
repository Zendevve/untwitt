// Scope linter for the untwitt project.
//
// Walks src/ and enforces three rules:
//   1. data-testid is only referenced inside src/content/x-adapter.js. The
//      adapter is the single source of truth for X DOM selectors, and any
//      other .js file embedding a data-testid string violates the
//      isolation contract.
//   2. Files under src/ and src/popup/ may only import modules under src/.
//      No relative paths climbing out of the src tree, no absolute paths.
//   3. Files under src/ may not contain "https://" or "http://" unless the
//      URL is inside a JSDoc comment that explicitly identifies itself as
//      documentation.
//
// Exit 0 on success, exit 1 with diagnostics on any violation.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, 'src');
const ALLOWED_TESTID_FILE = join('content', 'x-adapter.js');

function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) {
      out.push(...walkJsFiles(full));
    } else if (st.isFile() && entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function relPath(abs) {
  return relative(PROJECT_ROOT, abs).split(sep).join('/');
}

function stripJSDocComments(source) {
  // Replace each /** ... */ block with whitespace of equivalent length so
  // line/column numbers in remaining matches are still meaningful.
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => {
    let out = '';
    let inJsDoc = false;
    for (let i = 0; i < block.length; i += 1) {
      const ch = block[i];
      if (!inJsDoc && ch === '*' && block[i - 1] === '/' && i > 0) {
        inJsDoc = true;
        out += '  ';
        continue;
      }
      if (inJsDoc && ch === '/' && block[i - 1] === '*') {
        inJsDoc = false;
        out += '  ';
        continue;
      }
      if (inJsDoc) {
        out += ch === '\n' ? '\n' : ' ';
      } else {
        out += ch;
      }
    }
    return out;
  });
}

function isJSDocDocumentingComment(commentText) {
  // The JSDoc body must explicitly contain the word "documentation" or
  // match patterns that indicate a documented URL is allowed. We accept
  // the marker words "documentation", "Documentation", "docs", or "Docs".
  return /(documentation|^|\s)docs?(\b|\s)/i.test(commentText);
}

const violations = [];

function addViolation(file, line, message) {
  violations.push({ file: relPath(file), line, message });
}

function lintDataTestId(file, source) {
  const rel = relPath(file);
  if (rel === relPath(join(SRC_ROOT, ALLOWED_TESTID_FILE))) return;
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('data-testid')) {
      addViolation(file, i + 1, 'data-testid must only appear in src/content/x-adapter.js');
    }
  }
}

const IMPORT_RE = /^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"];?/gm;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function lintImports(file, source) {
  const rel = relPath(file);
  // This rule only applies to src/ and src/popup/.
  if (!rel.startsWith('src/')) return;
  // service-worker.js is a classic script under src/background/ -- the
  // "no out-of-tree imports" rule does apply to it via the next branch.
  const checks = [];
  let m;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    checks.push(m[1]);
  }
  while ((m = REQUIRE_RE.exec(source)) !== null) {
    checks.push(m[1]);
  }
  for (const target of checks) {
    if (target.startsWith('.')) {
      // Resolve the relative path. If it escapes src/, that's a violation.
      const dir = file.substring(0, file.lastIndexOf(sep));
      const targetAbs = join(dir, target);
      const normalized = targetAbs.split(sep).join('/');
      if (!normalized.replace(/\\/g, '/').includes('/src/')) {
        // Relativize to confirm the path climbs out of src.
        const r = relPath(targetAbs);
        if (r.startsWith('../')) {
          addViolation(file, 0, `import path climbs out of src/: ${target} -> ${r}`);
        }
      }
    } else if (/^[a-zA-Z][a-zA-Z0-9_@/-]*$/.test(target) && !target.startsWith('@')) {
      // Bare module specifier (a npm dependency or built-in). This is
      // allowed; the project may not have any today, but the rule
      // specifies "relative path going up out of src" or "absolute path".
    } else if (target.startsWith('/')) {
      addViolation(file, 0, `absolute import path not allowed: ${target}`);
    }
  }
}

function lintUrls(file, source) {
  const rel = relPath(file);
  if (!rel.startsWith('src/')) return;
  // Strip JSDoc blocks first.
  const stripped = stripJSDocComments(source);
  // Now look for http:// or https:// in the remainder. JSDoc blocks that
  // declare themselves "documentation" are allowed to keep URLs, but the
  // strip already removed them.
  const lines = stripped.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (/https?:\/\//.test(lines[i])) {
      addViolation(file, i + 1, `non-documentation URL found: ${lines[i].trim()}`);
    }
  }

  // Verify that any URL inside a JSDoc comment that survived stripping is
  // explicitly documentation. The strip replaced comments with spaces; we
  // instead re-scan the raw source to make sure each URL-bearing JSDoc
  // block contains the word "documentation" or "docs".
  const urlRe = /https?:\/\/[^\s'"<>)]+/g;
  const commentRe = /\/\*\*[\s\S]*?\*\//g;
  let m;
  while ((m = commentRe.exec(source)) !== null) {
    const block = m[0];
    if (!urlRe.test(block)) {
      urlRe.lastIndex = 0;
      continue;
    }
    urlRe.lastIndex = 0;
    if (!isJSDocDocumentingComment(block)) {
      // Find the first line of this block to report a useful location.
      const before = source.slice(0, m.index);
      const startLine = (before.match(/\n/g) || []).length + 1;
      addViolation(
        file,
        startLine,
        'URL inside a non-documentation JSDoc block is not allowed',
      );
    }
  }
}

function main() {
  const files = walkJsFiles(SRC_ROOT);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    lintDataTestId(file, source);
    lintImports(file, source);
    lintUrls(file, source);
  }

  if (violations.length === 0) {
    console.log('LINT-SCOPE: PASS');
    process.exit(0);
  }

  for (const v of violations) {
    console.error(`${v.file}:${v.line}: ${v.message}`);
  }
  console.error(`LINT-SCOPE: FAIL (${violations.length} violation${violations.length === 1 ? '' : 's'})`);
  process.exit(1);
}

main();
