// Keeps staging secrets out of logs, Playwright errors, reports and CI artifacts.
//   <command> 2>&1 | node scripts/redact-secrets.mjs            # filter: exact values of the env vars named in REDACT_ENV (default list below) + the bypass header pattern
//   node scripts/redact-secrets.mjs --scan test-results playwright-report   # after a run: delete every file that contains a secret value and exit 1 if any did
//   node scripts/redact-secrets.mjs --selftest
// Values come from the environment only; nothing is printed except "<redacted:NAME>".
import { readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const NAMES = (process.env.REDACT_ENV ?? 'STAGED_BYPASS_SECRET,E2E_BYPASS_SECRET,BYPASS,SRK,ANON,PW,E2E_PASSWORD,PGPASSWORD,SERVICE_ROLE_KEY').split(',');
const secrets = () => NAMES.map((n) => [n, process.env[n]]).filter(([, v]) => v && v.length >= 8);
export function redact(text, list = secrets()) {
  let out = text;
  for (const [n, v] of list) out = out.split(v).join(`<redacted:${n}>`);
  return out.replace(/(x-vercel-protection-bypass["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{8,}/gi, '$1<redacted>');
}
function* files(p) { let st; try { st = statSync(p); } catch { return; } if (st.isDirectory()) for (const n of readdirSync(p)) yield* files(join(p, n)); else yield p; }

const [mode, ...dirs] = process.argv.slice(2);
if (mode === '--selftest') {
  const l = [['BYPASS', 'abcDEF1234567890abcDEF1234567890']];
  const t = 'POST x\n  - x-vercel-protection-bypass: abcDEF1234567890abcDEF1234567890\nraw abcDEF1234567890abcDEF1234567890 and x-vercel-protection-bypass=zzzzzzzzzzzz';
  const r = redact(t, l);
  if (/abcDEF|zzzzzz/.test(r) || !r.includes('<redacted:BYPASS>')) { console.error('selftest FAILED'); process.exit(1); }
  console.log('selftest ok'); process.exit(0);
} else if (mode === '--scan') {
  const list = secrets(); let bad = 0;
  for (const d of dirs) for (const f of files(d)) {
    let b; try { b = readFileSync(f, 'latin1'); } catch { continue; }
    if (list.some(([, v]) => b.includes(v)) || /x-vercel-protection-bypass["']?\s*[:=]\s*["']?(?!<redacted)[A-Za-z0-9_-]{16,}/i.test(b)) { bad++; rmSync(f, { force: true }); console.error(`removed ${f}: it contained a secret value`); }
  }
  console.log(bad ? `scan: ${bad} artifact(s) contained a secret and were deleted` : 'scan: no secret in the run artifacts'); process.exit(bad ? 1 : 0);
} else {
  process.stdin.setEncoding('utf8'); let buf = '';
  const list = secrets();
  process.stdin.on('data', (c) => { buf += c; const i = buf.lastIndexOf('\n'); if (i >= 0) { process.stdout.write(redact(buf.slice(0, i + 1), list)); buf = buf.slice(i + 1); } });
  process.stdin.on('end', () => process.stdout.write(redact(buf, list)));
}
