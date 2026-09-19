import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { finishGoogleSignIn } from '../src/backend/social';
import design from '../src/theme/design.json';
export default function OAuthCallback() {
  const [error, setError] = useState('');
  useEffect(() => { let alive = true; if (Platform.OS !== 'web') { setError('Use email sign-in in this mobile build.'); return; } void finishGoogleSignIn(() => router.replace('/oauth-callback')).then(() => { if (alive) router.replace('/account'); }).catch(() => { if (alive) setError('This sign-in request is unavailable or expired. Please start again.'); }); return () => { alive = false; }; }, []);
  return <View style={styles.page}><Text accessibilityRole="header" style={styles.title}>{error ? 'Sign-in unavailable' : 'Signing you in'}</Text><Text accessibilityRole={error ? 'alert' : undefined} style={styles.text}>{error || 'Restoring your private space…'}</Text>{error ? <Pressable accessibilityRole="button" style={styles.button} onPress={() => router.replace('/account')}><Text style={styles.text}>Back to sign-in</Text></Pressable> : null}</View>;
}
const t = design.tokens;
const styles = StyleSheet.create({ page: { flex: 1, justifyContent: 'center', padding: 24, gap: 18, backgroundColor: t.background }, title: { color: t.text, fontSize: 30, fontWeight: '600' }, text: { color: t.text, fontSize: 16, lineHeight: 24 }, button: { minHeight: 48, padding: 12, borderRadius: 16, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' } });
