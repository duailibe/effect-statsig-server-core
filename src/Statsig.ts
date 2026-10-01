/**
 * Statsig feature gates and experiments, evaluated in-process by Statsig's
 * native server core (the Rust SDK behind `@statsig/statsig-node-core`).
 *
 * The layer creates the client, waits for `initialize`, and calls `shutdown`
 * when its scope closes, which flushes queued exposures. A failed
 * `initialize` is logged, not raised: evaluations return defaults until a
 * background sync succeeds, as in Statsig's own SDK.
 *
 * @example
 * ```ts
 * import { Statsig } from "effect-statsig-server-core"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const user = { userID: "user-1", email: "someone@example.com" }
 *   const enabled = yield* Statsig.checkGate(user, "new_checkout")
 *   const pricing = yield* Statsig.getExperiment(user, "pricing")
 *   return { enabled, price: pricing.get("price", 10) }
 * }).pipe(Effect.provide(Statsig.layerConfig()))
 * ```
 */

import { Cause, Config, Context, Effect, Layer, Redacted, type Scope } from "effect"
import { load, type NativeStatsig, type NativeUser } from "./internal/native.js"

/** The environment variable `layerConfig` reads. Vercel's Statsig integration sets it. */
export const SDK_KEY_ENV = "STATSIG_SERVER_API_KEY"

type Primitive = string | number | boolean

/** A value for `custom` or `privateAttributes`. */
export type CustomValue =
  | Primitive
  | ReadonlyArray<Primitive>
  | Readonly<Record<string, unknown>>
  | null
  | undefined

interface UserFields {
  readonly userID?: string | undefined
  readonly customIDs?: Readonly<Record<string, string>> | undefined
  readonly email?: string | undefined
  readonly ip?: string | undefined
  readonly userAgent?: string | undefined
  readonly country?: string | undefined
  readonly locale?: string | undefined
  readonly appVersion?: string | undefined
  readonly custom?: Readonly<Record<string, CustomValue>> | undefined
  /** Used for evaluation but never sent to Statsig. */
  readonly privateAttributes?: Readonly<Record<string, CustomValue>> | undefined
}

/** Who a gate or experiment is evaluated for. Needs a `userID` or `customIDs`. */
export type StatsigUser = UserFields &
  ({ readonly userID: string } | { readonly customIDs: Readonly<Record<string, string>> })

/** Why an evaluation returned what it did. */
export interface EvaluationDetails {
  /**
   * Where the rules came from and whether the name was found, e.g.
   * `Network:Recognized`, `Network:Unrecognized`, `NoValues` (no rules loaded
   * yet), `LocalOverride:Recognized`, or `Error`.
   */
  readonly reason: string
  /** When the rules were last changed in the console, in ms since the epoch. */
  readonly lcut: number | undefined
  /** When this process received the rules, in ms since the epoch. */
  readonly receivedAt: number | undefined
  readonly version: number | undefined
}

export interface FeatureGate {
  readonly name: string
  readonly value: boolean
  /** The rule that matched, or `""` if none did. */
  readonly ruleID: string
  readonly idType: string
  readonly details: EvaluationDetails
}

export class Experiment {
  readonly name: string
  /** The parameters of the user's group, or `{}` when the user is not in the experiment. */
  readonly value: Readonly<Record<string, unknown>>
  /** The rule that matched, or `""` if none did. */
  readonly ruleID: string
  readonly idType: string
  /** The user's group, if the user is in the experiment. */
  readonly groupName: string | undefined
  readonly details: EvaluationDetails

  constructor(fields: {
    readonly name: string
    readonly value: Readonly<Record<string, unknown>>
    readonly ruleID: string
    readonly idType: string
    readonly groupName: string | undefined
    readonly details: EvaluationDetails
  }) {
    this.name = fields.name
    this.value = fields.value
    this.ruleID = fields.ruleID
    this.idType = fields.idType
    this.groupName = fields.groupName
    this.details = fields.details
  }

  /**
   * The parameter `key`, or `fallback` when it is missing or its type differs
   * from `fallback`'s (arrays, objects, and each primitive type count as
   * different). With a `null` or `undefined` fallback, any value is returned.
   * Only string, number, and boolean fallbacks give typed results. Other
   * fallbacks return `unknown`; use a `Schema` to decode structured values.
   */
  get(key: string, fallback: string): string
  get(key: string, fallback: number): number
  get(key: string, fallback: boolean): boolean
  get(key: string, fallback: unknown): unknown
  get(key: string, fallback: unknown): unknown {
    const value = this.value[key]
    if (value === undefined || value === null) return fallback
    if (fallback === undefined || fallback === null) return value
    return kindOf(value) === kindOf(fallback) ? value : fallback
  }
}

const kindOf = (value: unknown) => (Array.isArray(value) ? "array" : typeof value)

export interface EvaluationOptions {
  /** Don't log an exposure for this evaluation. */
  readonly disableExposureLogging?: boolean | undefined
}

export class Statsig extends Context.Service<
  Statsig,
  {
    readonly checkGate: (
      user: StatsigUser,
      gate: string,
      options?: EvaluationOptions,
    ) => Effect.Effect<boolean>
    readonly getFeatureGate: (
      user: StatsigUser,
      gate: string,
      options?: EvaluationOptions,
    ) => Effect.Effect<FeatureGate>
    readonly getExperiment: (
      user: StatsigUser,
      experiment: string,
      options?: EvaluationOptions,
    ) => Effect.Effect<Experiment>
    /** Send queued exposures now instead of at the next background flush. */
    readonly flushEvents: Effect.Effect<void>
  }
>()("effect-statsig-server-core/Statsig") {}

/** Whether `gate` passes for `user`. */
export const checkGate = (
  user: StatsigUser,
  gate: string,
  options?: EvaluationOptions,
): Effect.Effect<boolean, never, Statsig> =>
  Statsig.use((statsig) => statsig.checkGate(user, gate, options))

/** Like `checkGate`, with the rule and details behind the value. */
export const getFeatureGate = (
  user: StatsigUser,
  gate: string,
  options?: EvaluationOptions,
): Effect.Effect<FeatureGate, never, Statsig> =>
  Statsig.use((statsig) => statsig.getFeatureGate(user, gate, options))

/** The user's group in `experiment` and its parameters. */
export const getExperiment = (
  user: StatsigUser,
  experiment: string,
  options?: EvaluationOptions,
): Effect.Effect<Experiment, never, Statsig> =>
  Statsig.use((statsig) => statsig.getExperiment(user, experiment, options))

/** Send queued exposures now instead of at the next background flush. */
export const flushEvents: Effect.Effect<void, never, Statsig> = Statsig.use(
  (statsig) => statsig.flushEvents,
)

/** Options passed through to Statsig. Names and defaults are Statsig's. */
export interface StatsigOptions {
  /** The environment tier, e.g. `production`. Defaults to the one set for the key. */
  readonly environment?: string | undefined
  /** How long `initialize` waits for rules before giving up. Default 3000. */
  readonly initTimeoutMs?: number | undefined
  /** How often rules are re-fetched in the background. Default 10000. */
  readonly specsSyncIntervalMs?: number | undefined
  readonly specsUrl?: string | undefined
  readonly logEventUrl?: string | undefined
  /** Make no network requests: no rules are fetched and no events sent. */
  readonly disableNetwork?: boolean | undefined
  /** Send no exposures or events. */
  readonly disableAllLogging?: boolean | undefined
  readonly disableCountryLookup?: boolean | undefined
  /** What the SDK prints to stdout. Default `warn`. */
  readonly outputLogLevel?: "none" | "debug" | "info" | "warn" | "error" | undefined
  readonly serviceName?: string | undefined
}

export interface Options extends StatsigOptions {
  /** A server secret key (`secret-…`). */
  readonly sdkKey: string | Redacted.Redacted<string>
  /** How long `shutdown` may spend flushing events. Default 3000. */
  readonly shutdownTimeoutMs?: number | undefined
}

const emptyDetails = (reason: string): EvaluationDetails => ({
  reason,
  lcut: undefined,
  receivedAt: undefined,
  version: undefined,
})

const asNumber = (value: unknown) => (typeof value === "number" ? value : undefined)
const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

const toDetails = (raw: unknown): EvaluationDetails => {
  if (typeof raw !== "object" || raw === null) return emptyDetails("")
  const details = raw as Record<string, unknown>
  return {
    reason: asString(details.reason) ?? "",
    lcut: asNumber(details.lcut),
    receivedAt: asNumber(details.received_at),
    version: asNumber(details.version),
  }
}

const toFeatureGate = (name: string, raw: Record<string, unknown>): FeatureGate => ({
  name,
  value: raw.value === true,
  ruleID: asString(raw.ruleID) ?? "",
  idType: asString(raw.idType) ?? "",
  details: toDetails(raw.details),
})

const toExperiment = (name: string, raw: Record<string, unknown>): Experiment =>
  new Experiment({
    name,
    value:
      typeof raw.value === "object" && raw.value !== null
        ? (raw.value as Record<string, unknown>)
        : {},
    ruleID: asString(raw.ruleID) ?? "",
    idType: asString(raw.idType) ?? "",
    groupName: asString(raw.groupName),
    details: toDetails(raw.details),
  })

// Statsig's own wrapper never throws from an evaluation; neither does this.
const evaluate = <A>(what: string, fallback: () => A, run: () => A): Effect.Effect<A> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(run())
    } catch (cause) {
      return Effect.as(Effect.logError(`Statsig failed to evaluate ${what}.`, cause), fallback())
    }
  })

const logFailure =
  (what: string) =>
  (effect: Effect.Effect<{ readonly isSuccess: boolean; readonly error?: string }>) =>
    effect.pipe(
      Effect.flatMap((result) =>
        result.isSuccess ? Effect.void : Effect.logWarning(`Statsig ${what} failed.`, result.error),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(`Statsig ${what} failed.`, Cause.squash(cause)),
      ),
    )

const fromNative = (native: NativeStatsig): Statsig["Service"] => {
  const { StatsigUser } = load()
  const toNativeUser = (user: StatsigUser): NativeUser => new StatsigUser(user)
  return Statsig.of({
    checkGate: (user, gate, options) =>
      evaluate(
        `gate ${gate}`,
        () => false,
        () => native.checkGate(toNativeUser(user), gate, options),
      ),
    getFeatureGate: (user, gate, options) =>
      evaluate(
        `gate ${gate}`,
        () => toFeatureGate(gate, { details: { reason: "Error" } }),
        () =>
          toFeatureGate(gate, native.__INTERNAL_getFeatureGate(toNativeUser(user), gate, options)),
      ),
    getExperiment: (user, experiment, options) =>
      evaluate(
        `experiment ${experiment}`,
        () => toExperiment(experiment, { details: { reason: "Error" } }),
        () =>
          toExperiment(
            experiment,
            native.__INTERNAL_getExperiment(toNativeUser(user), experiment, options),
          ),
      ),
    flushEvents: Effect.promise(() => native.flushEvents()).pipe(logFailure("flushEvents")),
  })
}

const start = Effect.fnUntraced(function* (
  options: Options,
  setup: (native: NativeStatsig) => void = () => {},
) {
  const { sdkKey, shutdownTimeoutMs = 3000, ...statsigOptions } = options
  // Native initialization cannot be cancelled. Running it in the uninterruptible
  // acquire step registers `shutdown` only after it settles.
  const native = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const { StatsigNapiInternal } = load()
      const key = Redacted.isRedacted(sdkKey) ? Redacted.value(sdkKey) : sdkKey
      return new StatsigNapiInternal(key, statsigOptions)
    }).pipe(
      Effect.tap((client) =>
        Effect.promise(() => client.initialize()).pipe(logFailure("initialize")),
      ),
    ),
    (client) =>
      Effect.promise(() => client.shutdown(shutdownTimeoutMs)).pipe(logFailure("shutdown")),
  )
  setup(native)
  return fromNative(native)
})

/**
 * A client that is shut down when the scope closes. A failed `initialize` is
 * logged as a warning and the client is returned anyway.
 */
export const make = (options: Options): Effect.Effect<Statsig["Service"], never, Scope.Scope> =>
  start(options)

export const layer = (options: Options): Layer.Layer<Statsig> =>
  Layer.effect(Statsig)(make(options))

export interface LayerConfigOptions extends Omit<Options, "sdkKey"> {
  /** Where to read the key. Default: `STATSIG_SERVER_API_KEY`. */
  readonly sdkKey?: Config.Config<string | Redacted.Redacted<string>> | undefined
}

/** Like `layer`, reading the key from config (`STATSIG_SERVER_API_KEY` by default). */
export const layerConfig = (
  options: LayerConfigOptions = {},
): Layer.Layer<Statsig, Config.ConfigError> => {
  const { sdkKey = Config.Redacted(SDK_KEY_ENV), ...rest } = options
  return Layer.unwrap(Effect.map(sdkKey, (key) => layer({ ...rest, sdkKey: key })))
}

export interface TestOptions {
  /** Gate values, by name. Gates not listed are `false`. */
  readonly gates?: Readonly<Record<string, boolean>> | undefined
  /** Experiment parameters, by name. Experiments not listed are `{}`. */
  readonly experiments?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined
}

/**
 * The real client, offline: no rules are fetched and no events sent. Every
 * user gets the values given here, reported with reason
 * `LocalOverride:Recognized`.
 */
export const layerTest = (options: TestOptions = {}): Layer.Layer<Statsig> =>
  Layer.effect(Statsig)(
    start(
      {
        sdkKey: "secret-test",
        disableNetwork: true,
        disableAllLogging: true,
        outputLogLevel: "none",
      },
      (native) => {
        for (const [name, value] of Object.entries(options.gates ?? {})) {
          native.overrideGate(name, value)
        }
        for (const [name, value] of Object.entries(options.experiments ?? {})) {
          native.overrideExperiment(name, value)
        }
      },
    ),
  )
