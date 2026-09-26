import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { SalesforceClient } from './client';

const Context = createContext<SalesforceClient | null>(null);

/** Pass one stable client per org/environment; replace it when that selection changes. */
export function SalesforceProvider({ client, children }: { client: SalesforceClient; children: ReactNode }) {
  return <Context.Provider value={client}>{children}</Context.Provider>;
}

export function useSalesforce() {
  const client = useContext(Context);
  if (!client) throw Error('Wrap this screen in SalesforceProvider.');
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  return { ...state, signIn: client.signIn, signOut: client.signOut, loadRecords: client.loadRecords };
}
