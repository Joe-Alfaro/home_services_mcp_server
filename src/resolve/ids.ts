import { createHash } from 'node:crypto'
import type { SourceRef } from '../adapters/types.ts'

/**
 * A stable, opaque id. Hashing keeps addresses and account names out of ids that tools may
 * show, and the same input always gives the same id across ingest runs.
 */
export function stableId(prefix: string, key: string): string {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
}

/** "sourceSystem:sourceAccount:sourceRecordId": unique per source record. */
export function refKey(ref: SourceRef): string {
  return `${ref.sourceSystem}:${ref.sourceAccount}:${ref.sourceRecordId}`
}

/** Deterministic order for candidates so results don't depend on input order. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}

/** Disjoint sets over 0..n-1, used to build transitive clusters. */
export class UnionFind {
  private readonly parent: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i)
  }

  find(i: number): number {
    const parent = this.parent[i] ?? i
    if (parent === i) return i
    const root = this.find(parent)
    this.parent[i] = root
    return root
  }

  /** Joins the sets of a and b; returns false when they were already one set. */
  union(a: number, b: number): boolean {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return false
    // The smaller index stays the root, so clusters are rooted at their first member.
    this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
    return true
  }
}
