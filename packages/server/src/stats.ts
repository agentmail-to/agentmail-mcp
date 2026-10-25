/**
 * The arithmetic behind the per-minute `stats` log line: counts and latency
 * percentiles over a window, and the change in cumulative counters since the
 * last line.
 *
 * Latency is kept as a bounded uniform sample (reservoir sampling), so a burst
 * cannot grow memory and the percentiles stay unbiased; n and max are exact.
 */

const RESERVOIR_SIZE = 2048

const round = (ms: number) => (ms >= 100 ? Math.round(ms) : Math.round(ms * 10) / 10)

export type LatencySummary = { n: number; p50: number; p95: number; p99: number; max: number }

class Reservoir {
    private readonly samples: number[] = []
    private seen = 0
    private max = 0

    add(ms: number) {
        this.seen++
        if (ms > this.max) this.max = ms
        if (this.samples.length < RESERVOIR_SIZE) {
            this.samples.push(ms)
            return
        }
        const slot = Math.floor(Math.random() * this.seen)
        if (slot < RESERVOIR_SIZE) this.samples[slot] = ms
    }

    summary(): LatencySummary {
        const sorted = Float64Array.from(this.samples).sort()
        // Nearest rank: the smallest sample with at least q of the samples at or below it.
        const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0
        return { n: this.seen, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(this.max) }
    }
}

/** Latency samples by key (an MCP method, an upstream), summarized and cleared each window. */
export class LatencyWindow {
    private reservoirs = new Map<string, Reservoir>()

    add(key: string, ms: number) {
        let reservoir = this.reservoirs.get(key)
        if (!reservoir) {
            reservoir = new Reservoir()
            this.reservoirs.set(key, reservoir)
        }
        reservoir.add(ms)
    }

    /** Every key seen since the last call, then start over. */
    take(): Record<string, LatencySummary> {
        const out = Object.fromEntries([...this.reservoirs].map(([key, reservoir]) => [key, reservoir.summary()]))
        this.reservoirs = new Map()
        return out
    }
}

/** Counts by key, cleared each window. */
export class CountWindow {
    private counts = new Map<string, number>()

    add(key: string, by = 1) {
        this.counts.set(key, (this.counts.get(key) ?? 0) + by)
    }

    take(): Record<string, number> {
        const out = Object.fromEntries(this.counts)
        this.counts = new Map()
        return out
    }
}

/**
 * Cumulative counts by key, for keys that come from outside (a header): at
 * most `maxKeys` of them, after which new keys count as "other".
 */
export class BoundedCounts {
    private readonly counts = new Map<string, number>()

    constructor(private readonly maxKeys: number) {}

    /** Count one for `key`, and return the key it was counted under. */
    add(key: string): string {
        const bucket = this.counts.has(key) || this.counts.size < this.maxKeys ? key : 'other'
        this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1)
        return bucket
    }

    toJSON(): Record<string, number> {
        return Object.fromEntries(this.counts)
    }
}

/**
 * How much each cumulative counter grew since the previous call, leaving out
 * the ones that did not move. Totals live where /health reads them; the stats
 * line reports the change, so the two never disagree.
 */
export function counterDeltas(): (current: Record<string, number>) => Record<string, number> {
    let previous: Record<string, number> = {}
    return (current) => {
        const out: Record<string, number> = {}
        for (const [key, value] of Object.entries(current)) {
            const delta = value - (previous[key] ?? 0)
            if (delta !== 0) out[key] = delta
        }
        previous = { ...current }
        return out
    }
}
