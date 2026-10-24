// Prints one step's output from a devbox run's live log: node scripts/devbox-steplog.mjs <run-id> [step-id]
import fs from 'node:fs';
import os from 'node:os';

const [runId, stepId] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(`${os.homedir()}/.expo/state.json`, 'utf8'));
const res = await fetch('https://api.expo.dev/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'expo-session': state.auth.sessionSecret },
  body: JSON.stringify({
    query: 'query($id: ID!) { workflowRuns { byId(workflowRunId: $id) { jobs { turtleJobRun { logFileUrls errors { message } } } } } }',
    variables: { id: runId },
  }),
});
const { data } = await res.json();
for (const job of data.workflowRuns.byId.jobs) {
  for (const e of job.turtleJobRun?.errors ?? []) console.log('JOB ERROR:', e.message);
  for (const url of job.turtleJobRun?.logFileUrls ?? []) {
    for (const line of (await (await fetch(url)).text()).split('\n')) {
      try {
        const j = JSON.parse(line);
        if (!stepId || j.buildStepId === stepId) console.log(`[${j.buildStepId ?? j.phase}] ${j.msg}`);
      } catch {}
    }
  }
}
