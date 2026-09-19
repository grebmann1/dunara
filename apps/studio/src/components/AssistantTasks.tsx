import { Check, Circle, LoaderCircle, Pause } from 'lucide-react';
import type { StoredTurn } from '../../../../packages/assistant/src/contracts';

export function AssistantTasks({ turn, active }: { turn: StoredTurn; active: boolean }) {
  if (!turn.tasks?.length) return null;
  const done = turn.tasks.filter(task => task.status === 'completed').length;
  return <details className="assistant-tasks" open>
    <summary><strong>{turn.mode === 'plan' ? 'Task plan' : 'Task progress'}</strong><span aria-live="polite">{done} of {turn.tasks.length} complete</span></summary>
    <progress max={turn.tasks.length} value={done} aria-label="Completed assistant tasks" />
    <ol>{turn.tasks.map(task => {
      const running = task.status === 'in_progress' && active;
      const label = task.status === 'completed' ? 'Complete' : task.status === 'pending' ? 'Pending' : running ? 'In progress' : turn.state === 'completed' ? 'Unfinished' : 'Paused';
      const Icon = task.status === 'completed' ? Check : task.status === 'pending' ? Circle : running ? LoaderCircle : Pause;
      return <li key={task.id} data-state={task.status}><Icon size={14} aria-hidden className={running ? 'assistant-spinner' : undefined} /><span>{task.label}</span><small>{label}</small></li>;
    })}</ol>
  </details>;
}
