import { asError } from './errors.mts';
import { gh, ghApi, ghOnce, type Kind, type Named, names, repoArg, viewJson } from './gh.mts';
import type { Repo } from './git.mts';
import { lines } from './text.mts';

const KNOWN_LABELS = new Map<string, Set<string>>();

async function labelsOf(repo: Repo, kind: Kind, number: number): Promise<string[]> {
  const parsed = await viewJson<{ labels: Named[] }>(repo, kind, number, 'labels');
  return names(parsed.labels);
}

export function staleLabels(add: string, remove: string[], current: string[]): string[] {
  return current.filter(
    (label) => hasLabel(remove, label) && label.toLowerCase() !== add.toLowerCase(),
  );
}

export function hasLabel(labels: string[], name: string): boolean {
  return labels.some((label) => label.toLowerCase() === name.toLowerCase());
}

export async function setLabel(
  repo: Repo,
  kind: Kind,
  number: number,
  add: string,
  remove: string[],
): Promise<void> {
  await createUnknownLabel(repo, add);
  const current = await labelsOf(repo, kind, number);
  const edit = [kind, 'edit', String(number)];
  const args = [...edit, '--add-label', add];
  try {
    await gh(repo, args);
  } catch (error) {
    await retryWithLabel(repo, args, add, error);
  }
  const stale = staleLabels(add, remove, current);
  if (stale.length > 0) {
    await gh(repo, [...edit, ...stale.flatMap((name) => ['--remove-label', name])]);
  }
}

export async function ensureLabel(repo: Repo, label: string): Promise<void> {
  KNOWN_LABELS.delete(repoArg(repo));
  const created = await createUnknownLabel(repo, label);
  if (created instanceof Error) {
    KNOWN_LABELS.delete(repoArg(repo));
    if (!(await knownLabels(repo)).has(label.toLowerCase())) {
      throw created;
    }
  }
}

async function retryWithLabel(
  repo: Repo,
  args: string[],
  label: string,
  error: unknown,
): Promise<void> {
  KNOWN_LABELS.delete(repoArg(repo));
  const created = await createUnknownLabel(repo, label);
  if (created === 'known') {
    throw error;
  }
  if (created instanceof Error) {
    throw created;
  }
  await gh(repo, args);
}

async function knownLabels(repo: Repo): Promise<Set<string>> {
  const repoSlug = repoArg(repo);
  const cached = KNOWN_LABELS.get(repoSlug);
  if (cached !== undefined) {
    return cached;
  }
  const listed = await ghApi(repo, 'labels?per_page=100', '.[].name', { paginate: true });
  const known = new Set(lines(listed).map((name) => name.toLowerCase()));
  KNOWN_LABELS.set(repoSlug, known);
  return known;
}

async function createUnknownLabel(repo: Repo, label: string): Promise<'known' | 'created' | Error> {
  const known = await knownLabels(repo);
  if (known.has(label.toLowerCase())) {
    return 'known';
  }
  try {
    await ghOnce(repo, ['label', 'create', label]);
  } catch (error) {
    return asError(error);
  }
  known.add(label.toLowerCase());
  return 'created';
}
