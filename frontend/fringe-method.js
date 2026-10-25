// Algorithm choice is independent of execution location (server/browser).
export function analysisMethodLabel(result) {
  if (result?.analysis_method === 'hybrid') return 'Hybrid quadratic fit (experimental)';
  if (result?.analysis_method === 'current') return 'Current method';
  if (['average','subtracted'].includes(result?.origin)) return 'Derived result — see source captures';
  return 'Method not recorded (older result)';
}
