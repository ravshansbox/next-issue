import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ISSUE_SECTIONS } from '../../next-issue/src/issue-format.mts';

const skillFolder = new URL('../skills/create-issue/', import.meta.url);

test('an agent who reads the create-issue template finds the issue sections of next-issue in order', async () => {
  const template = await readFile(new URL('template.md', skillFolder), 'utf8');
  const headings = [...template.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [...ISSUE_SECTIONS]);
});

test('an agent who fills in the create-issue template finds the open questions section empty', async () => {
  const template = await readFile(new URL('template.md', skillFolder), 'utf8');
  assert.match(template, /## Open questions\s*$/);
});

test('a user who installs pi-next-issue gets the create-issue skill', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { files: string[]; pi: { skills: string[] } };
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  assert.ok(manifest.files.includes('skills'));
  assert.match(skill, /^---\nname: create-issue\n/);
  assert.match(skill, /gh issue create .*--body-file .*--label status:todo/);
});

test('an agent who creates an issue in a repository without the status:todo label creates the label first', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.match(skill, /gh label create status:todo[\s\S]*gh issue create/);
});

test('a user who asks pi for a change in a repository with .next-issue/config.json gets the create-issue skill', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  const description = skill.match(/^description: (.+)$/m)?.[1] ?? '';
  assert.match(description, /asks for a change/);
  assert.match(description, /\.next-issue\/config\.json/);
});

test('an agent who creates an issue with the create-issue skill links it to the open issues it depends on', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.match(skill, /gh issue list/);
  assert.match(skill, /gh issue edit <number> --add-blocked-by <blocker>/);
});

test('an agent who finds a change too big for one atomic commit proposes a split of linked issues for the user to confirm', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.match(skill, /one atomic commit that leaves the trunk green/);
  assert.match(skill, /propose a split into issues that each land alone and keep the trunk green/);
  assert.match(skill, /confirm the split/);
  assert.match(skill, /each issue of the split/i);
});

test('a user who reads the pi-next-issue README learns that the create-issue skill splits a change too big for one commit', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /too big for one atomic commit/);
});

test('a user who asks the create-issue skill to change a created issue gets the issue edited on GitHub', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.match(skill, /gh issue edit <number> --body-file <file>/);
  assert.match(skill, /gh issue edit <number> --title "<title>"/);
});
