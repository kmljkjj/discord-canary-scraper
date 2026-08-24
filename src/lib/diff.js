function computeDiff(prev, findings) {
  const prevExp = new Set((prev.experiments || []).map((e) => e.id || e));
  const newExperiments = (findings.experiments || []).filter(
    (e) => !prevExp.has(e.id),
  );

  const prevStr = prev.strings || {};
  const curStr = findings.strings || {};
  const strings = { added: {}, removed: {}, modified: {} };
  for (const [k, v] of Object.entries(curStr)) {
    if (!(k in prevStr)) strings.added[k] = v;
    else if (prevStr[k] !== v) strings.modified[k] = { from: prevStr[k], to: v };
  }
  // only report removals if we had a solid baseline
  if (Object.keys(prevStr).length > 500) {
    for (const k of Object.keys(prevStr)) {
      if (!(k in curStr)) strings.removed[k] = prevStr[k];
    }
  }

  const prevR = prev.routes || {};
  const curR = findings.routes || {};
  const routes = { added: {}, removed: {}, modified: {} };
  for (const [k, v] of Object.entries(curR)) {
    if (!(k in prevR)) routes.added[k] = v;
    else if (prevR[k] !== v) routes.modified[k] = { from: prevR[k], to: v };
  }
  if (Object.keys(prevR).length > 50) {
    for (const k of Object.keys(prevR)) {
      if (!(k in curR)) routes.removed[k] = prevR[k];
    }
  }

  return { newExperiments, strings, routes };
}

module.exports = { computeDiff };
