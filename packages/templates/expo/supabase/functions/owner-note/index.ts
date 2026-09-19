// No management/server key, dependency fetch, or code execution is needed to prepare this artifact.
// Auth verifies the actual user's token, including the project's current signing-key mode.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
Deno.serve(async request => {
  const reply = (status: number, value: unknown) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST') return reply(405, { error: 'Use POST.' });
  const authorization = request.headers.get('Authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) return reply(401, { error: 'Sign in first.' });
  try {
    const origin = Deno.env.get('SUPABASE_URL') ?? '', keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}');
    const key = keys.default;
    if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(origin) || typeof key !== 'string' || !key.startsWith('sb_publishable_')) return reply(503, { error: 'The function requires a configured project publishable key.' });
    const headers = { apikey: key, Authorization: authorization };
    const identity = await fetch(`${origin}/auth/v1/user`, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!identity.ok) return reply(401, { error: 'Your session is unavailable.' });
    const user = await identity.json();
    if (!uuid.test(user.id)) return reply(401, { error: 'Sign in first.' });
    const reader = request.body?.getReader(); let content = ''; const decoder = new TextDecoder();
    if (!reader) return reply(400, { error: 'Select a note.' });
    try { for (;;) { const part = await reader.read(); if (part.done) break; content += decoder.decode(part.value, { stream: true }); if (content.length > 4096) return reply(413, { error: 'Request too large.' }); } } finally { await reader.cancel(); }
    const body = JSON.parse(content);
    if (!uuid.test(body.noteId) || Object.keys(body).some(key => key !== 'noteId')) return reply(400, { error: 'Select a note.' });
    const response = await fetch(`${origin}/rest/v1/notes?id=eq.${body.noteId}&owner_id=eq.${user.id}&select=id,body&limit=1`, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return reply(503, { error: 'Your note could not be loaded.' });
    const notes = await response.json();
    if (!Array.isArray(notes) || notes.length !== 1) return reply(404, { error: 'Note not found.' });
    return reply(200, { note: notes[0] });
  } catch { return reply(400, { error: 'The request could not be completed.' }); }
});
