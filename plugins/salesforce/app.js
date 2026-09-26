const names = { development: 'Development', staging: 'Staging', production: 'Production' };
const defaults = environment => ({ environment, label: '', loginUrl: environment === 'production' ? 'https://login.salesforce.com' : 'https://test.salesforce.com', clientId: '', redirectUri: '', object: 'Account', fields: 'Id, Name' });
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export default { apiVersion: 1, panels: [{ id: 'backend', title: 'Salesforce setup', scope: 'project', async mount(root, api) {
  const style = element('link'); style.rel = 'stylesheet'; style.href = new URL('./style.css', import.meta.url).href;
  root.classList.add('salesforce-workspace'); root.append(style);
  let current, busy = false, environment = 'development', active = 'overview';
  const drafts = Object.fromEntries(Object.keys(names).map(key => [key, defaults(key)]));
  const toolbar = element('div', null, 'salesforce-toolbar');
  const environmentLabel = element('label', 'Environment');
  const select = element('select'); select.setAttribute('aria-label', 'Environment');
  for (const [value, text] of Object.entries(names)) { const option = element('option', text); option.value = value; select.append(option); }
  environmentLabel.append(select);
  const refresh = element('button', 'Refresh status'); refresh.type = 'button';
  toolbar.append(environmentLabel, refresh);
  const status = element('p'); status.setAttribute('role', 'status');
  const error = element('p', null, 'plugin-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const tabs = element('div', null, 'section-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Salesforce setup sections');
  const panels = new Map(), buttons = new Map(), prefix = `salesforce-${crypto.randomUUID()}`;
  for (const [key, title] of [['overview', 'Overview'], ['connection', 'Org settings'], ['sdk', 'React SDK']]) {
    const button = element('button', title, 'section-tab'); button.type = 'button'; button.id = `${prefix}-${key}`;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `${prefix}-${key}-panel`);
    const panel = element('div'); panel.id = `${prefix}-${key}-panel`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id); panel.tabIndex = 0;
    tabs.append(button); panels.set(key, panel); buttons.set(key, button);
    button.onclick = () => show(key);
  }
  function show(key) {
    active = key;
    for (const [id, button] of buttons) { button.dataset.selected = String(id === key); button.setAttribute('aria-selected', String(id === key)); button.tabIndex = id === key ? 0 : -1; panels.get(id).hidden = id !== key; }
  }
  tabs.onkeydown = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || !['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); const keys = [...buttons.keys()], index = keys.indexOf(active);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    show(keys[next]); buttons.get(keys[next]).focus();
  };
  const overview = element('section', null, 'backend-card'), overviewTitle = element('h2'), overviewText = element('p');
  const orgSummary = element('dl', null, 'salesforce-summary');
  const edit = element('button', 'Set up an org'); edit.type = 'button'; edit.onclick = () => { show('connection'); buttons.get('connection').focus(); };
  overview.append(overviewTitle, overviewText, orgSummary, edit);
  const overviewNative = element('section', null, 'backend-card'); overviewNative.append(element('h2', 'Salesforce on your device'), element('p', 'App users sign in with their own Salesforce account. Mobile SDK handles authentication and token refresh; Salesforce controls access to records.'));
  const nativeLink = element('button', 'View React SDK setup'); nativeLink.type = 'button'; nativeLink.onclick = () => { show('sdk'); buttons.get('sdk').focus(); }; overviewNative.append(nativeLink);
  panels.get('overview').append(overview, overviewNative);

  const form = element('form', null, 'backend-card');
  form.append(element('h2', 'Org settings'), element('p', 'Save public settings for this app. Sign-in happens in the native app after SDK setup.'));
  const fields = element('div', null, 'salesforce-fields'), inputs = {};
  for (const [key, title, placeholder] of [
    ['label', 'Org label', 'Sales sandbox'], ['loginUrl', 'Salesforce login URL', 'https://your-domain.my.salesforce.com'],
    ['clientId', 'OAuth consumer key', 'Public client ID from Salesforce'], ['redirectUri', 'Native callback URI', 'myapp://salesforce/auth'],
    ['object', 'Object API name', 'Account'], ['fields', 'Field API names', 'Id, Name'],
  ]) {
    const label = element('label', title), input = element('input'); input.name = key; input.required = true; input.placeholder = placeholder;
    input.maxLength = key === 'clientId' ? 512 : key === 'fields' ? 1600 : ['label', 'object'].includes(key) ? 80 : 200;
    input.autocomplete = 'off'; input.spellcheck = false;
    input.oninput = () => { drafts[environment][key] = input.value; };
    label.append(input); fields.append(label); inputs[key] = input;
  }
  const save = element('button', 'Review org settings', 'salesforce-primary'); save.type = 'submit';
  form.append(fields, element('p', 'Use comma-separated field API names. Keep client secrets, passwords and tokens out of these public settings.'), save);
  form.onsubmit = event => { event.preventDefault(); void perform(async () => {
    const draft = drafts[environment];
    await api.invoke('configure', { ...draft, fields: draft.fields.split(',').map(value => value.trim()).filter(Boolean) });
    status.textContent = 'Org settings are ready in Reviews. Apply the change to save them.';
  }); };
  panels.get('connection').append(form);

  const sdk = element('section', null, 'backend-card'), compatibilityTitle = element('h2'), compatibilityText = element('p'), versions = element('dl', null, 'salesforce-summary');
  sdk.append(compatibilityTitle, compatibilityText, versions);
  const integration = element('section', null, 'backend-card'), integrationState = element('p');
  integration.append(element('h2', 'React integration'), element('p', 'Add a typed client and React hooks for sign-in, sign-out and reading records. Your app keeps its current preview and entry point.'), integrationState);
  const list = element('ul'); for (const file of ['src/salesforce/client.ts', 'src/salesforce/SalesforceProvider.tsx', 'salesforce/SETUP.md']) list.append(element('li', file)); integration.append(list);
  const add = element('button', 'Add React integration', 'salesforce-primary'); add.type = 'button'; add.onclick = () => { void perform(async () => {
    await api.invoke('add-react-integration', {}); status.textContent = 'React integration files are ready in Reviews. Read the changes before applying.';
  }); };
  integration.append(add, element('p', 'Native SDK installation and device testing are separate steps. This source addition does not connect the app or enable offline sync.'));
  panels.get('sdk').append(sdk, integration);
  root.append(toolbar, tabs, status, error, ...panels.values()); show('overview');

  function summary(node, rows) { node.replaceChildren(); for (const [key, value] of rows) node.append(element('dt', key), element('dd', value)); }
  function render() {
    const saved = current?.configuration.environments[environment];
    overviewTitle.textContent = saved ? saved.label : `Set up ${names[environment].toLowerCase()}`;
    overviewText.textContent = saved ? 'Org settings saved. Native sign-in has not been verified by Studio.' : 'Choose the Salesforce org this app will use, then add its React integration.';
    edit.textContent = saved ? 'Edit org settings' : 'Set up an org';
    summary(orgSummary, saved ? [['Login URL', saved.loginUrl], ['Object', saved.object], ['Status', 'Configuration saved']] : [['Status', 'No org configured']]);
    for (const [key, input] of Object.entries(inputs)) input.value = drafts[environment][key];
    const report = current?.compatibility;
    compatibilityTitle.textContent = report?.compatible ? 'Native setup needs verification' : 'Native build integration required';
    compatibilityText.textContent = report?.message ?? 'Checking this app’s dependencies…';
    summary(versions, report ? [['Salesforce Mobile SDK', report.sdk.version], ['Required React Native', report.sdk.reactNative], ['This app’s React Native', report.reactNative ?? 'Not detected']] : []);
    integrationState.textContent = current?.integrationAdded ? 'Integration files are present. Review any updates before replacing edited files.' : 'React integration has not been added to this app.';
    add.textContent = current?.integrationAdded ? 'Review integration files' : 'Add React integration';
  }
  async function perform(work) {
    if (busy || api.signal.aborted) return;
    busy = true; error.hidden = true; status.textContent = '';
    for (const control of [select, refresh, save, add]) control.disabled = true;
    try { await work(); }
    catch (cause) { if (!api.signal.aborted) { error.textContent = cause instanceof Error ? cause.message : 'Salesforce setup could not complete.'; error.hidden = false; } }
    finally { busy = false; if (!api.signal.aborted) for (const control of [select, refresh, save, add]) control.disabled = false; }
  }
  async function load(initial = false) {
    const value = await api.invoke('inspect', {}); if (api.signal.aborted) return;
    current = value;
    if (initial) for (const [key, saved] of Object.entries(value.configuration.environments)) drafts[key] = { ...saved, fields: saved.fields.join(', ') };
    render();
  }
  select.onchange = () => { environment = select.value; render(); };
  refresh.onclick = () => { void perform(() => load()); };
  render(); await perform(() => load(true));
  return () => { root.replaceChildren(); };
} }] };
