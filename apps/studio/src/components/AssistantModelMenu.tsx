import { useEffect, useRef } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import type { AssistantController } from '../assistant';
import { reasoningPreferenceSchema } from '../../../../packages/assistant/src/provider-contracts';

export const reasoningLabels = { auto: 'Default', off: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export function AssistantModelMenu({ controller: a }: { controller: AssistantController }) {
  const menu = useRef<HTMLDetailsElement>(null), trigger = useRef<HTMLElement>(null);
  const status = a.status, model = status?.models?.find(model => model.id === status.model);
  const levels = model?.reasoningLevels ?? [], effort = status?.reasoningEffort ?? 'auto';
  const disabled = a.working || status?.busy || status?.signIn?.state === 'waiting';
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (event.target instanceof Node && menu.current && !menu.current.contains(event.target)) menu.current.open = false; };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  if (!status?.connections) return null;
  return <details ref={menu} className="assistant-model-menu" onKeyDown={event => {
    if (event.key === 'Escape' && menu.current?.open) { event.preventDefault(); event.stopPropagation(); menu.current.open = false; trigger.current?.focus(); }
  }}>
    <summary ref={trigger} aria-label="Model and reasoning" title={`${model?.label ?? status.model ?? 'Choose model'} · ${reasoningLabels[effort]} reasoning`}>
      <span>{model?.label ?? status.model ?? 'Choose model'}</span>
      {levels.length > 0 && <small><Brain size={12} aria-hidden /><span>{reasoningLabels[effort]}</span></small>}
      <ChevronDown size={12} aria-hidden />
    </summary>
    <div className="assistant-model-popover" role="group" aria-label="Model and reasoning settings">
      <label>Model<select aria-label="Chat model" value={`${status.providerId}:${status.model}`} disabled={disabled} onChange={event => { const [provider, ...model] = event.target.value.split(':'); void a.selectModel(provider!, model.join(':')); }}>
        {status.connections.filter(connection => connection.configured || connection.id === status.providerId).map(connection => <optgroup key={connection.id} label={connection.name}>{connection.models.map(model => <option key={model.id} value={`${connection.id}:${model.id}`} disabled={!connection.configured}>{model.label}</option>)}</optgroup>)}
      </select></label>
      {status.reasoningEffort !== undefined && <label>Reasoning level<select aria-label="Reasoning level" value={effort} disabled={disabled || !levels.length} onChange={event => { const value = reasoningPreferenceSchema.safeParse(event.target.value); if (value.success) void a.selectReasoning(value.data); }}>
        <option value="auto">Default</option>
        {levels.map(level => <option key={level} value={level}>{reasoningLabels[level]}</option>)}
      </select></label>}
      <p>{status.reasoningEffort === undefined ? 'Reasoning controls require an updated Assistant runtime.' : !levels.length ? 'This model does not offer adjustable reasoning.' : 'Higher effort can take longer and use more credits. Default keeps the runtime’s normal setting.'}</p>
    </div>
  </details>;
}
