export default { apiVersion: 1, panels: [{ id: 'notes', title: 'App notes', scope: 'project', async mount(root, api) {
  const settings = await api.settings(); if (api.signal.aborted) return;
  const heading = document.createElement('h2'); heading.textContent = settings.label || 'My app notes';
  const description = document.createElement('p'); description.textContent = 'This panel is supplied by a plugin outside Dunara. Inspect your app’s source or review the notes recipe below.';
  const button = document.createElement('button'); button.textContent = 'Inspect app source'; const output = document.createElement('pre');
  button.onclick = async () => { button.disabled = true; try { const result = await api.invoke('source-summary', {}); if (!api.signal.aborted) output.textContent = JSON.stringify(result, null, 2); } catch { output.textContent = 'Source is unavailable. Check the selected app and plugin status.'; } finally { button.disabled = false; } };
  root.append(heading, description, button, output); return () => { button.onclick = null; root.replaceChildren(); };
} }] };
