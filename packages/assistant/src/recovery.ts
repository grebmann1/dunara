export type RecoveryKind = 'sign-in' | 'usage' | 'network' | 'runtime' | 'unknown';
/** Classify privately; never interpolate provider text into user-facing errors. */
export function recoveryKind(error: unknown): RecoveryKind {
  let detail = '';
  try { detail = error instanceof Error ? `${error.name} ${error.message} ${JSON.stringify(error.cause ?? '')}` : JSON.stringify(error); } catch { /* Unknown error remains generic. */ }
  if (/unauthori[sz]ed|authentication|invalid[_ -]?token|token[_ -]?expired|session[_ -]?expired|\b401\b/i.test(detail)) return 'sign-in';
  if (/usageLimitExceeded|rate[_ -]?limit|quota|insufficient[_ -]?credits|usage[_ -]?limit|\b429\b/i.test(detail)) return 'usage';
  if (/ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|connection reset|socket|timed?\s*out/i.test(detail)) return 'network';
  if (/method not found|unsupported|not supported|ENOENT|capability.*unavailable|-32601\b/i.test(detail)) return 'runtime';
  return 'unknown';
}
export function recoveryMessage(kind: RecoveryKind, subject: 'ChatGPT image generation' | 'The assistant', started = true) {
  const action = {
    'sign-in': 'Your sign-in expired or was rejected. Reconnect this provider in Settings.',
    usage: 'The provider reported a usage limit. Check your allowance and wait for it to reset before retrying.',
    network: 'The provider could not be reached. Check your internet connection before retrying.',
    runtime: 'This runtime does not support the request. Update Dunara and its provider runtime, then reopen the app.',
    unknown: 'Check your provider connection and diagnostics before retrying.',
  }[kind];
  return `${subject} could not complete this ${subject === 'The assistant' ? 'turn' : 'request'}. ${action} ${started ? 'Usage may have been consumed.' : 'No generation was started.'} No automatic retry was made.`;
}
