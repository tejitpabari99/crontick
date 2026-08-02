// 01-quick-start.ts
// Demonstrates: creating a client, adding a script job on an interval,
// listing jobs, and cleaning up.
//
// Run: npx tsx examples/01-quick-start.ts

import { createClient } from 'crontick';

const client = createClient();

// Create a job that runs every 60 seconds.
const job = await client.createJob({
  id: 'hello-interval',
  schedule: { kind: 'interval', everySec: 60 },
  action: { kind: 'script', script: 'echo "hello from crontick"' },
});
console.log('Created job:', job.id);

// List all registered jobs.
const jobs = await client.listJobs();
console.log('Total jobs:', jobs.length);
for (const j of jobs) {
  console.log(`  - ${j.id} (enabled=${j.enabled})`);
}

// Clean up: delete the job we just created.
await client.deleteJob('hello-interval');
console.log('Deleted job: hello-interval');
