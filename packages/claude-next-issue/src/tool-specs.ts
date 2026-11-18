import { STOP_POINTS } from './protocol.ts';

export const TOOLS = [
  {
    name: 'next_issue_start',
    description:
      'Start a next-issue run of the GitHub issues of this repository when none is going: it watches for new issues after each pass and does not hunt (next_issue_watch and next_issue_hunt switch them). Starts the worker when needed. When a run is going, starts nothing, asks that run to check for new issues now (unless it is stopping or does not watch) and reports that run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'next_issue_refresh',
    description:
      'Ask the going next-issue run of this repository to check for new issues now (call it after filing an issue). Never starts a worker or a run: when no run is going, it says so.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'next_issue_watch',
    description:
      'Switch watching for new issues on or off for the going next-issue run of this repository, with no restart: the run keeps its issues. On keeps the run going after the current pass, and it reads the open issues again after each pass. Off ends the run after the current pass, and turns hunting off too. Fails when no run is going.',
    inputSchema: {
      type: 'object',
      properties: {
        on: { type: 'boolean', description: 'true to keep watching, false to end after this pass' },
      },
      required: ['on'],
    },
  },
  {
    name: 'next_issue_hunt',
    description:
      'Switch hunting for bugs on or off for the going next-issue run of this repository, with no restart: the run keeps its issues. On also turns watching on. Off lets a hunt that is going finish and starts no new one. Fails when no run is going.',
    inputSchema: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true to hunt, false to stop hunting' } },
      required: ['on'],
    },
  },
  {
    name: 'next_issue_stop',
    description:
      'Ask the going next-issue run of this repository to stop: after the running issues (issue, the default), after the current round (round), or at once (now). Returns at once, without waiting for the run to end. Fails when no run is going.',
    inputSchema: {
      type: 'object',
      properties: {
        after: {
          type: 'string',
          enum: [...STOP_POINTS],
          description: 'When to stop: issue (the default), round or now',
        },
      },
    },
  },
  {
    name: 'next_issue_status',
    description:
      'Report the next-issue run of this repository: its status line, then each handled issue with its outcome. Never starts a worker.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

export const TOOL_PREFIX = 'mcp__next-issue__';
