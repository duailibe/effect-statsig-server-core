/**
 * Loads Statsig's native binary for the current platform.
 *
 * The binaries are published by Statsig as `@statsig/statsig-node-core-<platform>`,
 * one package per platform, each holding only the `.node` file. They are optional
 * dependencies, so a package manager installs only the one matching the host.
 */

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

/** A `StatsigUser` created by the binding. Opaque on the JS side. */
export interface NativeUser {
  readonly __nativeUser: unique symbol
}

export interface NativeResult {
  readonly isSuccess: boolean
  readonly error?: string
}

export interface NativeEvaluationOptions {
  readonly disableExposureLogging?: boolean | undefined
}

/**
 * The subset of `StatsigNapiInternal` this package calls. The `__INTERNAL_`
 * methods are what Statsig's own JS wrapper calls; they return plain objects.
 */
export interface NativeStatsig {
  initialize(): Promise<NativeResult>
  shutdown(timeoutMs?: number): Promise<NativeResult>
  flushEvents(): Promise<NativeResult>
  checkGate(user: NativeUser, name: string, options?: NativeEvaluationOptions): boolean
  __INTERNAL_getFeatureGate(
    user: NativeUser,
    name: string,
    options?: NativeEvaluationOptions,
  ): Record<string, unknown>
  __INTERNAL_getExperiment(
    user: NativeUser,
    name: string,
    options?: NativeEvaluationOptions,
  ): Record<string, unknown>
  overrideGate(name: string, value: boolean, id?: string): void
  overrideExperiment(name: string, value: Record<string, unknown>, id?: string): void
}

export interface Binding {
  readonly StatsigNapiInternal: new (sdkKey: string, options?: object) => NativeStatsig
  readonly StatsigUser: new (args: object) => NativeUser
}

const require = createRequire(import.meta.url)

const isMusl = (): boolean => {
  try {
    return readFileSync("/usr/bin/ldd", "utf8").includes("musl")
  } catch {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    return !report.header?.glibcVersionRuntime
  }
}

// Literal specifiers, so file tracers (like Vercel's) find the binary.
const requireBinding = (target: string): Binding | undefined => {
  switch (target) {
    case "darwin-arm64":
      return require("@statsig/statsig-node-core-darwin-arm64")
    case "darwin-x64":
      return require("@statsig/statsig-node-core-darwin-x64")
    case "linux-arm64":
      return isMusl()
        ? require("@statsig/statsig-node-core-linux-arm64-musl")
        : require("@statsig/statsig-node-core-linux-arm64-gnu")
    case "linux-x64":
      return isMusl()
        ? require("@statsig/statsig-node-core-linux-x64-musl")
        : require("@statsig/statsig-node-core-linux-x64-gnu")
    case "win32-arm64":
      return require("@statsig/statsig-node-core-win32-arm64-msvc")
    case "win32-ia32":
      return require("@statsig/statsig-node-core-win32-ia32-msvc")
    case "win32-x64":
      return require("@statsig/statsig-node-core-win32-x64-msvc")
    default:
      return undefined
  }
}

let binding: Binding | undefined

/**
 * The binding, loaded on first use. Loading it starts the binary's Rust
 * runtime, so this stays out of module initialization.
 */
export const load = (): Binding => {
  if (binding !== undefined) return binding
  const target = `${process.platform}-${process.arch}`
  let loaded: Binding | undefined
  try {
    loaded = requireBinding(target)
  } catch (cause) {
    throw new Error(
      `Failed to load the Statsig native binary for ${target}. Its @statsig/statsig-node-core-* ` +
        "package is an optional dependency: check it was installed for this platform.",
      { cause },
    )
  }
  if (loaded === undefined) {
    throw new Error(`Statsig publishes no native binary for ${target}.`)
  }
  return (binding = loaded)
}
