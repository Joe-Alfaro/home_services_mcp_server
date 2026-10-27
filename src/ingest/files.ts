import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { SourceAdapter, SourceFile } from '../adapters/types.ts'

/** Every file under `<dataPackDir>/sources`, as "/"-separated paths relative to dataPackDir. */
export function listSourcePaths(dataPackDir: string): string[] {
  const root = path.join(dataPackDir, 'sources')
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory()
        ? walk(full)
        : [path.relative(dataPackDir, full).split(path.sep).join('/')]
    })
  }
  return walk(root).sort()
}

/** Matches a glob where "*" stands for any run of characters within one path segment. */
export function matchesPattern(pattern: string, filePath: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${source}$`).test(filePath)
}

export function claimedBy(adapter: SourceAdapter, paths: readonly string[]): string[] {
  return paths.filter((filePath) =>
    adapter.patterns.some((pattern) => matchesPattern(pattern, filePath)),
  )
}

export function readSourceFiles(dataPackDir: string, paths: readonly string[]): SourceFile[] {
  return paths.map((filePath) => ({
    path: filePath,
    content: readFileSync(path.join(dataPackDir, ...filePath.split('/')), 'utf8'),
  }))
}
