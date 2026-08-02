// 02-cron-schedule.ts
// Demonstrates: a cron-scheduled job with timezone handling and previewing
// the next run times.
//
// Run: npx tsx examples/02-cron-schedule.ts

import { createClient } from 'crontick';

const client = createClient();

// Create a job that runs at 09:00 every weekday in US/Eastern.
const job = await client.createJob({
  id: 'weekday-greeting',
  schedule: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'America/New_York' },
  action: { kind: 'script', script: 'echo "Good morning!"' },
});
console.log('Created cron job:', job.id);
console.log('Schedule:', JSON.stringify(job.schedule, null, 2));

// Preview the next 5 scheduled run times.
const preview = await client.previewSchedule({
  schedule: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'America/New_York' },
  n: 5,
  tz: 'America/New_York',
});
console.log('Next 5 runs:', JSON.stringify(preview, null, 2));

// Validate a schedule expression without creating a job.
const validation = await client.validateSchedule({
  kind: 'cron',
  cron: '0 9 * * 1-5',
  tz: 'America/New_York',
});
console.log('Validation result:', JSON.stringify(validation, null, 2));

// Clean up.
await client.deleteJob('weekday-greeting');
console.log('Deleted job: weekday-greeting');
