// Session.active includes accepted queued tasks on the existing server. Derive
// presentation from task status so an idle queue never promises agent execution.
function ArchonQueueCounts(tasks) {
  let running = 0, queued = 0;
  for (const task of tasks) {
    if (task.state === 'working' || task.state === 'cancelling') running++;
    else if (task.state === 'queued') queued++;
  }
  return { running, queued };
}

function ArchonQueueLabel(tasks) {
  const { running, queued } = ArchonQueueCounts(tasks);
  return `${running} running${queued ? ` · ${queued} queued` : ''}`;
}

function ArchonQueueData(data) {
  const bySession = new Map();
  for (const task of data.tasks) {
    if (!task.sessionId) continue;
    if (!bySession.has(task.sessionId)) bySession.set(task.sessionId, []);
    bySession.get(task.sessionId).push(task);
  }
  const states = { working: 'working', cancelling: 'working', queued: 'queued', failed: 'error', blocked: 'error', finished: 'done' };
  const sessions = data.sessions.map(session => {
    const tasks = bySession.get(session.id);
    if (!tasks?.length) return session;
    const active = tasks.find(task => task.state === 'working' || task.state === 'cancelling') || tasks.find(task => task.state === 'queued');
    const state = states[(active || tasks[0]).state] || session.state;
    return state === session.state ? session : { ...session, state };
  });
  const byProject = new Map();
  for (const session of sessions) {
    if (!session.projectId) continue;
    if (!byProject.has(session.projectId)) byProject.set(session.projectId, []);
    byProject.get(session.projectId).push(...(bySession.get(session.id) || []));
  }
  return { ...data, sessions,
    projects: data.projects.map(project => ({ ...project, ...ArchonQueueCounts(byProject.get(project.id) || []) })),
    host: { ...data.host, ...ArchonQueueCounts(data.tasks) }
  };
}

function patchRendererQueueStatus(renderer) {
  let result = renderer;
  const replace = (before, after, label) => {
    if (result.split(before).length !== 2) throw Error(`queue ${label} anchor must occur exactly once`);
    result = result.replace(before, () => after);
  };
  if (result.includes('function ArchonQueueData(')) throw Error('queue patch already applied');
  const helpers = [ArchonQueueCounts, ArchonQueueLabel, ArchonQueueData].map(fn => fn.toString()).join('\n');
  replace('function Ne(){', `${helpers}\nfunction Ne(){`, 'helpers');
  replace('const Me=k.useMemo(()=>{const Se=new Set', 'const arQueueData=k.useMemo(()=>ArchonQueueData(f),[f]);const Me=k.useMemo(()=>{const Se=new Set', 'derived state');
  replace('Ke=k.useMemo(()=>f.sessions,[f.sessions])', 'Ke=k.useMemo(()=>arQueueData.sessions,[arQueueData.sessions])', 'visible sessions');
  replace('renameSession:De,data:f,workspaceSessionIds:Me', 'renameSession:De,data:arQueueData,workspaceSessionIds:Me', 'context data');
  replace('De,f,Me,Ke', 'De,f,arQueueData,Me,Ke', 'context dependencies');

  replace('title:Y.state==="cancelling"?"The active turn is being stopped":"The session agent is actively working on this turn"', 'title:Y.state==="queued"?"Waiting for an agent worker to start this turn":Y.state==="cancelling"?"The active turn is being stopped":"The session agent is actively working on this turn"', 'turn tooltip');
  replace('className:`ph ${Y.state==="cancelling"?"ph-circle-notch":"ph-lightning"}`', 'className:`ph ${Y.state==="queued"?"ph-queue":Y.state==="cancelling"?"ph-circle-notch":"ph-lightning"}`', 'turn icon');
  replace('Y.state==="cancelling"?"Cancelling":"Working"]', 'Y.state==="queued"?"Queued":Y.state==="cancelling"?"Cancelling":"Working"]', 'turn label');
  replace('title:"Prompts waiting to run after the active turn"', 'title:"Prompts waiting for an agent worker"', 'queue tooltip');
  replace('msgs:0,state:"working",preview:"",cost:0,approval:n.approval,cwd:v?.cwd', 'msgs:0,state:v?.state==="working"?"working":"queued",preview:"",cost:0,approval:n.approval,cwd:v?.cwd', 'pending session');

  replace('children:y?`${ee} running`:"Not connected"', 'children:y?ArchonQueueLabel(f.tasks):"Not connected"', 'sidebar summary');
  replace('children:[El(x,y)," task",x===1?"":"s"," running"]', 'children:ArchonQueueLabel(s.tasks)', 'home summary');
  replace('x=s.tasks.filter(O=>O.state==="working"||O.state==="queued").length', 'x=ArchonQueueCounts(s.tasks).running', 'home activity');
  replace('f=d.tasks.filter(y=>y.state==="working"||y.state==="queued").length', 'f=ArchonQueueCounts(d.tasks).running', 'titlebar activity');
  replace('children:F.running?`${F.running} running`:"none running"', 'children:`${F.running} running${F.queued?` · ${F.queued} queued`:""}`', 'project summary');
  replace('A("Running now",String(v.running))', 'A("Running / queued",`${v.running} / ${v.queued||0}`)', 'project detail');
  return result;
}

module.exports = { ArchonQueueData, ArchonQueueCounts, ArchonQueueLabel, patchRendererQueueStatus };
