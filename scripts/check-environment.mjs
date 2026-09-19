// Keep fixture subprocesses free of provider credentials and execution hooks.
export function checkEnvironment(source = process.env) {
  const names = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI', 'PLAYWRIGHT_BROWSERS_PATH'];
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}
