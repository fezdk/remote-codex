// Structured task progress is a notification, not the prose `plan` history item.
// Keep the latest observed plan per thread; never infer completion from a reply.
export function createPlans(codex) {
  const threads = new Map();
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
  function snapshot(id) {
    const entry = threads.get(id);
    return { plan: entry?.plan ? { ...entry.plan, previousTurn: entry.turnId !== entry.plan.turnId } : null };
  }
  function event(message) {
    const p = message.params || {}, id = p.threadId;
    if (!validId(id)) return message;
    const method = message.method;
    if (!['turn/plan/updated', 'turn/started', 'turn/completed', 'thread/deleted', 'thread/closed'].includes(method)) return message;
    let entry = threads.get(id) || { turnId: null, plan: null };
    if (method === 'thread/deleted') threads.delete(id);
    else {
      if (method === 'turn/plan/updated') {
        if (!validId(p.turnId) || !Array.isArray(p.plan)) return message;
        const steps = p.plan.slice(0,100).filter(step => step && typeof step.step === 'string' && ['pending','inProgress','completed'].includes(step.status))
          .map(step => ({ step: step.step.slice(0,2000), status: step.status }));
        const turnStatus = entry.turnId === p.turnId ? entry.turnStatus || 'inProgress' : 'inProgress';
        entry.turnId = p.turnId; entry.turnStatus = turnStatus;
        entry.plan = { turnId: p.turnId, steps, explanation: typeof p.explanation === 'string' ? p.explanation.slice(0,4000) : '', updatedAt: Date.now(), turnStatus, stale: false,
          truncated: p.plan.length > 100 || steps.length !== p.plan.length || p.plan.some(step => step?.step?.length > 2000) || p.explanation?.length > 4000 };
      }
      if (method === 'turn/started' && validId(p.turn?.id)) { entry.turnId = p.turn.id; entry.turnStatus = 'inProgress'; }
      if (method === 'turn/completed' && entry.turnId === p.turn?.id) entry.turnStatus = p.turn.status;
      if (method === 'turn/completed' && entry.plan?.turnId === p.turn?.id) entry.plan.turnStatus = ['completed','interrupted','failed'].includes(p.turn.status) ? p.turn.status : 'unknown';
      if (method === 'thread/closed' && entry.plan) entry.plan.stale = true;
      threads.delete(id); threads.set(id,entry);
      if (threads.size > 100) threads.delete(threads.keys().next().value);
    }
    return { ...message, params: { ...p, remotePlan: snapshot(id) } };
  }
  function connection(status) {
    if (status.state !== 'connected') for (const entry of threads.values()) if (entry.plan) entry.plan.stale = true;
  }
  async function read(id) {
    const {thread} = await codex.rpc('thread/read',{threadId:id,includeTurns:false});
    if (!thread) throw Object.assign(new Error('error.sessionId'),{errorKey:'error.sessionId',status:404});
    return snapshot(id);
  }
  return { event, connection, read };
}
