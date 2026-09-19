import { supabase } from './client';

const bucket = 'private-uploads';
async function owner() {
  if (!supabase) throw new Error('Connect this app’s backend first.');
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Sign in before using private files.');
  return { client: supabase, userId: data.user.id };
}
export async function listPrivateFiles() {
  const { client, userId } = await owner();
  const { data, error } = await client.storage.from(bucket).list(userId, { limit: 30, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new Error('Private files could not be loaded.');
  return { userId, files: data.map(file => ({ name: file.name, path: `${userId}/${file.name}` })) };
}
export async function uploadPrivateText(content: string) {
  const { client, userId } = await owner();
  if (!content.trim() || content.length > 2000) throw new Error('Write between 1 and 2000 characters.');
  const objectPath = `${userId}/note-${Date.now()}.txt`;
  const bytes = Uint8Array.from(unescape(encodeURIComponent(content)), character => character.charCodeAt(0));
  const { error } = await client.storage.from(bucket).upload(objectPath, bytes.buffer, { contentType: 'text/plain', upsert: false });
  if (error) throw new Error('Your file could not be saved.');
  return { userId, path: objectPath };
}
export async function readPrivateText(objectPath: string) {
  const { client, userId } = await owner();
  if (!objectPath.startsWith(`${userId}/`) || objectPath.includes('..')) throw new Error('Choose one of your own files.');
  const { data, error } = await client.storage.from(bucket).createSignedUrl(objectPath, 30);
  if (error) throw new Error('The download link could not be created.');
  const response = await fetch(data.signedUrl);
  if (!response.ok) throw new Error('The download link expired. Try opening the file again.');
  return { userId, content: (await response.text()).slice(0, 2000) };
}
export async function removePrivateFile(objectPath: string) {
  const { client, userId } = await owner();
  if (!objectPath.startsWith(`${userId}/`) || objectPath.includes('..')) throw new Error('Choose one of your own files.');
  const { error } = await client.storage.from(bucket).remove([objectPath]);
  if (error) throw new Error('Your file could not be removed.');
}
