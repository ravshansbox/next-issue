import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ISSUE_SECTIONS } from '../../next-issue/src/issue-format.mts';
import { TOOL_PREFIX, TOOLS } from '../src/tool-specs.ts';

const skills = new URL('../skills/', import.meta.url);

test('an agent who reads the create-issue template finds the issue sections of next-issue in order', async () => {
  const template = await readFile(new URL('create-issue/template.md', skills), 'utf8');
  const headings = [...template.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [...ISSUE_SECTIONS]);
  assert.match(template, /## Open questions\s*$/);
});

test('a person who installs the plugin gets the create-issue and answer-hand-over skills', async () => {
  for (const name of ['create-issue', 'answer-hand-over']) {
    const skill = await readFile(new URL(`${name}/SKILL.md`, skills), 'utf8');
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`));
  }
});

test('an agent who follows a skill calls only tools that the plugin registers', async () => {
  const names = new Set(TOOLS.map((tool) => `${TOOL_PREFIX}${tool.name}`));
  for (const name of ['create-issue', 'answer-hand-over']) {
    const skill = await readFile(new URL(`${name}/SKILL.md`, skills), 'utf8');
    const called = [...skill.matchAll(/`(mcp__[\w-]+)` tool/g)].map((match) => match[1]!);
    assert.ok(called.length > 0, name);
    for (const tool of called) {
      assert.ok(names.has(tool), `${name} calls ${tool}`);
    }
  }
});
