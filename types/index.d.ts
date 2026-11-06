export type Limit = { pct: number; resetsAt?: string }
export type Limits = { session: Limit | null; weekly: Limit | null }
export type SkillStat = { uses: number; cost: number }
export type SkillStats = Record<string, SkillStat>

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      limits: Limits
      lastResponseAt: number
      now: number
      isOpen: boolean
      skills: SkillStats
      keepWarm: boolean
      ttlMin: number
      pings: number
    }
  }
}
