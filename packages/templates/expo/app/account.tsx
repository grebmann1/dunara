import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { Session } from '@supabase/supabase-js';
import { backendEnvironment, supabase } from '../src/backend/client';
import design from '../src/theme/design.json';
type Note = { id: string; body: string };
export default function Account() {
  const [session, setSession] = useState<Session | null>(null), [loading, setLoading] = useState(!!supabase), [busy, setBusy] = useState(false), [email, setEmail] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [notes, setNotes] = useState<Note[]>([]), [body, setBody] = useState('');
  const alive = useRef(true), operating = useRef(false), userId = useRef<string | null>(null);
  const [notesLoading, setNotesLoading] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    alive.current = true;
    let authEvents = 0;
    const update = (value: Session | null) => {
      if (!alive.current) return;
      const nextId = value?.user.id ?? null;
      if (nextId !== userId.current) { setNotes([]); setBody(''); setNotice(''); setError(''); setNotesLoading(!!nextId); }
      userId.current = nextId; setSession(value); setLoading(false);
    };
    const subscription = supabase?.auth.onAuthStateChange((_event, value) => { authEvents++; update(value); });
    void supabase?.auth.getSession().then(({ data, error }) => {
      if (alive.current && authEvents === 0) { update(data.session); if (error) setError('Your saved session could not be restored. Sign in again.'); }
    }).catch(() => { if (alive.current && authEvents === 0) { setLoading(false); setError('Your saved session could not be restored. Sign in again.'); } });
    return () => { alive.current = false; userId.current = null; subscription?.data.subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!session || !supabase) return;
    let current = true;
    const id = session.user.id;
    setNotesLoading(true);
    void Promise.resolve(supabase.from('notes').select('id,body').order('created_at', { ascending: false }).limit(50)).then(({ data, error }) => {
      if (!current || !alive.current || userId.current !== id) return;
      if (error) setError('Your notes could not be loaded. Check the connection and try again.'); else { setNotes(data ?? []); setError(''); }
    }).catch(() => { if (current && alive.current && userId.current === id) setError('Your notes could not be loaded. Check the connection and try again.'); }).finally(() => { if (current && alive.current && userId.current === id) setNotesLoading(false); });
    return () => { current = false; };
  }, [session?.user.id, reload]);
  async function perform(action: () => Promise<void>) { if (operating.current) return; operating.current = true; setBusy(true); setError(''); setNotice(''); try { await action(); } catch { if (alive.current) setError('That request could not be completed. Check your connection and try again.'); } finally { operating.current = false; if (alive.current) setBusy(false); } }
  async function authenticate() {
    if (!supabase) return;
    if (sent) { const result = await supabase.auth.verifyOtp({ email, token: code, type: 'email' }); setCode(''); if (result.error) throw result.error; }
    else { const result = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } }); if (result.error) throw result.error; if (alive.current) { setSent(true); setNotice('Check your email for a sign-in code.'); } }
  }
  const action = (label: string, onPress: () => void, muted = false) => <Pressable accessibilityRole="button" disabled={busy || label === 'Save note' && notesLoading} onPress={onPress} style={[styles.button, muted && styles.secondary, busy && { opacity: .6 }]}><Text style={[styles.buttonText, muted && { color: t.text }]}>{label}</Text></Pressable>;
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><Pressable accessibilityRole="button" accessibilityLabel="Back to today" onPress={() => router.replace('/')} style={styles.back}><Text style={styles.label}>← Today</Text></Pressable><Text style={styles.eyebrow}>YOUR SPACE</Text><Text accessibilityRole="header" style={styles.title}>A little space{`\n`}for you.</Text><Text style={styles.description}>Keep your notes close, wherever the day takes you.</Text>
    {!supabase ? <View style={styles.card}><Text accessibilityRole="header" style={styles.heading}>Your account is coming soon</Text><Text style={styles.description}>This app’s backend hasn’t been connected yet. You can still explore the app.</Text></View> : loading ? <ActivityIndicator accessibilityLabel="Restoring your account" color={t.accent} /> : !session ? <View style={styles.card}><Text accessibilityRole="header" style={styles.heading}>Welcome in</Text><Text style={styles.description}>Sign in with a code sent to your email.</Text><Text style={styles.label}>Email</Text><TextInput accessibilityLabel="Email" value={email} onChangeText={value => { setEmail(value); setSent(false); setCode(''); }} autoCapitalize="none" autoComplete="email" keyboardType="email-address" style={styles.input} editable={!busy} />{sent && <><Text style={styles.label}>Email code</Text><TextInput accessibilityLabel="Email code" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" maxLength={10} style={styles.input} editable={!busy} /></>}{action(sent ? 'Sign in' : 'Send my code', () => void perform(authenticate))}{sent && action('Request another code', () => { setSent(false); setCode(''); }, true)}</View> : <View style={styles.card}><Text accessibilityRole="header" style={styles.heading}>Your notes</Text><Text style={styles.description}>{session.user.email}</Text><TextInput accessibilityLabel="New note" placeholder="Something to remember…" value={body} onChangeText={setBody} maxLength={2000} multiline style={[styles.input, { minHeight: 90 }]} editable={!busy} />{action('Save note', () => void perform(async () => { if (!supabase || !body.trim()) return; const id = session.user.id; const result = await supabase.from('notes').insert({ owner_id: id, body: body.trim() }).select('id,body').single(); if (result.error) throw result.error; if (alive.current && userId.current === id) { setNotes(current => [result.data, ...current].slice(0, 50)); setBody(''); setNotice('Note saved.'); } }))}{!notes.length && <Text style={styles.description}>A fresh page. Your saved notes will appear here.</Text>}{notes.map(note => <Text key={note.id} style={styles.note}>{note.body}</Text>)}{action('Sign out', () => void perform(async () => { if (!supabase) return; const result = await supabase.auth.signOut({ scope: 'local' }); if (result.error) throw result.error; setNotes([]); setBody(''); }), true)}</View>}
    {session && notesLoading && <ActivityIndicator accessibilityLabel="Loading your notes" color={t.accent} />}
    {error ? <><Text accessibilityRole="alert" style={styles.feedback}>{error}</Text>{session && action('Reload notes', () => setReload(value => value + 1), true)}</> : null}{notice ? <Text accessibilityLiveRegion="polite" style={styles.feedback}>{notice}</Text> : null}{__DEV__ && <Text style={styles.environment}>{backendEnvironment} environment</Text>}
  </ScrollView></SafeAreaView>;
}
const t = design.tokens;
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: t.background }, content: { padding: 24, paddingBottom: 48, gap: 14, width: '100%', maxWidth: 540, alignSelf: 'center' }, back: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: 20 }, eyebrow: { color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 2 }, title: { color: t.text, fontSize: 38, lineHeight: 44, fontWeight: '600' }, heading: { color: t.text, fontSize: 23, fontWeight: '600' }, description: { color: t.muted, fontSize: 15, lineHeight: 23 }, card: { backgroundColor: t.surface, padding: 24, borderRadius: t.radius, borderWidth: 1, borderColor: t.border, gap: 14, marginTop: 12 }, label: { color: t.text, fontSize: 14, fontWeight: '600' }, input: { borderWidth: 1, borderColor: t.border, borderRadius: 12, minHeight: 48, padding: 12, color: t.text, backgroundColor: t.background, fontSize: 16 }, button: { minHeight: 48, borderRadius: 24, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', padding: 12 }, secondary: { backgroundColor: t.background }, buttonText: { color: t.onAccent, fontSize: 15, fontWeight: '600' }, note: { color: t.text, paddingVertical: 12, borderTopWidth: 1, borderColor: t.border, fontSize: 16, lineHeight: 24 }, feedback: { color: t.text, fontSize: 14, lineHeight: 21 }, environment: { color: t.muted, textAlign: 'center', fontSize: 11, marginTop: 16 } });
