// Version constant injected at build time by tsup/esbuild (define: __CRONTICK_VERSION__)
// and at test time by vitest (define in vitest.config.ts).
declare const __CRONTICK_VERSION__: string;
export const VERSION: string = __CRONTICK_VERSION__;
