export const TEMP_PREFIX: string;
export function listTempTargets(tmp?: string): string[];
export function findLeakedPids(targets: string[], opts?: { commandLine?: (pid: number) => string | undefined }): number[];
export function processCommandLine(pid: number): string | undefined;
export function cleanTargets(targets: string[], opts?: { remove?: boolean }): Promise<{ pids: number[]; dirs: string[] }>;
export function cleanAllTestArtifacts(tmp?: string): Promise<{ pids: number[]; dirs: string[] }>;
