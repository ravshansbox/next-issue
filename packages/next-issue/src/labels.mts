import { asError } from './errors.mts';
import { gh, ghJson, ghOnce, type Kind, type Named, names, slug, viewJson } from './gh.mts';
import type { Repo } from './git.mts';

const KNOWN_LABELS = new Map<string, Set<string>>();

async function labelsOf(repo: Repo, kind: Kind, number: number): Promise<string[]> {
  const parsed = await viewJson<{ labels: Named[] }>(repo, kind, number, 'labels');
  return names(parsed.labels);
}

export function labelArgs(add: string, remove: string[], current: string[]): string[] {
  const stale = remove.filter((item) => item !== add && current.includes(item));
  return ['--add-label', add, ...stale.flatMap((name) => ['--remove-label', name])];
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
  const args = [kind, 'edit', String(number), ...labelArgs(add, remove, current)];
  try {
    await gh(repo, args);
  } catch (error) {
    await retryWithLabel(repo, args, add, error);
  }
}

async function retryWithLabel(
  repo: Repo,
  args: string[],
  label: string,
  error: unknown,
): Promise<void> {
  KNOWN_LABELS.delete(slug(repo));
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
  const repoSlug = slug(repo);
  const cached = KNOWN_LABELS.get(repoSlug);
  if (cached !== undefined) {
    return cached;
  }
  const listed = await ghJson<Named[]>(repo, [
    'label',
    'list',
    '--limit',
    '1000',
    '--json',
    'name',
  ]);
  const known = new Set(names(listed));
  KNOWN_LABELS.set(repoSlug, known);
  return known;
}

async function createUnknownLabel(repo: Repo, label: string): Promise<'known' | 'created' | Error> {
  const known = await knownLabels(repo);
  if (known.has(label)) {
    return 'known';
  }
  try {
    await ghOnce(repo, ['label', 'create', label]);
  } catch (error) {
    return asError(error);
  }
  known.add(label);
  return 'created';
}
