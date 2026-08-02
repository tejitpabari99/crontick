// 04-prompt-job.ts
// Demonstrates: a prompt job with an engine configured.
//
// PREREQUISITE: You must have a prompt engine CLI installed and registered.
// By default, crontick ships with a built-in "copilot" engine definition
// (command: "copilot", args: [], env: {}). You need the `copilot` CLI
// available on your PATH, or register a custom engine first:
//   crontick config engines add my-engine --command "my-cli" --arg "--flag"
//
// Run: npx tsx examples/04-prompt-job.ts

import { createClient } from 'crontick';

const client = createClient();

// Create a prompt job using the default engine, running daily at midnight.
const job = await client.createJob({
  id: 'daily-summary',
  schedule: { kind: 'cron', cron: '0 0 * * *' },
  action: {
    kind: 'prompt',
    prompt: 'Summarize the system status for today.',
    engine: 'copilot',
    reuseSession: false,
  },
});
console.log('Created prompt job:', job.id);
console.log('Action:', JSON.stringify(job.action, null, 2));

// List available engines via the config API.
const engines = client.listEngines();
console.log('Registered engines:', Object.keys(engines));

// Clean up.
await client.deleteJob('daily-summary');
console.log('Deleted job: daily-summary');
