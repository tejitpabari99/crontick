import { zodToJsonSchema } from 'zod-to-json-schema';
import { JobSchema } from './schemas/job.js';

export function jobJsonSchema(): unknown {
  return zodToJsonSchema(JobSchema as unknown as Parameters<typeof zodToJsonSchema>[0], {
    name: 'CrontickJob',
  });
}

export function jobJsonSchemaText(): string {
  return `${JSON.stringify(jobJsonSchema(), null, 2)}\n`;
}
