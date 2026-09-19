import { expect, it } from 'vitest';
import { expoDeviceUrl } from './device-preview.js';

it('accepts only private IPv4 Expo Go addresses for the owned Metro port', () => {
  expect(expoDeviceUrl('Waiting on http://192.168.1.20:8081\n', 8081)).toBe('exp://192.168.1.20:8081');
  expect(expoDeviceUrl('Waiting on http://192.168.1.20:3000\n', 8081)).toBeUndefined();
  for (const host of ['10.0.1.4', '172.16.0.2', '172.31.255.2', '192.168.1.20']) {
    expect(expoDeviceUrl(`\u001b[32mMetro waiting on exp://${host}:8081\u001b[0m\n`, 8081)).toBe(`exp://${host}:8081`);
  }
  for (const url of ['exp://127.0.0.1:8081', 'exp://localhost:8081', 'exp://8.8.8.8:8081', 'exp://172.32.0.1:8081', 'exp://192.168.1.2:3000', 'exp://secret@192.168.1.2:8081', 'exp://192.168.1.2:8081/?token=secret', 'exp://192.168.1.2:8081/--/account', 'https://192.168.1.2:8081', 'exp://app.example:8081']) {
    expect(expoDeviceUrl(url, 8081)).toBeUndefined();
  }
});
