/** Adapter for Salesforce Mobile SDK 13.2.1. Native initialization owns tokens. */
export type Identity = { userId: string; orgId: string };
export type SalesforceRecord = { Id: string; [field: string]: unknown };
type Failure = (error: unknown) => void;
export type SalesforceSDK = {
  oauth: {
    getAuthCredentials(success: (account: Identity) => void, failure: Failure): void;
    authenticate(success: (account: Identity) => void, failure: Failure): void;
    logout(success: (result: unknown) => void, failure: Failure): void;
  };
  net: { query<T>(soql: string, success: (result: T) => void, failure: Failure): void };
};
export type SalesforceSelection = { object: string; fields: readonly string[] };
export type SalesforceState = {
  status: 'native-setup-required' | 'signed-out' | 'signing-in' | 'ready' | 'loading' | 'signing-out' | 'error';
  identity: Identity | null;
  records: readonly SalesforceRecord[];
  error: string | null;
};

export function createSalesforceClient(sdk: SalesforceSDK | null, selection: SalesforceSelection) {
  const identifier = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
  if (!identifier.test(selection.object) || !selection.fields.length || selection.fields.length > 20 || selection.fields.some(field => !identifier.test(field))) throw Error('Use Salesforce object and field API names.');
  const query = `SELECT ${[...new Set(['Id', ...selection.fields])].join(', ')} FROM ${selection.object} LIMIT 100`;
  const listeners = new Set<() => void>();
  let epoch = 0, signingIn: Promise<void> | null = null;
  let state: SalesforceState = { status: sdk ? 'signed-out' : 'native-setup-required', identity: null, records: [], error: null };
  const emit = (patch: Partial<SalesforceState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const requireSDK = () => { if (!sdk) throw Error('Salesforce sign-in needs a native Mobile SDK build.'); return sdk; };
  const call = <T>(start: (success: (value: T) => void, fail: Failure) => void, message: string) => new Promise<T>((resolve, reject) => {
    try { start(resolve, () => reject(Error(message))); } catch { reject(Error(message)); }
  });
  const identity = (account: Identity): Identity => {
    if (!account || typeof account.userId !== 'string' || typeof account.orgId !== 'string') throw Error('Salesforce did not return a user identity.');
    return { userId: account.userId, orgId: account.orgId };
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    signIn(): Promise<void> {
      if (signingIn) return signingIn;
      if (state.status === 'signing-out') return Promise.reject(Error('Wait for Salesforce sign-out to finish.'));
      if (!sdk) return Promise.reject(Error('Salesforce sign-in needs a native Mobile SDK build.'));
      const native = sdk, current = ++epoch;
      emit({ status: 'signing-in', identity: null, records: [], error: null });
      const task = (async () => {
        try {
          let account: Identity;
          try { account = await call<Identity>((yes, no) => native.oauth.getAuthCredentials(yes, no), 'No active Salesforce session.'); }
          catch {
            if (current !== epoch) return;
            account = await call<Identity>((yes, no) => native.oauth.authenticate(yes, no), 'Salesforce sign-in was cancelled or failed. Try again.');
          }
          if (current === epoch) emit({ status: 'ready', identity: identity(account), records: [], error: null });
        } catch (error) {
          if (current === epoch) { emit({ status: 'error', error: error instanceof Error ? error.message : 'Salesforce sign-in failed.' }); throw error; }
        } finally { signingIn = null; }
      })();
      signingIn = task;
      return task;
    },
    async loadRecords() {
      const native = requireSDK();
      if (!state.identity || !['ready', 'loading', 'error'].includes(state.status)) throw Error('Sign in to Salesforce first.');
      const current = ++epoch;
      emit({ status: 'loading', error: null });
      try {
        const response = await call<{ records: SalesforceRecord[] }>((yes, no) => native.net.query(query, yes, no), 'Salesforce could not load records. Check your connection and object and field access.');
        if (current !== epoch) return;
        if (!response || !Array.isArray(response.records) || response.records.some(record => !record || typeof record.Id !== 'string')) throw Error('Salesforce returned an unexpected record response.');
        emit({ status: 'ready', records: response.records.slice(0, 100), error: null });
      } catch (error) {
        if (current === epoch) { emit({ status: 'error', records: [], error: error instanceof Error ? error.message : 'Salesforce could not load records.' }); throw error; }
      }
    },
    async signOut() {
      const native = requireSDK();
      if (state.status === 'signing-in' || state.status === 'signing-out') throw Error('Wait for the current Salesforce sign-in or sign-out to finish.');
      const current = ++epoch;
      emit({ status: 'signing-out', identity: null, records: [], error: null });
      try {
        await call<unknown>((yes, no) => native.oauth.logout(yes, no), 'Salesforce sign-out was not confirmed. Retry before sharing this device.');
        if (current === epoch) emit({ status: 'signed-out' });
      } catch (error) {
        if (current === epoch) { emit({ status: 'error', error: error instanceof Error ? error.message : 'Salesforce sign-out failed.' }); throw error; }
      }
    },
  };
}
export type SalesforceClient = ReturnType<typeof createSalesforceClient>;
