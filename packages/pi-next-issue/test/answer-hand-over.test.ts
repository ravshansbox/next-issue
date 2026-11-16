import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const skillFile = new URL('../skills/answer-hand-over/SKILL.md', import.meta.url);

test('a user who installs pi-next-issue gets the answer-hand-over skill', async () => {
  const skill = await readFile(skillFile, 'utf8');
  assert.match(skill, /^---\nname: answer-hand-over\ndescription: .+\n---\n/);
});

test('an agent who answers a hand-over lists the waiting issues of <repo> and passes --repo <repo> to every gh command', async () => {
  const skill = await readFile(skillFile, 'utf8');
  assert.match(skill, /gh issue list --repo <repo> --state open --label "<needs-human>"/);
  const commands = [...skill.matchAll(/^\s*gh .*$/gm)].map((match) => match[0]);
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.match(command, /--repo <repo>/);
  }
});

test('an agent who answers a hand-over reads the latest hand-over comment, the branch, the diff and the failed check logs', async () => {
  const skill = await readFile(skillFile, 'utf8');
  assert.match(skill, /`next-issue needs help:`/);
  assert.match(skill, /`question:`/);
  assert.match(skill, /git diff/);
  assert.match(skill, /gh run view --repo <repo> <run> --log-failed/);
});

test('an agent who answers a hand-over asks numbered questions with lettered options and a recommendation', async () => {
  const skill = await readFile(skillFile, 'utf8');
  assert.match(skill, /numbered questions/);
  assert.match(skill, /Label options with letters and recommend one/);
});

test('an agent who retries, guides or gives up changes the labels of the issue on GitHub', async () => {
  const skill = await readFile(skillFile, 'utf8');
  assert.match(skill, /gh issue edit --repo <repo> <number> --remove-label "<needs-human>"\n/);
  assert.match(skill, /gh issue comment --repo <repo> <number> --body-file <file>/);
  assert.match(skill, /`### Review:`/);
  assert.match(skill, /`### Fixer:`/);
  assert.match(skill, /gh label list --repo <repo> --limit 1000 --json name/);
  assert.match(skill, /without case/);
  assert.match(skill, /gh label create --repo <repo> "<skip>"/);
  assert.match(
    skill,
    /gh issue edit --repo <repo> <number> --remove-label "<needs-human>" --add-label "<skip>"/,
  );
  assert.match(skill, /`labels\.needsHuman`[^\n]*`status:needs-human`/);
  assert.match(skill, /`labels\.skip`[^\n]*`status:blocked`/);
});

test('an agent who retries an issue nudges the going run and offers a start only when no run is going', async () => {
  const skill = await readFile(skillFile, 'utf8');
  assert.match(
    skill,
    /call the `next_issue_refresh` tool, with no question first[\s\S]*ask only whether to start a run\. On yes, call the `next_issue_start` tool/,
  );
});

test('a user who reads the pi-next-issue README learns about the answer-hand-over skill', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /`answer-hand-over` skill/);
  assert.match(readme, /\/skill:answer-hand-over/);
});
