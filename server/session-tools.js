import { skillMentions } from '../public/input.js';

const invalid = (errorKey, status = 400) => Object.assign(new Error(errorKey), { errorKey, status });
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const breakdown = value => Object.fromEntries(['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'].map(key => [key, number(value?.[key])]));

export function createSessionTools(codex) {
  const usage = new Map(), compacting = new Set();
  function stale(threadId, reason) { const current = usage.get(threadId); if (current) current.stale = reason; }
  function event(message) {
    const p = message.params || {}, id = p.threadId;
    if (message.method === 'thread/tokenUsage/updated' && id && p.tokenUsage) {
      usage.delete(id);
      usage.set(id, { total: breakdown(p.tokenUsage.total), last: breakdown(p.tokenUsage.last), modelContextWindow: number(p.tokenUsage.modelContextWindow), updatedAt: Date.now(), turnId: p.turnId, stale: compacting.has(id) ? 'compaction' : null });
      if (usage.size > 500) usage.delete(usage.keys().next().value);
    }
    if (message.method === 'item/started' && p.item?.type === 'contextCompaction') { compacting.add(id); stale(id, 'compaction'); }
    if (message.method === 'item/completed' && p.item?.type === 'contextCompaction') { compacting.delete(id); stale(id, 'compaction'); }
    if (message.method === 'turn/completed') compacting.delete(id);
    if (message.method === 'thread/closed') { compacting.delete(id); stale(id, 'disconnected'); }
    if (message.method === 'thread/deleted') { compacting.delete(id); usage.delete(id); }
    if (message.method === 'thread/settings/updated') stale(id, 'settings');
  }
  function connection(status) {
    if (status.state !== 'connected') { for (const id of usage.keys()) stale(id, 'disconnected'); compacting.clear(); }
  }
  async function thread(id) {
    const { thread } = await codex.rpc('thread/read', { threadId: id, includeTurns: false });
    if (!thread) throw invalid('error.sessionId', 404);
    return thread;
  }
  async function skills(id, forceReload = false) {
    const current = await thread(id);
    const result = await codex.rpc('skills/list', { cwds: [current.cwd], forceReload });
    const entries = result.data.filter(entry => entry.cwd === current.cwd);
    // Expose metadata only, never skill bodies, dependency configuration, or filesystem errors.
    return { skills: entries.flatMap(entry => entry.skills).filter(skill => skill.enabled && typeof skill.name === 'string' && typeof skill.path === 'string').map(skill => ({ name: skill.name, path: skill.path, description: skill.interface?.shortDescription || skill.shortDescription || skill.description || '' })), incomplete: entries.some(entry => entry.errors?.length) };
  }
  async function models() {
    const entries = new Map(), seen = new Set(); let cursor;
    do {
      if (seen.size >= 10 || seen.has(cursor)) throw invalid('models.pagination', 502);
      seen.add(cursor);
      const page = await codex.rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const model of page.data) {
        if (model.hidden || typeof model.model !== 'string' || !model.model) continue;
        const efforts = [...new Map((model.supportedReasoningEfforts || []).filter(option => typeof option.reasoningEffort === 'string').map(option => [option.reasoningEffort, { effort: option.reasoningEffort, description: option.description || '' }])).values()];
        entries.set(model.model, { model: model.model, name: model.displayName || model.model, description: model.description || '', efforts, defaultEffort: model.defaultReasoningEffort || null });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { models: [...entries.values()] };
  }
  async function settings(id, value) {
    if (typeof value.model !== 'string' || !value.model || value.model.length > 200 || value.effort !== undefined && (typeof value.effort !== 'string' || value.effort.length > 30)) throw invalid('models.invalid');
    const catalog = await models(), model = catalog.models.find(model => model.model === value.model);
    if (!model || value.effort !== undefined && !model.efforts.some(option => option.effort === value.effort)) throw invalid('models.unavailable', 409);
    // Only these two settings can be changed here. Never forward permissions or global config.
    const params = { threadId: id, model: value.model, ...(value.effort !== undefined ? { effort: value.effort } : {}) };
    await codex.rpc('thread/settings/update', params);
    stale(id, 'settings');
    return readSettings(id);
  }
  async function readSettings(id) {
    const current = await thread(id);
    return { model: current.model, reasoningEffort: current.reasoningEffort };
  }
  async function input(id, value) {
    const parts = [{ type: 'text', text: value.text, text_elements: [] }];
    if (value.skills === undefined || Array.isArray(value.skills) && !value.skills.length) return parts;
    if (!Array.isArray(value.skills) || value.skills.length > 20 || value.skills.some(name => typeof name !== 'string' || name.length > 200)) throw invalid('tools.invalidSkills');
    const selected = new Set(value.skills);
    const available = await skills(id, true);
    const matched = new Map(skillMentions(value.text, available.skills).map(mention => [mention.name, mention.skill]));
    for (const name of selected) {
      const skill = matched.get(name);
      if (!skill) throw invalid('tools.skillUnavailable', 409);
      parts.push({ type: 'skill', name, path: skill.path });
    }
    return parts;
  }
  async function status(id) {
    const [current, limits] = await Promise.all([thread(id), codex.rpc('account/rateLimits/read').then(value => value, () => null)]);
    const window = value => value ? { usedPercent: number(value.usedPercent), windowDurationMins: number(value.windowDurationMins), resetsAt: number(value.resetsAt) } : null;
    const buckets = limits?.rateLimitsByLimitId ? Object.values(limits.rateLimitsByLimitId) : limits?.rateLimits ? [limits.rateLimits] : [];
    return { thread: { id: current.id, name: current.name, cwd: current.cwd, model: current.model, reasoningEffort: current.reasoningEffort, status: current.status }, connection: codex.status().state, usage: usage.get(id) || null, limits: limits ? buckets.map(bucket => ({ name: bucket.limitName || bucket.limitId || 'Codex', primary: window(bucket.primary), secondary: window(bucket.secondary) })) : null };
  }
  async function command(id, value) {
    if (value.command === 'rename') {
      if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 200 || /[\r\n\x00-\x1f]/.test(value.name)) throw invalid('tools.invalidName');
      const name = value.name.trim();
      await codex.rpc('thread/name/set', { threadId: id, name });
      return { name };
    }
    if (value.command === 'compact') {
      const current = await thread(id);
      if (current.status?.type !== 'idle' || compacting.has(id)) throw invalid('tools.compactBusy', 409);
      compacting.add(id);
      try {
        await codex.rpc('thread/compact/start', { threadId: id });
        stale(id, 'compaction');
        return { started: true };
      } catch (error) { compacting.delete(id); throw error; }
    }
    throw invalid('tools.unknownCommand');
  }
  return { event, connection, skills, input, status, command, models, settings, readSettings };
}
