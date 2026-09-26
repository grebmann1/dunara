import type { dependencyFiles } from '../../packages/core/src/dependency-profiles.js';

// Recorded npm lock entries for the native sign-in dependency regression.
export function nativeAuthDependencies(files: Awaited<ReturnType<typeof dependencyFiles>>) {
  const manifest = JSON.parse(files.manifest), lock = JSON.parse(files.lock);
  const packages = {
    'expo-crypto': {
      version: '57.0.3',
      resolved: 'https://registry.npmjs.org/expo-crypto/-/expo-crypto-57.0.3.tgz',
      integrity: 'sha512-SAWqEfF37nc8ot7bXsVmu9AFYwQdC2kGvH/eNAHiR3bmlcf1Vv8wu9AnGKT+a90r3T8YfwMpZP4QAYlo4vCn9w==',
      license: 'MIT', peerDependencies: { expo: '*' },
    },
    'expo-web-browser': {
      version: '57.0.3',
      resolved: 'https://registry.npmjs.org/expo-web-browser/-/expo-web-browser-57.0.3.tgz',
      integrity: 'sha512-+ecvhyS/PdWkpv4ai6FF1Trd6Y/4kn/eQ3O86mie2ecU3w+I8bKZh13kppY/jw1uSL7yikt03L5W/iiHojrFwQ==',
      license: 'MIT', peerDependencies: { expo: '*', 'react-native': '*' },
    },
  };
  for (const [name, entry] of Object.entries(packages)) {
    manifest.dependencies[name] = entry.version;
    lock.packages[''].dependencies[name] = entry.version;
    lock.packages[`node_modules/${name}`] = entry;
  }
  return { manifest: JSON.stringify(manifest), lock: JSON.stringify(lock) };
}
