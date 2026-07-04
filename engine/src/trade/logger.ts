// ── Engine activity logger ───────────────────────────────────────────────
// Human-readable, leveled logging so the engine terminal shows all activity:
// orders received, trades/fills, resting/cancelled orders, balances, on-ramp,
// snapshots, and stream lifecycle.
//
// Controlled by ENGINE_LOG_LEVEL: silent | error | warn | info | debug
//   - default "info": shows orders, trades, cancels, on-ramp, snapshots.
//   - "debug": adds stream recv/ack, depth/ticker publishes, balance deltas.
// Backwards-compatible: ENGINE_LOG_MESSAGES=true forces "debug".

const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 } as const;
type LevelName = keyof typeof LEVELS;

let configured = (process.env.ENGINE_LOG_LEVEL || "info").toLowerCase();
if (process.env.ENGINE_LOG_MESSAGES === "true") configured = "debug";
const threshold = LEVELS[configured as LevelName] ?? LEVELS.info;

function emit(level: Exclude<LevelName, "silent">, tag: string, msg: string) {
    if (LEVELS[level] > threshold) return;
    const line = `${new Date().toISOString()} [${tag}] ${msg}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
}

/** Shorten a UUID for readable logs (first 8 chars). */
export const short = (id: string | undefined | null): string =>
    id && id.length > 8 ? id.slice(0, 8) : String(id ?? "");

export const elog = {
    info: (tag: string, msg: string) => emit("info", tag, msg),
    warn: (tag: string, msg: string) => emit("warn", tag, msg),
    error: (tag: string, msg: string) => emit("error", tag, msg),
    debug: (tag: string, msg: string) => emit("debug", tag, msg),
    /** True when the given level would be emitted — guard expensive log-arg building. */
    enabled: (level: LevelName) => LEVELS[level] <= threshold,
};
