#!/usr/bin/env node
// Durchstich: Jira-Zugang prüfen und eine Test Execution / einen Test Plan über die Xray Cloud API lesen.
// Nur lesend. Aufruf: node --env-file=.env scripts/durchstich.mjs TGTM2-6
// Die Rohdaten landen in out/<KEY>.json (out/ ist in .gitignore).

import { mkdir, writeFile } from 'node:fs/promises';

// Regionaler Endpunkt, z.B. https://eu.xray.cloud.getxray.app (sonst "Xray data is in another region").
const XRAY = (process.env.XRAY_BASE_URL || 'https://xray.cloud.getxray.app').replace(/\/$/, '') + '/api/v2';
const env = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Umgebungsvariable ${name} fehlt (siehe .env.example).`);
    process.exit(1);
  }
  return v;
};

const key = process.argv[2];
if (!key) {
  console.error('Aufruf: node --env-file=.env scripts/durchstich.mjs <ISSUE-KEY>');
  process.exit(1);
}

const jiraBase = env('JIRA_BASE_URL').replace(/\/$/, '');
const jiraAuth = 'Basic ' + Buffer.from(`${env('JIRA_EMAIL')}:${env('JIRA_API_TOKEN')}`).toString('base64');

async function jira(path) {
  const res = await fetch(jiraBase + path, { headers: { Authorization: jiraAuth, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jira ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function xrayToken() {
  const res = await fetch(`${XRAY}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env('XRAY_CLIENT_ID'), client_secret: env('XRAY_CLIENT_SECRET') }),
  });
  if (!res.ok) throw new Error(`Xray authenticate: HTTP ${res.status} ${await res.text()}`);
  return res.json(); // liefert das Token als JSON-String
}

async function xray(token, query) {
  const res = await fetch(`${XRAY}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`Xray GraphQL: HTTP ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  return body.data;
}

const RUN_FIELDS = `
  testRuns(limit: 100) {
    total
    results {
      id
      status { name }
      test { issueId jira(fields: ["key", "summary"]) steps { id callTestIssueId } }
      steps { id action data result status { name } attachments { id filename } }
    }
  }`;

const short = (s, n = 80) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// 1. Jira: Token prüfen
const me = await jira('/rest/api/3/myself');
console.log(`✔ Jira: angemeldet als ${me.displayName}`);

// 2. Jira: Vorgang lesen (prüft zugleich, ob der Nutzer ihn sehen darf)
const issue = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,issuetype,status`);
const type = issue.fields.issuetype.name;
console.log(`✔ Jira: ${issue.key} (ID ${issue.id}) · Typ "${type}" · Status "${issue.fields.status.name}" · ${issue.fields.summary}`);

// 3. Xray: anmelden
const token = await xrayToken();
console.log('✔ Xray: Zugriffstoken erhalten');

// 4. Xray: Daten lesen – je nach Vorgangstyp
const jql = `key = ${issue.key}`;
let data;
if (/plan/i.test(type)) {
  data = await xray(token, `{
    getTestPlans(jql: "${jql}", limit: 1) {
      results {
        issueId
        jira(fields: ["key", "summary"])
        tests(limit: 100) { total results { issueId jira(fields: ["key", "summary"]) } }
        testExecutions(limit: 100) { total results { issueId jira(fields: ["key", "summary", "status"]) } }
      }
    }
  }`);
  const plan = data.getTestPlans.results[0];
  if (!plan) throw new Error('Xray kennt diesen Vorgang nicht als Test Plan.');
  console.log(`\nTest Plan: ${plan.tests.total} Tests, ${plan.testExecutions.total} Test Executions`);
  for (const te of plan.testExecutions.results) console.log(`  ${te.jira.key}  ${short(te.jira.summary)}`);
} else {
  data = await xray(token, `{
    getTestExecutions(jql: "${jql}", limit: 1) {
      results { issueId jira(fields: ["key", "summary"]) ${RUN_FIELDS} }
    }
  }`);
  const te = data.getTestExecutions.results[0];
  if (!te) throw new Error('Xray kennt diesen Vorgang nicht als Test Execution.');
  console.log(`\nTest Execution: ${te.testRuns.total} Test Runs`);
  // Aufgerufene Tests ("Call Test"-Schritte): Xray löst sie im Test Run bereits in deren Schritte auf.
  // Die Run-Schritt-ID ist dann "<ID des Aufrufschritts>_<ID des Originalschritts>".
  const calledKeys = new Map(); // issueId -> "KEY Summary"
  for (const run of te.testRuns.results)
    for (const s of run.test.steps ?? [])
      if (s.callTestIssueId && !calledKeys.has(s.callTestIssueId)) {
        const called = await jira(`/rest/api/3/issue/${s.callTestIssueId}?fields=summary`);
        calledKeys.set(s.callTestIssueId, `${called.key} ${short(called.fields.summary, 60)}`);
      }

  for (const run of te.testRuns.results) {
    const callOf = new Map((run.test.steps ?? []).filter((s) => s.callTestIssueId).map((s) => [s.id, s.callTestIssueId]));
    console.log(`\n  ${run.test.jira.key}  [${run.status.name}]  ${short(run.test.jira.summary)}`);
    console.log(`    Schritte: ${run.steps?.length ?? 0}`);
    (run.steps ?? []).forEach((s, i) => {
      const calledId = callOf.get(s.id.split('_')[0]);
      const via = s.id.includes('_') && calledId ? `  (aufgerufen aus ${calledKeys.get(calledId)})` : '';
      console.log(`    Schritt ${i + 1} [${s.status?.name}]${via}`);
      console.log(`      Action: ${short(s.action)}`);
      console.log(`      Data:   ${short(s.data)}`);
      console.log(`      Result: ${short(s.result)}`);
      if (s.attachments?.length) console.log(`      Anhänge: ${s.attachments.map((a) => a.filename).join(', ')}`);
    });
  }
}

await mkdir('out', { recursive: true });
await writeFile(`out/${issue.key}.json`, JSON.stringify({ issue, xray: data }, null, 2));
console.log(`\nRohdaten gespeichert: out/${issue.key}.json`);
