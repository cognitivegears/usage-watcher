export type Window = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-buffer': { limits: Window[]; isOff: boolean; snoozeUntil: number }
  }
}
