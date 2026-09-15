// Heuristic, fail-closed source-export audit. Never prints matched secret values.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const releaseFiles = [
  '.gitattributes', '.gitignore',
  'README.md', 'SECURITY.md', 'package.json', 'cordis.patch.yml',
  'index.js', 'core.js', 'client.js', 'scripts/privacy-check.mjs',
  'test/client.test.js', 'test/core.test.js', 'test/host.test.js'
];
const root = fileURLToPath(new URL('../', import.meta.url));
const dummyKeys = new Set(['sk-or-test-model-key-123456', 'sk-or-management-key-1234567890']);
const rules = [
  ['Windows user path', /[a-z]:[\\/]+Users[\\/]+[^\s"'`<>\\/]+/ig],
  ['POSIX user path', /\/(?:home|Users)\/[^\s"'`<>/]+/g],
  ['Real-looking generation identifier', /\bgen-[A-Za-z0-9_-]{18,}\b/g],
  ['Real-looking session identifier', /\bsession-[0-9a-f]{8}-[0-9a-f-]{27,}\b/ig],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['Private-key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['JWT-shaped token', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/g],
  ['Personal email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/ig],
  ['Machine-local URL', /https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(?=[:/\s"'])/g]
];
let failures = 0;
const report = (file, rule) => { failures++; console.error(`${file}: ${rule}`); };
for (const file of releaseFiles) {
  let text;
  try { text = await readFile(resolve(root, file), 'utf8'); }
  catch { report(file, 'Expected release file missing or unreadable'); continue; }
  for (const [label, pattern] of rules) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) report(file, label);
  }
  const keyPattern = /\bsk-or-[A-Za-z0-9_-]{12,}\b/g;
  for (const match of text.matchAll(keyPattern)) if (!dummyKeys.has(match[0])) report(file, 'Non-fixture OpenRouter key');
  // The publisher may supply local identity terms in memory; they are never
  // embedded in this repository or printed in the report.
  for (const term of (process.env.PRIVACY_TERMS || '').split('|').filter(Boolean)) {
    if (text.toLowerCase().includes(term.toLowerCase())) report(file, 'Private audit term');
  }
}
if (process.env.PRIVACY_FILE_LIST) {
  const listed = (await readFile(process.env.PRIVACY_FILE_LIST, 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  for (const file of listed) if (!releaseFiles.includes(file)) report(file, 'Not on the release allowlist');
  for (const file of releaseFiles) if (!listed.includes(file)) report(file, 'Missing from the Git export');
}
if (failures) { console.error(`Privacy check failed (${failures} findings).`); process.exitCode = 1; }
else console.log(`Privacy check passed for ${releaseFiles.length} allowlisted files. Synthetic test fixtures only; manual review is still required.`);
