import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createPorts } from '../src/ports.ts';

test('the runner deletes the saved state of a saved issue that is closed and keeps the rest', async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-next-issue-ports-'));
  const root = path.join(top, 'work');
  const bin = path.join(top, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/name.git'], { cwd: root });
  fs.mkdirSync(path.join(root, '.worktrees'));
  fs.writeFileSync(path.join(root, '.worktrees', '7.json'), '{"issue":7}\n');
  fs.writeFileSync(path.join(root, '.worktrees', '8.json'), '{"issue":8}\n');
  const entry = (number: number, state: string) =>
    JSON.stringify({
      number,
      title: `issue ${number}`,
      body: null,
      createdAt: '2024-01-01T00:00:00Z',
      labels: [{ name: 'status:in-progress' }],
      state,
    });
  fs.writeFileSync(path.join(bin, '7.json'), entry(7, 'OPEN'));
  fs.writeFileSync(path.join(bin, '8.json'), entry(8, 'CLOSED'));
  const fields = 'number,title,body,labels,createdAt';
  fs.writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$*" in',
      '  "repo view owner/name --json defaultBranchRef --jq .defaultBranchRef.name") echo main ;;',
      '  "issue list "*) echo "[]" ;;',
      `  "issue view 7 --json ${fields},state --repo owner/name") cat "${path.join(bin, '7.json')}" ;;`,
      `  "issue view 8 --json ${fields},state --repo owner/name") cat "${path.join(bin, '8.json')}" ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const original = process.env['PATH'];
  process.env['PATH'] = `${bin}${path.delimiter}${original}`;
  try {
    const ports = await createPorts(root, await loadConfig(root));
    await ports.openIssues();
    assert.deepEqual(fs.readdirSync(path.join(root, '.worktrees')).sort(), ['7.json']);
  } finally {
    process.env['PATH'] = original;
    fs.rmSync(top, { recursive: true, force: true });
  }
});
