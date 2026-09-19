import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { supabase } from '../src/backend/client';
import { googleSignInAvailable, startGoogleSignIn } from '../src/backend/social';
import { listPrivateFiles, readPrivateText, removePrivateFile, uploadPrivateText } from '../src/backend/uploads';
import design from '../src/theme/design.json';

export default function PrivateFiles() {
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]), [text, setText] = useState(''), [opened, setOpened] = useState(''), [userId, setUserId] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), active = useRef(false), currentUser = useRef<string | null>(null);
  useEffect(() => {
    let alive = true, events = 0;
    const change = (id: string | null) => { if (!alive || id === currentUser.current) return; currentUser.current = id; generation.current++; setUserId(id); setFiles([]); setText(''); setOpened(''); setError(''); };
    const subscription = supabase?.auth.onAuthStateChange((_event, session) => { events++; change(session?.user.id ?? null); });
    void supabase?.auth.getSession().then(({ data }) => { if (!events) change(data.session?.user.id ?? null); });
    return () => { alive = false; generation.current++; subscription?.data.subscription.unsubscribe(); };
  }, []);
  useEffect(() => { if (!userId) return; const current = generation.current; void listPrivateFiles().then(result => { if (current === generation.current && result.userId === userId) setFiles(result.files); }).catch(() => { if (current === generation.current) setError('Your files could not be loaded. Try again.'); }); }, [userId]);
  async function run(work: () => Promise<void>) {
    if (active.current) return; active.current = true; setBusy(true); setError(''); const current = generation.current;
    try { await work(); const result = await listPrivateFiles(); if (current === generation.current && result.userId === userId) setFiles(result.files); }
    catch { if (current === generation.current) setError('That request could not be completed. Check your connection and try again.'); }
    finally { active.current = false; setBusy(false); }
  }
  const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" onPress={action} disabled={busy} style={[styles.button, busy && { opacity: .6 }]}><Text style={styles.buttonText}>{label}</Text></Pressable>;
  const google = () => { if (active.current) return; active.current = true; setBusy(true); setError(''); void startGoogleSignIn().catch(() => { active.current = false; setBusy(false); setError('Google sign-in is unavailable. Please use your email code.'); }); };
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"><Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}><Text style={styles.label}>← Back</Text></Pressable><Text style={styles.eyebrow}>JUST FOR YOU</Text><Text accessibilityRole="header" style={styles.title}>Your private files.</Text><Text style={styles.description}>A small place for the words you want to keep.</Text>
    {!userId ? <View style={styles.card}><Text style={styles.description}>Sign in to save and open your files.</Text>{button('Go to your account', () => router.push('/account'))}{googleSignInAvailable && button('Continue with Google', google)}</View> : <><View style={styles.card}><Text accessibilityRole="header" style={styles.heading}>Save a little note</Text><TextInput accessibilityLabel="Private file text" placeholder="Something to keep…" multiline maxLength={2000} value={text} onChangeText={setText} editable={!busy} style={styles.input} />{button('Save private file', () => { const current = generation.current; void run(async () => { const result = await uploadPrivateText(text); if (current === generation.current && result.userId === userId) setText(''); }); })}</View><View style={styles.card}><Text accessibilityRole="header" style={styles.heading}>Your files</Text>{!files.length && <Text style={styles.description}>Your saved files will appear here.</Text>}{files.map(file => <View key={file.path} style={styles.file}><Text style={styles.label}>{file.name}</Text>{button('Open file', () => { const current = generation.current; void run(async () => { const result = await readPrivateText(file.path); if (current === generation.current && result.userId === userId) setOpened(result.content); }); })}{button('Remove file', () => void run(() => removePrivateFile(file.path)))}</View>)}{button('Refresh files', () => void run(async () => {}))}</View></>}
    {opened ? <View style={styles.card}><Text accessibilityRole="header" style={styles.heading}>Your note</Text><Text style={styles.description}>{opened}</Text></View> : null}{error ? <Text accessibilityRole="alert" style={styles.description}>{error}</Text> : null}
  </ScrollView></SafeAreaView>;
}
const t = design.tokens;
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: t.background }, content: { padding: 24, paddingBottom: 48, gap: 16, width: '100%', maxWidth: 540, alignSelf: 'center' }, back: { minHeight: 44, justifyContent: 'center' }, eyebrow: { color: t.muted, fontSize: 11, fontWeight: '700', letterSpacing: 2 }, title: { color: t.text, fontSize: 34, lineHeight: 40, fontWeight: '600' }, heading: { color: t.text, fontSize: 22, fontWeight: '600' }, description: { color: t.muted, fontSize: 15, lineHeight: 23 }, card: { backgroundColor: t.surface, padding: 22, borderRadius: t.radius, borderWidth: 1, borderColor: t.border, gap: 14 }, label: { color: t.text, fontSize: 14, fontWeight: '600' }, input: { borderWidth: 1, borderColor: t.border, borderRadius: 12, minHeight: 100, padding: 12, color: t.text, fontSize: 16 }, button: { minHeight: 48, borderRadius: 24, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', padding: 12 }, buttonText: { color: t.onAccent, fontSize: 15, fontWeight: '600' }, file: { borderTopWidth: 1, borderColor: t.border, paddingTop: 12, gap: 10 } });
