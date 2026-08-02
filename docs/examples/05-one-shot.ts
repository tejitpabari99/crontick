// 05-one-shot.ts
// Demonstrates: a one-shot job that runs once at a specific time.
// One-shot jobs are useful for deferred/scheduled-once tasks.
//
// Run: npx tsx examples/05-one-shot.ts

import { createClient } from 'crontick';

const client = createClient();

// Schedule a one-shot job 10 seconds from now.
const runAt = new Date(Date.now() + 10_000).toISOString();

const job = await client.createJob({
  id: 'one-shot-demo',
  schedule: { kind: 'one-shot', runAt },
  action: { kind: 'script', script: 'echo "one-shot fired!"' },
});
console.log('Created one-shot job:', job.id);
console.log('Scheduled to run at:', runAt);

// Clean up immediately (the job would auto-fire at runAt if left).
await client.deleteJob('one-shot-demo');
console.log('Deleted job: one-shot-demo');
