/**
 * The arithmetic behind the per-minute `stats` log line: counts over a window,
 * and the change in cumulative counters since the last line.
 */

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
