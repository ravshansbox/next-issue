import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withOpenQuestions } from '../src/shared/issue-format.mts';

test('a user whose Open questions section holds a code block with a # line finds the questions after the block', () => {
  const body = '## Open questions\n\n```sh\n# run it\nmake\n```\n\n## Notes\n\nLater.';
  assert.equal(
    withOpenQuestions(body, ['Q?']),
    '## Open questions\n\n```sh\n# run it\nmake\n```\n\n1. Q?\n\n## Notes\n\nLater.',
  );
});

test('a user whose only Open questions line sits inside a code block finds a new heading at the end', () => {
  const body = '## Problem\n\n```md\n## Open questions\n```\n';
  assert.equal(
    withOpenQuestions(body, ['Q?']),
    '## Problem\n\n```md\n## Open questions\n```\n\n## Open questions\n\n1. Q?',
  );
});

test('a user whose issue has a fenced Open questions line and a real section finds the questions in the real section', () => {
  const body = '```md\n## Open questions\n```\n\n## Open questions\n\n1. Old?';
  assert.equal(
    withOpenQuestions(body, ['Q?']),
    '```md\n## Open questions\n```\n\n## Open questions\n\n1. Old?\n\n1. Q?',
  );
});
