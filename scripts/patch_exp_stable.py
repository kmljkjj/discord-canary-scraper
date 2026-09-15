#!/usr/bin/env python3
"""Stabilize experiment extract + diff (v11.3)."""
from pathlib import Path
import re

def patch_extract():
    p = Path("src/lib/extract.js")
    t = p.read_text()
    if "from + 2800" in t and "looksExp" in t:
        print("extract: already patched")
        return True

    pat = re.compile(r"function countVariationsNear\(content, from\) \{.*?\n\}", re.S)
    new_cv = """function countVariationsNear(content, from) {
  const window = content.slice(from, from + 2800);
  let m = window.match(/variations\\s*:\\s*\\{/);
  if (!m) m = window.match(/treatments\\s*:\\s*\\[/);
  if (!m) m = window.match(/treatments\\s*:\\s*\\{/);
  if (!m) return null;

  const isArray = /treatments\\s*:\\s*\\[/.test(m[0]);
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  for (; i < window.length && depth > 0; i++) {
    if (window[i] === open) depth++;
    else if (window[i] === close) depth--;
  }
  const body = window.slice(start, i - 1);
  const out = {};
  if (isArray) {
    const ids = [...body.matchAll(/\\bid\\s*:\\s*(\\d+)/g)].map((x) => x[1]);
    if (ids.length) {
      for (const k of ids) out[k] = { id: Number(k) };
    } else {
      let n = 0;
      let d = 0;
      for (const ch of body) {
        if (ch === '{') {
          if (d === 0) n++;
          d++;
        } else if (ch === '}') d = Math.max(0, d - 1);
      }
      if (n <= 0) return null;
      for (let k = 0; k < n && k < 40; k++) out[String(k)] = { id: k };
    }
  } else {
    const keys = [...body.matchAll(/(?:^|[,{])\\s*(\\d+)\\s*:/g)].map((x) => x[1]);
    if (!keys.length) return null;
    for (const k of keys) out[k] = { id: Number(k) };
  }
  return Object.keys(out).length ? out : null;
}"""
    m = pat.search(t)
    if not m:
        print("extract: countVariationsNear not found")
        return False
    t = t[: m.start()] + new_cv + t[m.end() :]

    old = """    const start = Math.max(0, m.index - 120);
    const end = Math.min(content.length, m.index + id.length + 200);
    const ctx = content.slice(start, end);
    let type = null;
    if (/kind\\s*:\\s*[\"']guild[\"']/i.test(ctx)) type = 'guild';
    else if (/kind\\s*:\\s*[\"']user[\"']/i.test(ctx)) type = 'user';
    else type = inferType(id);"""
    new = """    const start = Math.max(0, m.index - 180);
    const end = Math.min(content.length, m.index + id.length + 280);
    const ctx = content.slice(start, end);
    const looksExp =
      /kind\\s*:\\s*[\"'](user|guild)[\"']/i.test(ctx) ||
      /\\b(experiment|experiments|getExperiment|useExperiment|Exposure)\\b/i.test(ctx) ||
      /variations\\s*:/i.test(ctx) ||
      /treatments\\s*:/i.test(ctx);
    if (!looksExp) continue;
    let type = null;
    if (/kind\\s*:\\s*[\"']guild[\"']/i.test(ctx)) type = 'guild';
    else if (/kind\\s*:\\s*[\"']user[\"']/i.test(ctx)) type = 'user';
    else type = inferType(id);"""
    if old not in t:
        print("extract: reId block not found")
        return False
    t = t.replace(old, new, 1)
    p.write_text(t)
    print("extract: patched")
    return True


def patch_index():
    p = Path("src/index.js")
    t = p.read_text()
    if "isMeaningfulExpMod" in t:
        print("index: already patched")
        return True

    pat = re.compile(
        r"function computeExpDiff\(findingsExps, lastExp, knownExp, opts\) \{.*?\n\}",
        re.S,
    )
    new_diff = """function variationKeySet(obj) {
  if (!obj) return '';
  if (obj.variations && typeof obj.variations === 'object')
    return Object.keys(obj.variations)
      .map(String)
      .sort((a, b) => Number(a) - Number(b))
      .join(',');
  const n = obj.variationCount || 0;
  if (n > 0) return Array.from({ length: n }, (_, i) => String(i)).join(',');
  return '';
}

/** Real treatment/variation changes only — ignore type-only and 0↔N parse noise */
function isMeaningfulExpMod(prev, next) {
  if (!prev || !next) return false;
  const prevKeys = variationKeySet(prev);
  const nextKeys = variationKeySet(next);
  const prevN = prevKeys ? prevKeys.split(',').filter(Boolean).length : 0;
  const nextN = nextKeys ? nextKeys.split(',').filter(Boolean).length : 0;
  if (prevN === 0 || nextN === 0) return false;
  if (prevKeys !== nextKeys) return true;
  const prevLabel = (prev.label || '').trim();
  const nextLabel = (next.label || '').trim();
  if (prevLabel && nextLabel && prevLabel !== nextLabel) return true;
  return false;
}

function computeExpDiff(findingsExps, lastExp, knownExp, opts) {
  const nextExpMap = new Map();
  const nextExpSnap = {};
  for (const e of findingsExps || []) {
    if (!e || !e.id || String(e.id).startsWith('hash:')) continue;
    const id = String(e.id);
    nextExpMap.set(id, e);
    nextExpSnap[id] = expSnapshot(e);
  }
  const lastExpCount = Object.keys(lastExp).length;
  const extractedExpCount = nextExpMap.size;
  const expDiff = { added: [], modified: [], removed: [] };
  if (extractedExpCount >= MIN_EXP_FOR_DIFF && lastExpCount >= 40) {
    for (const [id, e] of nextExpMap) {
      if (!(id in lastExp)) {
        if (!knownExp.has(id)) expDiff.added.push(e);
      } else if (isMeaningfulExpMod(lastExp[id], e)) {
        expDiff.modified.push({
          ...e,
          _prevKeys: variationKeySet(lastExp[id]),
          _nextKeys: variationKeySet(e),
        });
      }
    }
    const coverage = extractedExpCount / lastExpCount;
    if (coverage >= 0.85 && coverage <= 1.2) {
      for (const id of Object.keys(lastExp)) {
        if (!nextExpMap.has(id)) expDiff.removed.push({ id });
      }
      if (expDiff.removed.length > 15) expDiff.removed = [];
    }
    if (expDiff.modified.length > 20) expDiff.modified = [];
    if (expDiff.added.length > MAX_NOTIFY_EXP)
      expDiff.added = expDiff.added.slice(0, MAX_NOTIFY_EXP);
  }
  return { expDiff, nextExpSnap };
}"""
    m = pat.search(t)
    if not m:
        print("index: computeExpDiff not found")
        return False
    t = t[: m.start()] + new_diff + t[m.end() :]
    for old, new in [
        ("Canary Pulse v11.2 (anti-double notify)", "Canary Pulse v11.3 (stable experiments)"),
        ("Canary Pulse v11.1", "Canary Pulse v11.3 (stable experiments)"),
        ("Canary Pulse v11.2", "Canary Pulse v11.3 (stable experiments)"),
    ]:
        if old in t:
            t = t.replace(old, new, 1)
            break
    p.write_text(t)
    print("index: patched")
    return True


if __name__ == "__main__":
    ok = patch_extract() and patch_index()
    raise SystemExit(0 if ok else 1)
