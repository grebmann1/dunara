import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HabitProvider } from '../src/state';
export default function Layout() { return <SafeAreaProvider><HabitProvider><Stack screenOptions={{ headerShown: false, animation: 'none' }} /></HabitProvider></SafeAreaProvider>; }

// Mobile App Builder: development-only preview inspection
import '../src/builder-inspector';
