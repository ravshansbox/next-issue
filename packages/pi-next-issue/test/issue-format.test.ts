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
