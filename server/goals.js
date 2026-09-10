import { messages } from '../public/locales.js';

const fail = (key, status = 400) => Object.assign(new Error(messages.en[key] || key), { errorKey: key, status });
const statuses = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const fingerprint = goal => goal ? JSON.stringify([goal.objective, goal.status, goal.tokenBudget, goal.createdAt]) : null;
// No arbitrary RPC or session configuration can pass through this endpoint.
export function createGoals(codex) {
  const pending = new Set();
  async function read(threadId) {
    const { goal } = await codex.rpc('thread/goal/get', { threadId });
    if (goal === null) return { goal: null, version: null };
    if (!goal || goal.threadId !== threadId || typeof goal.objective !== 'string' || !statuses.has(goal.status)) throw fail('goals.invalidResponse', 502);
    const safe = Object.fromEntries(['threadId', 'objective', 'status', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt'].map(key => [key, goal[key]]));
    return { goal: safe, version: fingerprint(safe) };
  }
  async function change(threadId, input) {
    if (!['create', 'update', 'status', 'clear'].includes(input.action) || !Object.hasOwn(input, 'version') || !(input.version === null || typeof input.version === 'string' && input.version.length <= 10000)) throw fail('goals.invalid');
    const params = { threadId };
    if (['create', 'update'].includes(input.action)) {
      if (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.objective)) throw fail('goals.objectiveInvalid');
      if (input.tokenBudget !== null && !(Number.isSafeInteger(input.tokenBudget) && input.tokenBudget > 0)) throw fail('goals.budgetInvalid');
      params.objective = input.objective.trim(); params.tokenBudget = input.tokenBudget;
    }
    if (input.action === 'status') {
      if (!['active', 'paused', 'blocked', 'complete'].includes(input.status)) throw fail('goals.invalid');
      params.status = input.status;
    }
    if (pending.has(threadId)) throw fail('goals.busy', 409);
    pending.add(threadId);
    try {
      const current = await read(threadId);
      if (input.version !== current.version || (input.action === 'create' ? current.goal !== null : current.goal === null)) throw fail('goals.conflict', 409);
      if (input.action === 'clear') await codex.rpc('thread/goal/clear', { threadId });
      else {
        if (input.action === 'create') params.status = 'active';
        // Omitting the unchanged objective also preserves usage on terminal goals.
        if (input.action === 'update' && params.objective === current.goal.objective) delete params.objective;
        await codex.rpc('thread/goal/set', params);
      }
      return await read(threadId);
    } finally { pending.delete(threadId); }
  }
  return { read, change };
}
