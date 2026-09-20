#!/usr/bin/env python3
from pathlib import Path

p = Path('src/lib/download.js')
s = p.read_text()
if 'js too small' in s:
    print('download already')
else:
    old = """        if (!buf || buf.length < 16) {
          lastErr = 'empty body';
          await sleep(200 * 2 ** attempt);
          continue;
        }
        if (job.name.endsWith('.js')) {
          const head = buf.slice(0, 80).toString('utf8');"""
    new = """        if (!buf || buf.length < 16) {
          lastErr = 'empty body';
          await sleep(200 * 2 ** attempt);
          continue;
        }
        if (job.name.endsWith('.js')) {
          if (buf.length < 64) {
            lastErr = 'js too small (' + buf.length + 'B)';
            await sleep(200 * 2 ** attempt);
            continue;
          }
          const head = buf.slice(0, 80).toString('utf8');"""
    if old not in s:
        raise SystemExit('download block not found')
    p.write_text(s.replace(old, new, 1))
    print('download patched')

p2 = Path('src/index.js')
s2 = p2.read_text()
if 'if (e == null) continue' in s2:
    print('mergeExp already')
else:
    old = """function mergeExp(prev, next) {
  const map = new Map();
  for (const e of prev || []) {
    const id = e && (e.id || e);
    if (id) map.set(String(id), typeof e === 'object' ? e : { id: String(e) });
  }
  for (const e of next || []) {
    if (e && e.id) map.set(String(e.id), e);
  }
  return [...map.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
}"""
    new = """function mergeExp(prev, next) {
  const map = new Map();
  for (const e of prev || []) {
    if (e == null) continue;
    if (typeof e === 'object') {
      if (!e.id) continue;
      map.set(String(e.id), e);
    } else if (e !== '') {
      map.set(String(e), { id: String(e) });
    }
  }
  for (const e of next || []) {
    if (!e || typeof e !== 'object' || !e.id) continue;
    map.set(String(e.id), e);
  }
  return [...map.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
}"""
    if old not in s2:
        raise SystemExit('mergeExp not found')
    p2.write_text(s2.replace(old, new, 1))
    print('mergeExp patched')
