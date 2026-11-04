import { join, sep } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentRequest } from './agents.mts';
import type { Recorder } from './observe.mts';

export function isOwnResource(path: string): boolean {
  return path.split(sep).includes('pi-next-issue');
}

export async function openSession(
  recorder: Recorder,
  log: Recorder,
  request: AgentRequest,
  agentDir: string,
) {
  const runtime = request.runtime ?? {};
  const resourceLoader = await loadResources(request.cwd, agentDir);
  const modelRuntime =
    runtime.modelRuntime ??
    (await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
    }));
  const model =
    request.model === undefined ? undefined : await findModel(modelRuntime, request.model);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: request.cwd,
    agentDir,
    resourceLoader,
    sessionManager: SessionManager.create(request.cwd, recorder.sessionDir),
    tools: request.profile.tools,
    modelRuntime,
    ...(runtime.settingsManager === undefined ? {} : { settingsManager: runtime.settingsManager }),
    ...(model === undefined ? {} : { model }),
  });
  if (modelFallbackMessage !== undefined) {
    log.event('agent.model', { note: modelFallbackMessage }, 'quiet');
  }
  return session;
}

async function loadResources(cwd: string, agentDir: string): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((extension) => !isOwnResource(extension.resolvedPath)),
    }),
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => !isOwnResource(skill.filePath)),
    }),
  });
  await resourceLoader.reload();
  return resourceLoader;
}

async function findModel(modelRuntime: ModelRuntime, name: string) {
  const slash = name.indexOf('/');
  if (slash <= 0) {
    throw new Error(`The model ${name} is not in the form provider/model.`);
  }
  const found = modelRuntime.getModel(name.slice(0, slash), name.slice(slash + 1));
  if (found === undefined) {
    throw new Error(`The model ${name} is not known to pi.`);
  }
  return found;
}
