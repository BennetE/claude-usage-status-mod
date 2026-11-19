export type Req = {
  t0: number
  mainOpen: string[]
  lastMainStart: number
  lastMainEnd?: number
  reason?: string
  stopAt?: number
  baseline: string[]
  tasks: string[]
  replyId?: string
  promptId?: string
}

export type Took = { ms: number; how: 'done' | 'interrupted' | 'error' | 'superseded' }

declare module 'claude-code' {
  interface PluginState {
    'usage-status': {
      req: Shaped<Req | null>
      took: StateFamily<Took>
    }
  }
}
