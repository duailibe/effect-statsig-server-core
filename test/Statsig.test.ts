import { setImmediate } from "node:timers/promises"
import { assert, describe, expectTypeOf, it, vi } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Logger, Redacted } from "effect"
import { Statsig } from "../src/index.js"
import { load, type NativeResult, type NativeStatsig } from "../src/internal/native.js"

const user = { userID: "user-1", email: "someone@example.com", custom: { plan: "pro" } }

const TestLayer = Statsig.layerTest({
  gates: { on: true, off: false },
  experiments: { pricing: { price: 20, color: "red", tiers: ["a"], limits: { max: 1 } } },
})

// Collects log messages, so tests can assert on warnings.
const captureLogs = () => {
  const messages: Array<ReadonlyArray<unknown>> = []
  const logger = Logger.make(({ message }) => {
    messages.push(Array.isArray(message) ? message : [message])
  })
  return { messages, layer: Logger.layer([logger]) }
}

describe("Statsig", () => {
  describe("gates", () => {
    it.effect("checkGate returns the value", () =>
      Effect.gen(function* () {
        assert.isTrue(yield* Statsig.checkGate(user, "on"))
        assert.isFalse(yield* Statsig.checkGate(user, "off"))
        assert.isFalse(yield* Statsig.checkGate(user, "unknown"))
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("getFeatureGate returns the rule and details", () =>
      Effect.gen(function* () {
        const gate = yield* Statsig.getFeatureGate(user, "on")
        assert.strictEqual(gate.name, "on")
        assert.isTrue(gate.value)
        assert.strictEqual(gate.ruleID, "override")
        assert.strictEqual(gate.details.reason, "LocalOverride:Recognized")

        const unknown = yield* Statsig.getFeatureGate(user, "unknown")
        assert.isFalse(unknown.value)
        assert.strictEqual(unknown.ruleID, "")
        assert.strictEqual(unknown.idType, "")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("accepts users identified only by customIDs", () =>
      Effect.gen(function* () {
        assert.isTrue(yield* Statsig.checkGate({ customIDs: { companyID: "c-1" } }, "on"))
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("experiments", () => {
    it.effect("getExperiment returns the parameters", () =>
      Effect.gen(function* () {
        const experiment = yield* Statsig.getExperiment(user, "pricing")
        assert.strictEqual(experiment.name, "pricing")
        assert.deepStrictEqual(experiment.value, {
          price: 20,
          color: "red",
          tiers: ["a"],
          limits: { max: 1 },
        })
        assert.strictEqual(experiment.details.reason, "LocalOverride:Recognized")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an unknown experiment has no parameters and no group", () =>
      Effect.gen(function* () {
        const experiment = yield* Statsig.getExperiment(user, "unknown")
        assert.deepStrictEqual(experiment.value, {})
        assert.isUndefined(experiment.groupName)
        assert.strictEqual(experiment.get("price", 10), 10)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get falls back when the parameter is missing or has another type", () =>
      Effect.gen(function* () {
        const experiment = yield* Statsig.getExperiment(user, "pricing")
        assert.strictEqual(experiment.get("price", 10), 20)
        assert.strictEqual(experiment.get("color", "blue"), "red")
        assert.strictEqual(experiment.get("missing", "blue"), "blue")
        assert.strictEqual(experiment.get("price", "ten"), "ten")
        assert.deepStrictEqual(experiment.get("tiers", ["b"]), ["a"])
        assert.deepStrictEqual(experiment.get("tiers", {}), {})
        assert.deepStrictEqual(experiment.get("limits", []), [])
        assert.strictEqual(experiment.get("price", null), 20)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get only infers validated primitive types", () =>
      Effect.gen(function* () {
        const experiment = yield* Statsig.getExperiment(user, "pricing")
        expectTypeOf(experiment.get("price", 10)).toEqualTypeOf<number>()
        expectTypeOf(experiment.get("color", "blue")).toEqualTypeOf<string>()
        expectTypeOf(experiment.get("missing", false)).toEqualTypeOf<boolean>()
        expectTypeOf(experiment.get("price", null)).toEqualTypeOf<unknown>()
        expectTypeOf(experiment.get("price", undefined)).toEqualTypeOf<unknown>()
        expectTypeOf(experiment.get("tiers", ["b"])).toEqualTypeOf<unknown>()
        expectTypeOf(experiment.get("limits", { max: "unlimited" })).toEqualTypeOf<unknown>()
        assert.strictEqual(experiment.get("price", undefined), 20)
        assert.deepStrictEqual(experiment.get("limits", { max: "unlimited" }), { max: 1 })
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it("waits for initialization before shutdown when interrupted", async () => {
    const prototype = load().StatsigNapiInternal.prototype as NativeStatsig
    const started = Promise.withResolvers<void>()
    const initialized = Promise.withResolvers<NativeResult>()
    const initialize = vi.spyOn(prototype, "initialize").mockImplementation(() => {
      started.resolve()
      return initialized.promise
    })
    const shutdown = vi.spyOn(prototype, "shutdown")
    const controller = new AbortController()
    const running = Effect.runPromiseExit(
      Statsig.make({
        sdkKey: "secret-test",
        disableNetwork: true,
        disableAllLogging: true,
        outputLogLevel: "none",
      }).pipe(Effect.scoped),
      { signal: controller.signal },
    )
    try {
      await started.promise
      controller.abort()
      await setImmediate()
      assert.lengthOf(shutdown.mock.calls, 0)

      initialized.resolve({ isSuccess: true })
      const exit = await running
      assert.isTrue(Exit.hasInterrupts(exit))
      assert.lengthOf(shutdown.mock.calls, 1)
    } finally {
      initialized.resolve({ isSuccess: true })
      await running
      initialize.mockRestore()
      shutdown.mockRestore()
    }
  })

  it.effect("a failed evaluation logs an error and returns the default", () => {
    const logs = captureLogs()
    // A customIDs value the binding cannot convert makes it throw.
    const bad = { customIDs: { companyID: Symbol("x") as unknown as string } }
    return Effect.gen(function* () {
      assert.isFalse(yield* Statsig.checkGate(bad, "on"))
      const gate = yield* Statsig.getFeatureGate(bad, "on")
      assert.strictEqual(gate.details.reason, "Error")
      const experiment = yield* Statsig.getExperiment(bad, "pricing")
      assert.deepStrictEqual(experiment.value, {})
      assert.strictEqual(experiment.details.reason, "Error")
      assert.lengthOf(logs.messages, 3)
      assert.match(String(logs.messages[0]?.[0]), /failed to evaluate gate on/)
    }).pipe(Effect.provide([TestLayer, logs.layer]))
  })

  it.effect("flushEvents succeeds", () => Statsig.flushEvents.pipe(Effect.provide(TestLayer)))

  it.effect("a failed initialize is logged and the layer still builds", () => {
    const logs = captureLogs()
    // Nothing listens on this port, so fetching rules fails fast.
    const layer = Statsig.layer({
      sdkKey: Redacted.make("secret-invalid"),
      specsUrl: "http://127.0.0.1:9/specs",
      logEventUrl: "http://127.0.0.1:9/log",
      disableAllLogging: true,
      disableCountryLookup: true,
      outputLogLevel: "none",
      initTimeoutMs: 1000,
      shutdownTimeoutMs: 100,
    })
    return Effect.gen(function* () {
      const gate = yield* Statsig.getFeatureGate(user, "on")
      assert.isFalse(gate.value)
      assert.strictEqual(gate.details.reason, "NoValues")
      assert.isTrue(
        logs.messages.some((message) => String(message[0]).includes("initialize failed")),
      )
    }).pipe(Effect.provide(layer.pipe(Layer.provide(logs.layer))))
  })

  it.effect("layerConfig reads STATSIG_SERVER_API_KEY", () =>
    Effect.gen(function* () {
      const error = yield* Layer.build(Statsig.layerConfig()).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})),
        Effect.flip,
      )
      assert.strictEqual(error._tag, "ConfigError")
      assert.match(String(error), /STATSIG_SERVER_API_KEY/)
    }),
  )
})
