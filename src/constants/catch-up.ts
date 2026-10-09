/** SP10 catch-up: constants shared by the startup scan and its tests. */

/** Env var set on a catch-up run so prompts/scripts can tell why they started. */
export const CATCH_UP_TRIGGER_ENV = 'CRONTICK_TRIGGER';
/** Value of `CRONTICK_TRIGGER` for a catch-up run. */
export const CATCH_UP_TRIGGER_VALUE = 'catch-up';
/** Env var carrying the number of fires missed (lower bound when capped). */
export const CATCH_UP_MISSED_ENV = 'CRONTICK_CATCHUP_MISSED';
/** Prefix of the `error` on runs superseded by a catch-up run. */
export const CATCH_UP_SKIP_PREFIX = 'CATCH_UP: superseded by catch-up run';
