// Prints "<host> <user>" once the devbox job has logged its tunnel, or exits 2 if not yet.
// `eas workflow:logs` returns nothing while a job runs, so this reads the live log file.
import fs from 'node:fs';
import os from 'node:os';

const runId = process.argv[2];
const headers = { 'content-type': 'application/json' };
if (process.env.EXPO_TOKEN) {
  headers.authorization = `Bearer ${process.env.EXPO_TOKEN}`;
} else {
  const state = JSON.parse(fs.readFileSync(`${os.homedir()}/.expo/state.json`, 'utf8'));
  headers['expo-session'] = state.auth.sessionSecret;
}
const query = `query($id: ID!) { workflowRuns { byId(workflowRunId: $id) {
  status jobs { status turtleJobRun { logFileUrls } } } } }`;
const res = await fetch('https://api.expo.dev/graphql', {
  method: 'POST',
  headers,
  body: JSON.stringify({ query, variables: { id: runId } }),
});
const { data, errors } = await res.json();
if (errors) throw new Error(errors.map((e) => e.message).join('\n'));
const run = data.workflowRuns.byId;
if (!['NEW', 'IN_PROGRESS'].includes(run.status)) {
  console.error(`The run ended with status ${run.status}. See: eas workflow:view ${runId}`);
  process.exit(1);
}
for (const url of run.jobs.flatMap((j) => j.turtleJobRun?.logFileUrls ?? [])) {
  const log = await (await fetch(url)).text();
  const host = log.match(/DEVBOX_SSH_HOST=([a-z0-9.-]+)/)?.[1];
  const user = log.match(/DEVBOX_SSH_USER=([A-Za-z0-9_-]+)/)?.[1];
  if (host && user) {
    console.log(host, user);
    process.exit(0);
  }
}
process.exit(2);
