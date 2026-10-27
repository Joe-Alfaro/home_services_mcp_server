// Gap-fix red tests read fields and exports by name, so their files type-check and lint both
// before and after the implementation adds them. Each test file documents the expected API.

/** The value of `record[key]`, or undefined when the field does not exist yet. */
export function field(record: object, key: string): unknown {
  const value: unknown = Reflect.get(record, key)
  return value
}

/**
 * The exported function `name` of `mod`, for the caller to cast to its expected signature; throws
 * a clear error while it does not exist.
 */
export function exportedFunction(mod: object, name: string): unknown {
  const value = field(mod, name)
  if (typeof value !== 'function') throw new Error(`expected an exported function ${name}()`)
  return value
}
