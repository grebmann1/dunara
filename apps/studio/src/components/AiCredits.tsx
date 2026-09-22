import type { AiCreditBalance } from '../../../../packages/core/src/managed-ai';

export function AiCredits({ balance }: { balance?: AiCreditBalance }) {
  if (!balance) return null;
  const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return <div className="ai-credit-balance" role="status">
    <strong>{format(balance.remaining)} / {format(balance.limit)} credits left</strong>
    <span>Resets {new Date(balance.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
    {balance.reserved > 0 && <small>{format(balance.reserved)} credits reserved for requests in progress or awaiting reconciliation.</small>}
    {balance.reason && <p>{balance.reason} Wait for reset or select a personal connection in Settings.</p>}
  </div>;
}
