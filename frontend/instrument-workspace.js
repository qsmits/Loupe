// Durable instrument data excludes live hardware jobs, timers and server IDs.
export function captureInstrument(model, defaults, root) {
  const data = Object.fromEntries(Object.keys(defaults).map(key => [key, model[key]]));
  const controls = {};
  for (const el of root?.querySelectorAll('input[id], select[id], textarea[id]') ?? []) {
    if (el.type === 'file' || el.type === 'password') continue;
    controls[el.id] = {value: el.value, checked: !!el.checked};
  }
  return structuredClone({data, controls});
}

export function restoreInstrument(model, defaults, snapshot, root) {
  for (const key of Object.keys(defaults)) {
    model[key] = structuredClone(snapshot?.data?.[key] ?? defaults[key]);
  }
  for (const el of root?.querySelectorAll('input[id], select[id], textarea[id]') ?? []) {
    const saved = snapshot?.controls?.[el.id];
    if (!saved || el.type === 'file' || el.type === 'password') continue;
    el.value = saved.value;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = saved.checked;
  }
}
