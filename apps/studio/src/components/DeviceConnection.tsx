import type { ExpoAccountStatus } from '../../../../packages/core/src/expo-account';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Smartphone } from 'lucide-react';
import type { Preview } from '../../../../packages/core/src/contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import '../device-preview.css';

const phoneChecks = [['opened', 'App opened on my phone'], ['live_refresh', 'A saved code change appeared'], ['sign_in', 'App sign-in worked'], ['saved_data', 'My saved data appeared'], ['reopened', 'Session survived reopening'], ['sign_out', 'Sign-out worked']] as const;
const expoLoginCommand = 'npx expo login --browser';
export function DeviceConnection({ preview: incoming, appName, onRefresh }: { preview: Preview; appName: string; onRefresh(): void }) {
  const { api, capabilities, origin } = useStudioClient();
  const [preview, setPreview] = useState(incoming), [busy, setBusy] = useState(false), [error, setError] = useState(''), [platform, setPlatform] = useState<'ios' | 'android'>('ios');
  const [expoAccount, setExpoAccount] = useState<ExpoAccountStatus>(), [checkingAccount, setCheckingAccount] = useState(false);
  async function checkAccount() {
    if (checkingAccount) return; setCheckingAccount(true);
    try { const value = await api<ExpoAccountStatus>(`/projects/${preview.projectId}/expo-account`, {}); if (alive.current) setExpoAccount(value); }
    catch { if (alive.current) setExpoAccount({ state: 'unknown', message: 'Could not check Expo sign-in. Start a trusted local preview, then try again.' }); }
    finally { if (alive.current) setCheckingAccount(false); }
  }
  const [pendingChecks, setPendingChecks] = useState<(typeof phoneChecks)[number][0][]>();
  const active = useRef(false), alive = useRef(true);
  useEffect(() => { setPreview(incoming); }, [incoming]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(action: string, input: unknown) {
    if (active.current) return; active.current = true; setBusy(true); setError('');
    try { const value = await api<Preview>(`/projects/${preview.projectId}/${action}`, input); if (alive.current) setPreview(value); onRefresh(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Phone preview request failed.'); onRefresh(); }
    finally { active.current = false; if (alive.current) { setBusy(false); setPendingChecks(undefined); } }
  }
  const report = preview.phoneTests?.find(item => item.platform === platform);
  const visibleChecks = pendingChecks ?? report?.checks ?? [];
  const [qr, setQr] = useState<string>(), [notice, setNotice] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const cloud = capabilities.privatePreview || preview.transport === 'cloud';
  const lan = preview.transport === 'lan';
  const starting = busy || preview.status === 'starting';
  const startLabel = lan ? 'Retry phone preview' : 'Start phone preview';
  const url = preview.status === 'ready' ? cloud ? preview.sessionId ? `${origin}/#preview=${preview.sessionId}` : undefined : preview.deviceUrl : undefined;
  useEffect(() => {
    let alive = true;
    setQr(undefined); setNotice('');
    if (url && canvas.current) void QRCode.toCanvas(canvas.current, url, { width: 256, margin: 4, errorCorrectionLevel: 'M' }).then(() => { if (alive) setQr(url); }).catch(() => { if (alive) setNotice(cloud ? 'The QR code could not be generated. Open or copy the phone link below.' : 'The QR code could not be generated. Copy the address into Expo Go.'); });
    return () => { alive = false; };
  }, [url, preview.sessionId, cloud]);
  if (cloud) return <section className="device-preview" aria-label="Phone preview">
    <div className="device-preview-app"><Smartphone aria-hidden /><div><strong>{appName}</strong><span>Private web preview</span></div></div>
    <section className="device-preview-account" aria-label="Cloud phone access"><h3>Use your Dunara account</h3><p>Scan with your phone’s camera and sign in with the same Dunara account you use here. No Expo account or Expo Go installation is needed.</p><p className="device-preview-note">Opens in your phone browser. Your phone can use any internet connection.</p></section>
    {url ? <><div className="device-preview-qr"><canvas ref={canvas} role="img" aria-label={`Scan to open ${appName} in your phone browser`} width={256} height={256} hidden={qr !== url} />{qr !== url && <p>Preparing QR code…</p>}</div><a className="device-preview-open" href={url} target="_blank" rel="noopener noreferrer">Open preview in a new tab</a><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(url).then(() => setNotice('Private preview address copied.')).catch(() => setNotice('Open the preview link above.')); }}>Copy phone link</Button><p className="device-preview-note">Your phone and Studio use the same live web preview. Access ends when the cloud session stops.</p></> : <><p>{starting ? 'Preparing your private preview…' : preview.error || (preview.status === 'ready' ? 'The phone link is unavailable. Restart the preview from the toolbar.' : 'Start a cloud preview to get your phone link.')}</p>{preview.status !== 'ready' && <Button disabled={starting} onClick={() => void run('start', {})}>{starting ? 'Starting preview…' : 'Start cloud preview'}</Button>}</>}
    {error && <p role="alert">{error}</p>}
    <details><summary>Need to test native device features?</summary><p>Download your project from the workspace menu and open it in Dunara Desktop. Use Expo Go with your Expo account, or Build setup to install a native iPhone or Android preview app. Native builds and Expo Go connections from the cloud are not available yet.</p></details>
    <p role="status">{notice}</p>
  </section>;
  return <section className="device-preview" aria-label="Phone preview">
    <div className="device-preview-app"><Smartphone aria-hidden /><div><strong>{appName}</strong><span>Expo Go{preview.sdkVersion ? ` · Expo ${preview.sdkVersion}` : ''}</span></div></div>
    <Button disabled={starting} variant={url ? 'outline' : 'default'} onClick={() => void run('transport', { transport: url ? 'localhost' : 'lan', expectedSessionId: preview.sessionId ?? null })}>{busy ? 'Updating preview…' : preview.status === 'starting' ? 'Starting phone preview…' : url ? 'Use this computer only' : startLabel}</Button>
    {lan && !url && <Button variant="outline" disabled={starting} onClick={() => void run('transport', { transport: 'localhost', expectedSessionId: preview.sessionId ?? null })}>Use this computer only</Button>}
    <div className="device-account-status"><p role="status">{expoAccount?.message ?? 'Expo sign-in has not been checked on this computer.'}</p><Button variant="outline" disabled={checkingAccount || starting} onClick={() => void checkAccount()}>{checkingAccount ? 'Checking Expo…' : 'Check Expo sign-in'}</Button></div>
    <details className="device-preview-account" aria-label="Expo sign-in setup" open={!url}><summary>Expo sign-in setup</summary><h3>Expo account</h3><p>Use the same Expo account here and in Expo Go on your phone.</p><p className="device-preview-note">Run this once in your app’s project folder:</p><div className="device-login-command"><code>{expoLoginCommand}</code><Button variant="outline" aria-label="Copy Expo login command" onClick={() => { void navigator.clipboard.writeText(expoLoginCommand).then(() => setNotice('Expo login command copied. Run it in your app’s project folder.')).catch(() => setNotice('Copy the command shown above into your terminal.')); }}><Copy size={16} aria-hidden />Copy</Button></div><p className="device-preview-note">Already signed in on both devices? {url ? 'Scan below.' : 'Choose Start phone preview above.'} Expo sign-in is separate from ChatGPT and your app’s account.</p></details>
    {url ? <>
      <div className="device-preview-qr"><canvas ref={canvas} role="img" aria-label={`Scan to open ${appName} in Expo Go`} width={256} height={256} hidden={qr !== url} />{qr !== url && <p>Preparing QR code…</p>}</div>
      <p>Scan with Camera on iPhone or with Expo Go on Android.</p>
      <code className="device-connection-url">{url}</code>
      <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(url).then(() => setNotice('Device address copied.')).catch(() => setNotice('Copy the address shown above to open it in Expo Go.')); }}><Copy size={16} aria-hidden />Copy device address</Button>
    </> : <div className="device-preview-empty"><h3>Test on your phone</h3><p>{starting ? 'Starting your phone preview. Its QR code will appear here when it is ready.' : error || preview.error || preview.deviceIssue || 'Start a phone preview to get a QR code for this app.'}</p></div>}
    <ol className="device-preview-steps"><li>Install <a href="https://expo.dev/go" target="_blank" rel="noreferrer">Expo Go</a> on your phone. Connect both devices to the same Wi-Fi.</li><li>{url ? <>Scan the QR code above.</> : <>Choose <strong>{startLabel}</strong>, then scan the QR code.</>} Keep Dunara running.</li><li>Edit the app in Dunara. Expo Fast Refresh sends saved code changes to your phone. If a change is missing, reload in Expo Go.</li></ol>
    <p className="device-preview-note">Phone preview makes this development app reachable on your local network. Changing the connection restarts the preview and clears this session’s test checklist.</p>
    {error && <p role="alert">{error}</p>}
    <dl className="device-preview-details"><div><dt>Backend</dt><dd>{preview.environment ?? 'Not connected'}</dd></div>{preview.backendUrl && <div><dt>Project</dt><dd>{new URL(preview.backendUrl).hostname.split('.')[0]}</dd></div>}<div><dt>Connection</dt><dd>{lan ? url ? 'Local network' : 'Local network · waiting for address' : preview.status === 'stopped' || preview.status === 'failed' ? 'Not running' : 'This computer'}</dd></div>{preview.sessionId && <div><dt>Preview session</dt><dd>{preview.sessionId.slice(0, 8)}</dd></div>}</dl>
    <p className="device-preview-note">Sign into the app with its own account. Keep Dunara running while using Expo Go. Restarting a preview replaces this connection.</p>
    {url && <details className="device-phone-tests" open><summary>Record your phone test</summary><p>Mark checks after testing on your phone. These are your observations; Dunara does not automatically detect connected phones. The Assistant can read this checklist.</p><label>Test device<select aria-label="Test device" value={platform} onChange={event => setPlatform(event.target.value as 'ios' | 'android')} disabled={busy}><option value="ios">iPhone / iOS</option><option value="android">Android</option></select></label><fieldset disabled={busy}><legend>This preview session</legend>{phoneChecks.map(([check, label]) => <label key={check} className="device-phone-check"><input type="checkbox" checked={visibleChecks.includes(check)} disabled={check !== 'opened' && !visibleChecks.includes('opened')} onChange={event => { const checks = event.target.checked ? [...(report?.checks ?? []), check] : check === 'opened' ? [] : (report?.checks ?? []).filter(item => item !== check); setPendingChecks(checks); void run('phone-test', { sessionId: preview.sessionId, platform, expectedRevision: report?.revision ?? null, checks }); }} />{label}</label>)}</fieldset>{report && <p className="device-preview-note">User reported · {new Date(report.checkedAt).toLocaleTimeString()}</p>}<p>To check data sync, use the same Supabase environment and app account on both devices, save a record, then refresh the other device. Live data updates depend on your app’s implementation.</p></details>}
    {url && <details><summary>Phone cannot connect?</summary><p>Check that both devices use the same private network and that your firewall permits Expo. Guest Wi-Fi and VPNs can prevent devices from reaching each other. A visible QR code does not confirm a phone is connected.</p><p>If Expo Go reports an incompatible SDK, use a compatible Expo Go version or an app development build.</p></details>}
    <p role="status">{notice}</p>
  </section>;
}
