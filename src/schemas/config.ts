import { z } from 'zod';

export const ConfigKeySchema = z.string().regex(
  /^[A-Za-z0-9_.-]+$/,
  'Config key paths can contain letters, numbers, underscore, dash, and dot',
);

export const EngineNameSchema = z.string().regex(
  /^[A-Za-z0-9_.-]+$/,
  'Engine names can contain letters, numbers, underscore, dash, and dot',
);

export const EngineConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
}).strict();

export const ConfigSchema = z.object({
  defaultEngine: EngineNameSchema.default('copilot'),
  engines: z.record(EngineNameSchema, EngineConfigSchema).default({
    copilot: { command: 'copilot', args: [], env: {} },
  }),
}).strict().superRefine((config, ctx) => {
  if (Object.keys(config.engines).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['engines'],
      message: 'engines must contain at least one engine',
    });
  }
  if (!Object.prototype.hasOwnProperty.call(config.engines, config.defaultEngine)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultEngine'],
      message: `defaultEngine "${config.defaultEngine}" must match a key in engines`,
    });
  }
});

export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type CrontickConfig = z.infer<typeof ConfigSchema>;

