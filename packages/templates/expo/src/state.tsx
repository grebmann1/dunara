import { createContext, useContext, useState, type PropsWithChildren } from 'react';
const HabitContext = createContext<{ completed: boolean; setCompleted: (value: boolean) => void; note: string; setNote: (value: string) => void } | null>(null);
export function HabitProvider({ children }: PropsWithChildren) {
  const [completed, setCompleted] = useState(false);
  const [note, setNote] = useState('Make room for a slower morning.');
  return <HabitContext.Provider value={{ completed, setCompleted, note, setNote }}>{children}</HabitContext.Provider>;
}
export function useHabit() { const state = useContext(HabitContext); if (!state) throw new Error('HabitProvider is required'); return state; }
