// 03-exec-job.ts
// Demonstrates: an exec job that invokes a binary directly (no shell).
// The exec action spawns the command without shell interpretation,
// which is safer for untrusted arguments.
//
// Run: npx tsx examples/03-exec-job.ts

import { createClient } from 'crontick';

const client = createClient();

// Create an exec job that runs `node -e "console.log(...)"` every 30 seconds.
const job = await client.createJob({
  id: 'exec-demo',
  schedule: { kind: 'interval', everySec: 30 },
  action: {
    kind: 'exec',
    command: 'node',
    args: ['-e', 'console.log("exec job ran at", new Date().toISOString())'],
  },
});
console.log('Created exec job:', job.id);
console.log('Action:', JSON.stringify(job.action, null, 2));

// Clean up.
await client.deleteJob('exec-demo');
console.log('Deleted job: exec-demo');
