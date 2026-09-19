import { useEffect, useRef, useState } from 'react';
import type { SecretVersion } from '../../../../packages/platform/src/configuration';
import type { EnvironmentName } from '../../../../packages/platform/src/contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function SecureBackendInput({ base, environment, input, disabled, rememberAvailable, onSaved }: { base: string; environment: EnvironmentName; input: SecretVersion; disabled: boolean; rememberAvailable: boolean; onSaved: () => Promise<unknown> }) {
  const { api } = useStudioClient();
  const field = useRef<HTMLInputElement>(null), active = useRef(false), [remember, setRemember] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const element = field.current; return () => { if (element) element.value = ''; }; }, []);
  async function save(remove = false) {
    if (active.current || disabled) return; active.current = true; setBusy(true); setError('');
    try {
      const pending = api(`${base}/${remove ? 'remove-input' : 'input'}`, { environment, name: input.name, expectedRevision: input.revision, ...(!remove ? { value: field.current?.value ?? '', remember } : {}) });
      if (field.current) field.current.value = '';
      await pending; await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Credential update failed.'); }
    finally { if (field.current) field.current.value = ''; active.current = false; setBusy(false); }
  }
  return <form autoComplete="off" className="backend-private-input" onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={disabled || busy}><legend>{input.label} · {environment}</legend><p>{input.available ? `Available · ${input.persistence === 'saved' ? 'encrypted storage' : 'this session'}` : 'Input required'}. Values stay in the Dunara service.</p><label>{input.available ? 'Replace value' : 'Private value'}<Input ref={field} type="password" required maxLength={16_384} autoComplete="off" spellCheck={false} autoCapitalize="none" /></label><label className="backend-check"><input type="checkbox" disabled={!rememberAvailable} checked={remember} onChange={e => setRemember(e.target.checked)} />Remember with encrypted storage</label><div className="backend-actions"><Button type="submit">Save private input</Button>{input.available && <Button type="button" variant="outline" onClick={() => void save(true)}>Remove input</Button>}</div>{error && <p role="alert">{error}</p>}</fieldset></form>;
}
