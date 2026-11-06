import type { Register } from 'claude-code'

import type { Limits, SkillStats } from '../types'

const REFRESH_MS = 30_000
// Ping when this little of the cache window is left.
const PING_WITHIN_MS = 75_000
// Stop keeping warm after this many pings without you sending anything.
const MAX_IDLE_PINGS = 12
// Relative token weights (base input = 1) used to rank what a skill's turns cost.
const W = { input: 1, write: 1.25, read: 0.1, output: 5 }
const BAR_W = 20

const LIMITS = { plugin: 'usage-bar', key: 'limits' } as const
const LAST = { plugin: 'usage-bar', key: 'lastResponseAt' } as const
const NOW = { plugin: 'usage-bar', key: 'now' } as const
const OPEN = { plugin: 'usage-bar', key: 'isOpen' } as const
const SKILLS = { plugin: 'usage-bar', key: 'skills' } as const
const KEEP = { plugin: 'usage-bar', key: 'keepWarm' } as const
const TTL = { plugin: 'usage-bar', key: 'ttlMin' } as const
const CTX = { plugin: 'usage-bar', key: 'contextTokens' } as const
const PINGS = { plugin: 'usage-bar', key: 'pings' } as const
const NO_LIMITS: Limits = { session: null, weekly: null }

const C = { good: '#b5e61d', warn: '#f5a524', bad: '#e5484d', track: '#3b3b3b', ink: '#111111', white: '#ffffff' }
const tone = (pct: number) => (pct >= 90 ? C.bad : pct >= 70 ? C.warn : C.good)

const left = (iso: string | undefined, at: number) => {
  if (!iso || !at) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - at) / 60_000))
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`)

const pick = (u: { rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[] }): Limits => {
  const find = (k: string) => {
    const r = u.rateLimits.find(x => x.kind === k)
    return r ? { pct: r.percentUsed, resetsAt: r.resetsAt } : null
  }
  return { session: find('five_hour'), weekly: find('seven_day') }
}

// Cells of a bar: [filled text, empty text], the label centred across both.
const cells = (pct: number, label: string) => {
  const pad = Math.max(0, BAR_W - label.length)
  const text = ' '.repeat(Math.floor(pad / 2)) + label + ' '.repeat(Math.ceil(pad / 2))
  const filled = Math.max(0, Math.min(BAR_W, Math.round((pct / 100) * BAR_W)))
  return [text.slice(0, filled), text.slice(filled)] as const
}

const barSvg = (pct: number, color: string, tip?: string, W = 360) => {
  const H = 14
  const fill = pct <= 0 ? 0 : Math.max(H, Math.min(W, (pct / 100) * W))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none">` +
    (tip ? `<title>${tip}</title>` : '') +
    `<rect width="${W}" height="${H}" rx="7" fill="${C.track}"/>` +
    (fill > 0 ? `<rect width="${fill}" height="${H}" rx="7" fill="${color}"/>` : '') +
    `</svg>`
  )
}

let busy = false
let timer: (() => void) | undefined

// Refreshes usage and, when asked to, pings the model so the prompt cache stays warm.
async function tick($: any) {
  const t: number = await $.clock.now()
  const u = await $.session.usage()
  await $.state.set(LIMITS, pick(u))
  await $.state.set(NOW, t)
  await $.state.set(CTX, u.context.tokens ?? 0)

  const keep = (await $.state.get(KEEP)).value ?? false
  const last = (await $.state.get(LAST)).value ?? 0
  const ttl = (await $.state.get(TTL)).value ?? 60
  const pings = (await $.state.get(PINGS)).value ?? 0
  const remain = ttl * 60_000 - (t - last)
  if (keep && !busy && last > 0 && remain > 0 && remain < PING_WITHIN_MS && pings < MAX_IDLE_PINGS) {
    const r = await $.model.fork({ prompt: 'Cache keep-alive ping. Reply with only: ok' })
    if (r.isAnswered) {
      await $.state.set(LAST, await $.clock.now())
      await $.state.set(PINGS, pings + 1)
    }
  }
}

function ensureTimer($: any) {
  timer?.()
  const handle = $.clock.every(REFRESH_MS, () => void tick($).catch(() => {}))
  timer = () => handle.cancel()
}

export const register: Register = on => {
  let pending = new Set<string>()

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('skills')) as SkillStats | undefined
    if (saved) await $.state.set(SKILLS, saved)
    const keep = await $.store.get('keepWarm')
    if (typeof keep === 'boolean') await $.state.set(KEEP, keep)
    const ttl = await $.store.get('ttlMin')
    if (typeof ttl === 'number') await $.state.set(TTL, ttl)
    await tick($).catch(() => {})
    ensureTimer($)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    busy = true
    return next(e)
  })

  on('tool.call', { tool: 'Skill' }, ($, e, next) => {
    if (e.skill) pending.add(e.skill)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    busy = false
    $.ui.status(undefined)
    const t = await $.clock.now()
    await $.state.set(LAST, t)
    if (!e.agentId) await $.state.set(PINGS, 0)
    const u = e.usage
    if (u && !e.agentId && pending.size > 0) {
      const names = [...pending]
      const cost =
        (u.input_tokens * W.input +
          u.cache_creation_input_tokens * W.write +
          u.cache_read_input_tokens * W.read +
          u.output_tokens * W.output) /
        names.length
      const out: SkillStats = { ...((await $.state.get(SKILLS)).value ?? {}) }
      for (const n of names) {
        const cur = out[n] ?? { uses: 0, cost: 0 }
        out[n] = { uses: cur.uses + 1, cost: cur.cost + cost }
      }
      await $.state.set(SKILLS, out)
      await $.store.set('skills', out)
    }
    pending = new Set()
    await tick($).catch(() => {})
    if (!timer) ensureTimer($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const lim = (await $.state.get(LIMITS)).value ?? NO_LIMITS
    const last = (await $.state.get(LAST)).value ?? 0
    const at = (await $.state.get(NOW)).value ?? 0
    const open = (await $.state.get(OPEN)).value ?? false
    const stats = (await $.state.get(SKILLS)).value ?? {}
    const keep = (await $.state.get(KEEP)).value ?? false
    const ttl = (await $.state.get(TTL)).value ?? 60
    const ctx = (await $.state.get(CTX)).value ?? 0

    const toggleOpen = async () => {
      const held = await $.state.get(OPEN)
      await $.state.set(OPEN, !(held.value ?? false))
    }
    const toggleKeep = async () => {
      const held = await $.state.get(KEEP)
      const next2 = !(held.value ?? false)
      await $.state.set(KEEP, next2)
      await $.store.set('keepWarm', next2)
      await $.state.set(PINGS, 0)
    }
    const cycleTtl = async () => {
      const held = await $.state.get(TTL)
      const next2 = (held.value ?? 60) === 60 ? 5 : 60
      await $.state.set(TTL, next2)
      await $.store.set('ttlMin', next2)
    }

    const isEditor = e.surface === 'vscode'
    const table = $.ui.resolve(e)
    const Svg = (table as unknown as { Svg?: (p: { source: string; alt: string; width?: number; height?: number; isInteractive?: true }) => never }).Svg

    // A rounded, full-section bar: an Svg where the surface has one, else cells.
    const barView = (pct: number, label: string, color: string, alt: string, tip?: string) => {
      if (Svg) return <Svg source={barSvg(pct, color, tip, isEditor ? 140 : 360)} alt={alt} height={14} isInteractive={tip ? true : undefined} />
      const [x, y] = cells(pct, label)
      return (
        <Box flexDirection="row">
          <Text backgroundColor={color} color={C.ink} bold>{x}</Text>
          <Text backgroundColor={C.track} color={C.white} bold>{y}</Text>
        </Box>
      )
    }

    const section = (title: string, value: string, right: string, bar: ReturnType<typeof barView>, extra?: string) => (
      <Box flexDirection="column" flexGrow={1} gap={isEditor ? 0 : 1} minWidth={isEditor ? 140 : undefined}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text dimColor>{title}</Text>
            <Text bold> {value}</Text>
          </Text>
          <Box flexDirection="row" gap={1} alignItems="center">
            {extra ? <Text size="footnote" color="#6f6f6f">{extra}</Text> : null}
            <Text dimColor>{right}</Text>
          </Box>
        </Box>
        {bar}
      </Box>
    )

    const meter = (title: string, l: { pct: number; resetsAt?: string } | null) =>
      section(
        title,
        l ? `${Math.round(l.pct)}%` : 'n/a',
        l ? `↻ ${left(l.resetsAt, at)}` : '',
        barView(l ? l.pct : 0, l ? `${Math.round(l.pct)}%` : 'n/a', tone(l ? l.pct : 0), `${title} usage`),
      )

    const remain = last > 0 ? ttl * 60_000 - (at - last) : 0
    const warm = remain > 0
    const cachePct = warm ? Math.min(100, (remain / (ttl * 60_000)) * 100) : 0
    const cache = section(
      'cache',
      '',
      warm ? `${Math.ceil(remain / 60_000)}min` : 'cold',
      barView(
        cachePct,
        '',
        remain < 60_000 ? C.warn : C.good,
        'cache time left',
        ctx > 0 ? `Context: ${ctx.toLocaleString('en-US')} tokens` : 'Context: no response yet',
      ),
      ctx > 0 ? compact(ctx) : undefined,
    )

    const divider = isEditor ? null : <Box width={1} backgroundColor="#555555" />
    const line = (
      <Box flexDirection="row" gap={isEditor ? 2 : 3} alignItems={isEditor ? 'center' : 'stretch'} flexWrap={isEditor ? 'wrap' : 'nowrap'} paddingX={1}>
        {meter('session', lim.session)}
        {divider}
        {meter('weekly', lim.weekly)}
        {divider}
        {cache}
        <Box flexDirection="row" gap={1} alignSelf="center">
          <Button key="keep" label="♨" variant={keep ? 'primary' : 'secondary'} onPress={toggleKeep} />
          <Button key="open" onPress={toggleOpen}>
            <Text>{open ? '▾' : '▸'}</Text>
          </Button>
        </Box>
      </Box>
    )
    if (!open) return line

    const rows = Object.entries(stats)
    const total = rows.reduce((a, [, s]) => a + s.cost, 0) || 1
    const byCost = [...rows].sort((a, b) => b[1].cost - a[1].cost).slice(0, 6)
    const byUse = [...rows].sort((a, b) => b[1].uses - a[1].uses).slice(0, 6)

    return (
      <Box flexDirection="column" gap={1}>
        {line}
        <Box flexDirection="row" gap={4} paddingX={1}>
          <Box flexDirection="column">
            <Text bold>Most used</Text>
            {byUse.length === 0 && <Text dimColor>no skills invoked yet</Text>}
            {byUse.map(([n, s]) => (
              <Text key={n}>
                {n.slice(0, 28).padEnd(28)} <Text dimColor>{s.uses}×</Text>
              </Text>
            ))}
          </Box>
          <Box flexDirection="column">
            <Text bold>
              Costing most <Text dimColor>(weighted tokens)</Text>
            </Text>
            {byCost.map(([n, s]) => {
              const share = (s.cost / total) * 100
              return (
                <Box key={n} flexDirection="row" gap={2} alignItems="center">
                  <Text>{n.slice(0, 28).padEnd(28)}</Text>
                  <Box flexGrow={1}>{barView(share, `${Math.round(share)}%`, tone(share), `${n} share of cost`)}</Box>
                  <Text dimColor>{compact(s.cost)} · {Math.round(share)}%</Text>
                </Box>
              )
            })}
          </Box>
        </Box>
        <Box flexDirection="row" gap={2} paddingX={1}>
          <Button key="ttl" label={`cache window: ${ttl}min (click to switch 5/60)`} onPress={cycleTtl} />
        </Box>
      </Box>
    )
  })
}
