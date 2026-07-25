// 07-lifecycle.ts
// Demonstrates: enable/disable/update/remove a job, plus daemon
// start/status/stop via the public CrontickClient API.
//
// Run: npx tsx examples/07-lifecycle.ts

import { createClient } from 'crontick';

const client = createClient();

// --- Job lifecycle ---

// Create a job.
await client.createJob({
  id: 'lifecycle-demo',
  schedule: { kind: 'interval', everySec: 120 },
  action: { kind: 'script', script: 'echo "tick"' },
});
console.log('Created job: lifecycle-demo');

// Disable it (pauses scheduling without deleting).
const disabled = await client.disableJob('lifecycle-demo');
console.log('Disabled:', disabled.enabled); // false

// Re-enable it.
const enabled = await client.enableJob('lifecycle-demo');
console.log('Enabled:', enabled.enabled); // true

// Update: change schedule and add a description.
const updated = await client.updateJob('lifecycle-demo', {
  schedule: { kind: 'interval', everySec: 300 },
  description: 'Updated to 5-minute interval',
});
console.log('Updated schedule:', JSON.stringify(updated.schedule));

// Remove the job entirely.
await client.deleteJob('lifecycle-demo');
console.log('Deleted job: lifecycle-demo');

// --- Daemon lifecycle ---

// Check daemon status (does not start it).
try {
  const status = await client.daemonStatus();
  console.log('Daemon status:', JSON.stringify(status, null, 2));
} catch (err) {
  console.log('Daemon not running (expected if first launch).');
}

// Start the daemon (demand-start, returns when healthy).
const startResult = await client.daemonStart();
console.log('Daemon started, baseUrl:', startResult.baseUrl);

// Stop the daemon.
const stopResult = await client.daemonStop();
console.log('Daemon stopped:', stopResult.stopped);
