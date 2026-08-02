// 06-run-history.ts
// Demonstrates: triggering a job manually, then reading back its run
// records and captured output.
//
// Run: npx tsx examples/06-run-history.ts

import { createClient } from 'crontick';

const client = createClient();

// Create a simple script job (interval schedule, but we will trigger manually).
await client.createJob({
  id: 'run-history-demo',
  schedule: { kind: 'interval', everySec: 3600 },
  action: { kind: 'script', script: 'echo "run at $(date)"' },
});

// Trigger an immediate run.
const { runId } = await client.runNow('run-history-demo');
console.log('Triggered run:', runId);

// Wait briefly for the run to complete.
await new Promise((resolve) => setTimeout(resolve, 2000));

// Retrieve the run record.
const run = await client.getRun(runId);
console.log('Run record:', JSON.stringify(run, null, 2));

// Retrieve captured logs (last 20 lines).
const logs = await client.getLogs(runId, { lines: 20 });
console.log('Logs:');
for (const line of logs.lines) {
  console.log(`  [${line.stream}] ${line.data}`);
}

// List recent runs for this job.
const runs = await client.listRuns({ jobId: 'run-history-demo', limit: 5 });
console.log('Recent runs:', JSON.stringify(runs, null, 2));

// Clean up.
await client.deleteJob('run-history-demo');
console.log('Deleted job: run-history-demo');
