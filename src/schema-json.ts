import { zodToJsonSchema } from 'zod-to-json-schema';
import { JobSchema } from './schemas/job.js';
import { ConfigSchema } from './schemas/config.js';

export function jobJsonSchema(): unknown {
  return zodToJsonSchema(JobSchema as unknown as Parameters<typeof zodToJsonSchema>[0], {
    name: 'CrontickJob',
  });
}

export function jobJsonSchemaText(): string {
  return `${JSON.stringify(jobJsonSchema(), null, 2)}\n`;
}

export function configJsonSchema(): unknown {
  return zodToJsonSchema(ConfigSchema as unknown as Parameters<typeof zodToJsonSchema>[0], {
    name: 'CrontickConfig',
  });
}

export function configJsonSchemaText(): string {
  return `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
}
