# effect-statsig-server-core

Statsig feature gates and experiments for [Effect](https://effect.website) (v4).

This package is unofficial and not affiliated with Statsig.

It calls the same native binary as Statsig's `@statsig/statsig-node-core`, so rules sync,
evaluation and exposure logging all run in Statsig's Rust core. What it drops is Statsig's
JS wrapper and its runtime dependencies (`@octokit/core`, `https-proxy-agent`,
`node-fetch`), none of which the wrapper needs, since the Rust core makes its own HTTP
requests. The only dependency is `effect`, as a peer, plus the binary for your platform.

## Install

```sh
pnpm add effect-statsig-server-core effect
```

The binary is Statsig's `@statsig/statsig-node-core-<platform>` package. It is an optional
dependency, so your package manager installs only the one for your OS and CPU. Statsig
publishes them for macOS (arm64, x64), Linux (arm64, x64; glibc and musl) and Windows
(arm64, ia32, x64).

If you install on one platform and run on another (say, `node_modules` built on a Mac and
copied into a Linux image), the right binary won't be there. Install on the target.

## Usage

```ts
import { Statsig } from "effect-statsig-server-core"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const user = { userID: "user-1", email: "someone@example.com", custom: { plan: "pro" } }

  const enabled = yield* Statsig.checkGate(user, "new_checkout")

  const pricing = yield* Statsig.getExperiment(user, "pricing")
  const price = pricing.get("price", 10) // 10 if missing or not a number

  return { enabled, price, group: pricing.groupName }
})

program.pipe(Effect.provide(Statsig.layerConfig({ environment: "production" })))
```

| Function                             | Returns                                                  |
| ------------------------------------ | -------------------------------------------------------- |
| `Statsig.checkGate(user, name)`      | `boolean`                                                |
| `Statsig.getFeatureGate(user, name)` | `FeatureGate`: `value`, `ruleID`, `idType`, `details`    |
| `Statsig.getExperiment(user, name)`  | `Experiment`: `value`, `groupName`, `get(key, fallback)` |
| `Statsig.flushEvents`                | Sends queued exposures now                               |

Each evaluation takes `{ disableExposureLogging: true }` as a third argument. A user needs a
`userID` or `customIDs`.

`Experiment.get(key, fallback)` returns `fallback` when the parameter is missing or has a
different type (each primitive type, arrays and objects are distinct). For typed parameters,
decode `experiment.value` with a `Schema`.

### Layers

| Layer                          | Key                                                             |
| ------------------------------ | --------------------------------------------------------------- |
| `Statsig.layerConfig(options)` | From config, `STATSIG_SERVER_API_KEY` by default                |
| `Statsig.layer(options)`       | `options.sdkKey`, a string or `Redacted`                        |
| `Statsig.layerTest(values)`    | None. Offline, with fixed gate and experiment values, for tests |

`STATSIG_SERVER_API_KEY` is the variable Vercel's Statsig integration sets. Pass
`sdkKey: Config.Redacted("OTHER_NAME")` to `layerConfig` to read another one.

The other options are Statsig's own, with the same names: `environment`, `initTimeoutMs`,
`specsSyncIntervalMs`, `specsUrl`, `logEventUrl`, `disableNetwork`, `disableAllLogging`,
`disableCountryLookup`, `outputLogLevel`, `serviceName`. `shutdownTimeoutMs` (default 3000)
caps how long shutdown spends flushing events.

### Lifecycle and failures

- Building the layer creates the client and waits for `initialize`, which fetches rules
  (up to `initTimeoutMs`, default 3000). Closing the layer's scope calls `shutdown`, which
  flushes queued exposures.
- If `initialize` fails (bad key, network down), the layer logs a warning and builds anyway.
  Gates return `false` and experiments `{}`, with reason `NoValues`, until a background sync
  succeeds. This matches Statsig's SDK.
- Evaluations never fail. If the binding throws, the error is logged and you get the
  default, with reason `Error`.
- A missing binary is a defect when the layer builds. It's a packaging problem, not
  something to retry.
- The binary prints its own warnings to stdout. Set `outputLogLevel` to change that.

On serverless platforms the scope may never close, so queued exposures wait for the next
background flush (1 to 60 seconds). Run `Statsig.flushEvents` after a request if you need
them sent sooner, e.g. with Vercel's `waitUntil`.

### Tests

```ts
const TestStatsig = Statsig.layerTest({
  gates: { new_checkout: true },
  experiments: { pricing: { price: 20 } },
})
```

This is the real client with the network off, so it needs the binary too. Every user gets
these values, reported with reason `LocalOverride:Recognized`. Gates you don't list are
`false` and experiments you don't list are `{}`.

## Versioning

The binary is pinned to an exact version (`0.23.1`). This package calls
`__INTERNAL_getFeatureGate` and `__INTERNAL_getExperiment`, the same methods Statsig's JS
wrapper calls. They are not a public API and may change in any release, so update the pin
deliberately and run the tests.

## Development

```sh
pnpm install
pnpm test
pnpm check   # tsc
pnpm lint    # oxlint
pnpm fmt     # oxfmt
pnpm build   # tsdown -> dist/
```

## License

MIT, for this package's code.

The native binaries are Statsig's. They come from Statsig's own npm packages, and this
package doesn't redistribute them. Statsig publishes the source in
[statsig-io/statsig-server-core](https://github.com/statsig-io/statsig-server-core) under the
ISC license. The binary packages on npm say MIT.
