/**
 * Pure job-reference resolution: a user-supplied ref is either the immutable
 * GUID `id` or the human-friendly `alias`. `id` wins on collision.
 */
export interface JobRefLookup<T> {
  byId(ref: string): T | undefined;
  byAlias(ref: string): T | undefined;
}

/** Resolves `ref` by id first, then by alias, via the injected lookup. */
export function resolveJobRef<T>(ref: string, lookup: JobRefLookup<T>): T | undefined {
  return lookup.byId(ref) ?? lookup.byAlias(ref);
}

/** Aliases that cannot be used because they are keywords (e.g. `jobs delete all`). */
export const RESERVED_JOB_REFS = ['all'] as const;

export function isReservedJobRef(ref: string): boolean {
  return (RESERVED_JOB_REFS as readonly string[]).includes(ref);
}
