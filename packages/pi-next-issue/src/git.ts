import { must } from './exec.ts';

export async function repoRoot(cwd: string): Promise<string> {
  const top = await must('git', ['rev-parse', '--show-toplevel'], { cwd });
  const list = await must('git', ['worktree', 'list', '--porcelain'], { cwd });
  const [first = '', second = ''] = list.split('\n');
  return first.startsWith('worktree ') && second !== 'bare' ? first.slice('worktree '.length) : top;
}
