import type { VenueName } from '../domain/types.js';
import type { StateStore } from '../store/sqlite.js';

export interface ExecutionEventInput {
  venue: VenueName;
  severity?: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  details?: unknown;
}

export class ExecutionRecorder {
  constructor(private readonly store: StateStore) {}

  event(input: ExecutionEventInput): void {
    this.store.recordEvent(input);
  }

  metric(name: string, value: number, venue: VenueName, labels: Record<string, unknown> = {}): void {
    this.store.recordMetric(name, value, { venue, mode: 'live', ...labels });
  }

  runCheckpoint(venue: VenueName, value: Record<string, unknown>): void {
    this.store.checkpoint(`run.${venue}`, { mode: 'live', ...value });
  }

  stage(venue: VenueName, stage: string, message: string, details: Record<string, unknown> = {}): void {
    this.store.checkpoint(`stage.${venue}`, {
      mode: 'live',
      stage,
      message,
      ...details
    });
  }
}
