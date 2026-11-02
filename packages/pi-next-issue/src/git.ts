import { must } from './exec.ts';

export async function repoRoot(cwd: string): Promise<string> {
  return must('git', ['rev-parse', '--show-toplevel'], { cwd });
}
