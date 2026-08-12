#!/usr/bin/env node

/**
 * Data retention job — NOT YET IMPLEMENTED.
 *
 * Intended to enforce the retention policy in docs/PRIVACY.md:
 *   request logs        7 days
 *   search queries     30 days
 *   settlement records 90 days
 *
 * There is no datastore to purge from yet, so this deletes nothing. It exits
 * non-zero so that scheduling it is impossible to mistake for enforcing the
 * policy: a stub that prints "[OK] Purged ..." and returns success is worse
 * than no job at all, because it makes an unenforced policy look enforced.
 *
 * See the tracking issue for what has to land before this can do its job.
 */

const RETENTION_DAYS = {
  'request logs': 7,
  'search queries': 30,
  'settlement records': 90,
};

console.error('data-retention: NOT IMPLEMENTED — nothing was purged.\n');
console.error('The policy this job is supposed to enforce:');
for (const [what, days] of Object.entries(RETENTION_DAYS)) {
  console.error(`  ${what.padEnd(20)} ${days} days`);
}
console.error(
  '\nBlocked on a datastore: the service holds no persistent records to purge.\n' +
    'Until then docs/PRIVACY.md must not claim these periods are enforced.',
);

process.exit(1);
