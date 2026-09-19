import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import type { Diagnostic } from './contracts.js';
export class Diagnostics extends EventEmitter {
  private entries = new Map<string, Diagnostic[]>();
  private dropped = new Set<string>();
  add(id: string, source: Diagnostic['source'], level: Diagnostic['level'], message: string) {
    const clean = stripVTControlCharacters(message);
    const items = this.entries.get(id) ?? [];
    items.push({ time: new Date().toISOString(), source, level, message: clean.slice(-4000) });
    if (clean.length > 4000) this.dropped.add(id);
    if (items.length > 100) { items.shift(); this.dropped.add(id); }
    this.entries.set(id, items); this.emit('change', id);
  }
  read(id: string) { return { entries: this.entries.get(id) ?? [], truncated: this.dropped.has(id) }; }
}
