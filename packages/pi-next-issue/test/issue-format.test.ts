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
  assert.match(skill, /gh issue create --repo <repo> .*--body-file .*--label "<ready>"/);
});

test('an agent who creates an issue reads the ready label from labels.ready in .next-issue/config.json', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.match(skill, /`labels\.ready` in `\.next-issue\/config\.json`/);
  assert.doesNotMatch(skill, /--label status:todo|gh label (list|create)[^\n]*status:todo/);
});

test('an agent who finds no labels.ready, or no config file, uses status:todo as the ready label', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.match(
    skill,
    /When `labels\.ready` is not set, or there is no config file, `<ready>` is `status:todo`/,
  );
});

test('an agent who finds labels.ready empty creates the issue with no label', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.match(skill, /When `labels\.ready` is empty \(`""`\), add no label/);
  assert.match(skill, /gh issue create --repo <repo> --title "<title>" --body-file <file>\n/);
});

test('an agent who creates an issue in a repository without the ready label creates the label first', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  assert.match(skill, /gh label create --repo <repo> "<ready>"[\s\S]*gh issue create/);
});

test('an agent who creates an issue with the create-issue skill adds no label other than the ready label', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(skill, /Add no label other than `<ready>`/);
  assert.match(readme, /and no other label/);
});

test('a user who reads the pi-next-issue README learns that the create-issue skill adds the labels.ready label', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /`labels\.ready` label of `\.next-issue\/config\.json`/);
  assert.match(readme, /`status:todo` when `labels\.ready` is not set/);
  assert.match(readme, /empty `labels\.ready`/);
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
  assert.match(skill, /gh issue edit --repo <repo> <number> --add-blocked-by <blocker>/);
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
  assert.match(skill, /gh issue edit --repo <repo> <number> --body-file <file>/);
  assert.match(skill, /gh issue edit --repo <repo> <number> --title "<title>"/);
});

test('an agent who runs a gh command of the create-issue skill names the repository of the configured remote', async () => {
  const skill = await readFile(new URL('SKILL.md', skillFolder), 'utf8');
  const commands = [...skill.matchAll(/`(gh [^`]+)`|^ *(gh .+)$/gm)].map(
    (match) => match[1] ?? match[2] ?? '',
  );
  assert.ok(commands.length >= 7);
  for (const command of commands) assert.match(command, /--repo <repo>/, command);
  assert.match(skill, /`remote` in `\.next-issue\/config\.json`/);
  assert.match(skill, /git remote get-url <remote>/);
  assert.match(skill, /there is no config file or no `remote` field, `<remote>` is `origin`/);
});

test('a user who reads the pi-next-issue README learns which repository the create-issue skill files in', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /repository of the `remote` of `\.next-issue\/config\.json`/);
});
