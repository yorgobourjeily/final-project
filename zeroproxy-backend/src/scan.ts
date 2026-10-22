// Pretend to be the camera machine: npm run scan -- 2 08:05
// Sends exactly what the real machine will send when it recognises a face: { id, time }.
// Without a time, the current time is used.
import { config } from './config';
import { clock } from './utils';

(async () => {
  const [id, time = clock()] = process.argv.slice(2);
  if (!id) {
    console.log('Usage: npm run scan -- <id> [HH:mm]    e.g.  npm run scan -- 2 08:05');
    process.exit(1);
  }
  const body = { id, time };

  const res = await fetch(`http://localhost:${config.port}/api/scans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': config.deviceKey },
    body: JSON.stringify(body),
  });

  console.log('Sent:   ', JSON.stringify(body));
  console.log(`Reply (${res.status}):`, JSON.stringify(await res.json(), null, 2));
})().catch((err) => {
  console.error('Could not reach the API. Is zeroproxy-backend running?', err.message ?? err);
  process.exit(1);
});
