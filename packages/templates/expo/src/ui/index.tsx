import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View, type TextStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link, usePathname } from 'expo-router';
import type { PropsWithChildren } from 'react';
import design from '../theme/design.json';
export const t = design.tokens;
export function Type({ children, kind = 'body', color, center = false }: PropsWithChildren<{ kind?: 'body' | 'title' | 'heading' | 'label' | 'metric'; color?: string; center?: boolean }>) {
  const styles: Record<string, TextStyle> = {
    body: { fontSize: t.bodySize, lineHeight: 25 },
    title: { fontSize: t.titleSize, lineHeight: t.titleSize + 5, fontWeight: '600', letterSpacing: -1.4 },
    heading: { fontSize: 21, lineHeight: 28, fontWeight: '600', letterSpacing: -.4 },
    label: { fontSize: 11, lineHeight: 18, fontWeight: '700', letterSpacing: 1.7 },
    metric: { fontSize: 48, lineHeight: 56, fontWeight: '500', letterSpacing: -2 },
  };
  return <Text style={[{ color: color ?? t.text, textAlign: center ? 'center' : 'left' }, styles[kind]]}>{children}</Text>;
}
export function Card({ children, accent = false }: PropsWithChildren<{ accent?: boolean }>) {
  return <View style={{ padding: t.spacing * 3, borderRadius: t.radius, backgroundColor: accent ? t.accent : t.surface, borderWidth: accent ? 0 : 1, borderColor: t.border, gap: t.spacing * 2, elevation: t.elevation }}>{children}</View>;
}
export function Button({ label, onPress, disabled = false, loading = false }: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} aria-disabled={disabled || loading} aria-busy={loading} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => ({ minHeight: 52, padding: 14, borderRadius: 100, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent, opacity: disabled ? .45 : pressed ? .7 : 1 })}>{loading ? <ActivityIndicator color={t.onAccent} /> : <Text style={{ color: t.onAccent, fontSize: 15, fontWeight: '600' }}>{label}</Text>}</Pressable>;
}
export function Progress({ value, label }: { value: number; label: string }) {
  const percent = Math.min(100, Math.max(0, value * 100));
  return <View accessibilityRole="progressbar" accessibilityLabel={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} style={{ height: 7, backgroundColor: t.border, borderRadius: 8, overflow: 'hidden' }}><View style={{ width: `${percent}%`, backgroundColor: t.accent, height: 7, borderRadius: 8 }} /></View>;
}
export function Input({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) {
  return <View style={{ gap: 8 }}><Type kind="label">{label}</Type><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} placeholder="One small thing, just for you…" placeholderTextColor={t.muted} style={{ minHeight: 52, borderWidth: 1, borderColor: t.border, borderRadius: 14, padding: 14, color: t.text, fontSize: t.bodySize }} /></View>;
}
export function Feedback({ title, message, error = false }: { title: string; message: string; error?: boolean }) {
  return <View accessibilityRole={error ? 'alert' : undefined} style={{ padding: 24, gap: 8 }}><Type kind="heading">{title}</Type><Type color={t.muted}>{message}</Type></View>;
}
export function Row({ children }: PropsWithChildren) { return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>{children}</View>; }
export function Screen({ children }: PropsWithChildren) {
  const path = usePathname();
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.background }}><ScrollView contentContainerStyle={{ padding: t.spacing * 3, gap: t.spacing * 3, paddingBottom: 28 }}><Row><Type kind="heading">still.</Type><View style={{ borderRadius: 100, borderWidth: 1, borderColor: t.border, paddingHorizontal: 14, paddingVertical: 7 }}><Type kind="label">A LITTLE EVERY DAY</Type></View></Row>{children}</ScrollView><View style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: t.border, paddingHorizontal: 24, paddingVertical: 8, backgroundColor: t.surface }}>{[{ href: '/', label: 'Today', icon: '◌' }, { href: '/habit', label: 'Ritual', icon: '◷' }, { href: '/progress', label: 'Progress', icon: '▥' }, { href: '/account', label: 'Account', icon: '○' }].map(item => <Link key={item.href} href={item.href as '/' | '/habit' | '/progress' | '/account'} asChild><Pressable accessibilityRole="link" accessibilityLabel={item.label} accessibilityState={{ selected: path === item.href }} aria-current={Platform.OS === 'web' && path === item.href ? 'page' : undefined} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 54, gap: 2 }}><Text style={{ fontSize: 24, color: path === item.href ? t.accent : t.muted }}>{item.icon}</Text><Text style={{ fontSize: 11, color: path === item.href ? t.accent : t.muted, fontWeight: path === item.href ? '700' : '400' }}>{item.label}</Text></Pressable></Link>)}</View></SafeAreaView>;
}
