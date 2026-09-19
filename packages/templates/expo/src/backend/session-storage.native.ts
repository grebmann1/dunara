import * as SecureStore from 'expo-secure-store';
import { chunkedStorage } from './chunked-storage';
export const sessionStorage = chunkedStorage({
  getItemAsync: key => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  deleteItemAsync: key => SecureStore.deleteItemAsync(key),
});
