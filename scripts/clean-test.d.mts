export const TEMP_PREFIX: string;
export function listTempTargets(tmp?: string): string[];
export function findLeakedPids(targets: string[]): number[];
export function cleanTargets(targets: string[], opts?: { remove?: boolean }): Promise<{ pids: number[]; dirs: string[] }>;
export function cleanAllTestArtifacts(tmp?: string): Promise<{ pids: number[]; dirs: string[] }>;
