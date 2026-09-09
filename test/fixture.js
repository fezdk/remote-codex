import { EventEmitter } from 'node:events';

export class FixtureCodex extends EventEmitter {
  constructor() {
    super();
    this.requests = new Map(); this.subscriptions = new Set(); this.calls = []; this.sequence = 0; this.queues = new Map(); this.queueCount = 0;
    this.threads = [
      { id:'session-one', name:'Byg et browser-UI', cwd:'/home/demo/projects/remote-codex', model:'local-model', status:{type:'idle'}, updatedAt:Date.now()/1000, canAcceptDirectInput:true },
      { id:'session-two', name:'Mit andet projekt', cwd:'/home/demo/projects/website', model:'local-model', status:{type:'idle'}, updatedAt:Date.now()/1000-100000, canAcceptDirectInput:true },
    ];
    this.turns = [{ id:'turn-original', startedAt:1, status:'completed', items:[
      { id:'user-original', type:'userMessage', content:[{type:'text',text:'Byg et web-UI til mine lokale Codex-sessioner.'}] },
      { id:'agent-original', type:'agentMessage',text:'Jeg forbinder browseren til din **lokale Codex-server**.\n\n```js\nconst local = true;\n```\n<script>window.compromised=true</script>\n[unsafe](javascript:alert(1))' },
      { id:'files-original',type:'fileChange',status:'completed',changes:[{path:'/home/demo/projects/remote-codex/app.js',kind:{type:'update'},diff:'@@ -1 +1 @@\n-old value\n+<script>unsafe</script>'}] },
      { id:'tool-original', type:'commandExecution',command:'pwd',cwd:'/home/demo/projects/remote-codex',aggregatedOutput:'/home/demo/projects/remote-codex',exitCode:0,status:'completed' },
    ]}];
  }
  status(){return{state:'connected',platform:'linux',transport:'unix'};}
  event(method,params,id){const message={method,params,bridgeSequence:++this.sequence,...(id!==undefined?{id,requestToken:`fixture-request-${this.sequence}`} : {})};if(id!==undefined)this.requests.set(JSON.stringify(id),message);this.emit('event',message);}
  async subscribe(id){this.subscriptions.add(id);return this.rpc('thread/resume',{threadId:id,excludeTurns:true});}
  async rpc(method,params={}){
    this.calls.push({method,params});
    if(method==='thread/read')return{thread:this.threads.find(t=>t.id===params.threadId)};
    if(method.startsWith('thread/queue/')) {
      const list=this.queues.get(params.threadId)||[];this.queues.set(params.threadId,list);
      const index=list.findIndex(item=>item.id===params.queuedSubmissionId);
      if(method==='thread/queue/list')return{data:structuredClone(list),nextCursor:null};
      if(method==='thread/queue/add'){const queuedSubmission={id:`queued-${++this.queueCount}`,input:params.input,clientUserMessageId:params.clientUserMessageId};list.push(queuedSubmission);this.event('thread/queue/changed',{threadId:params.threadId});return{queuedSubmission};}
      if(method==='thread/queue/delete'){if(index>=0)list.splice(index,1);this.event('thread/queue/changed',{threadId:params.threadId});return{deleted:index>=0};}
      if(method==='thread/queue/start'){if(index<0)throw new Error('queued submission not found');const item=list.splice(index,1)[0];this.event('thread/queue/changed',{threadId:params.threadId});return this.rpc('turn/start',{threadId:params.threadId,input:item.input});}
    }
    if(method==='thread/list')return{data:this.threads.filter(t=>!params.searchTerm||t.name.toLowerCase().includes(params.searchTerm.toLowerCase())),nextCursor:null};
    if(method==='thread/resume')return{thread:{...this.threads.find(t=>t.id===params.threadId),turns:[]},model:'local-model'};
    if(method==='thread/turns/list')return{data:params.threadId==='session-one'?structuredClone([...this.turns].reverse()):[],nextCursor:null,bridgeSequence:this.sequence};
    if(method==='thread/start'){
      const thread={id:`new-${this.threads.length}`,name:'Ny session',cwd:params.cwd,model:'local-model',status:{type:'idle'},updatedAt:Date.now()/1000,canAcceptDirectInput:true};
      this.threads.unshift(thread);return{thread};
    }
    if(method==='turn/start'){
      const text=params.input[0].text;
      const turn={id:`turn-${this.turns.length}`,startedAt:Date.now()/1000,status:'inProgress',items:[]};
      this.turns.push(turn);this.event('turn/started',{threadId:params.threadId,turn:structuredClone(turn)});
      const user={id:`user-${turn.id}`,type:'userMessage',content:params.input};turn.items.push(user);this.event('item/completed',{threadId:params.threadId,turnId:turn.id,item:user});
      if(text==='approval'){
        this.event('item/commandExecution/requestApproval',{threadId:params.threadId,turnId:turn.id,itemId:'approval-command',command:'npm test',cwd:'/home/demo/project',reason:'Kør projektets tests',availableDecisions:['accept','decline','cancel']},42);
      }else if(text==='question'){
        this.event('item/tool/requestUserInput',{threadId:params.threadId,turnId:turn.id,itemId:'question',questions:[{id:'choice',header:'Farve',question:'Hvilken farve?',options:[{label:'Grøn',description:'Rolig farve'}]}]},43);
      }else if(text!=='long'){
        const item={id:`agent-${turn.id}`,type:'agentMessage',text:''};turn.items.push(item);this.event('item/started',{threadId:params.threadId,turnId:turn.id,item:structuredClone(item)});
        setTimeout(()=>{item.text='Svaret streames';this.event('item/agentMessage/delta',{threadId:params.threadId,turnId:turn.id,itemId:item.id,delta:item.text});},40);
        setTimeout(()=>{item.text+=' fra din maskine.';this.event('item/completed',{threadId:params.threadId,turnId:turn.id,item:structuredClone(item)});this.complete(params.threadId,turn);},300);
      }
      return{turn:structuredClone(turn)};
    }
    if(method==='turn/steer'){
      const turn=this.turns.find(t=>t.id===params.expectedTurnId);
      if(!turn||turn.status!=='inProgress')throw new Error('Turn is no longer active.');
      const item={id:`steered-${this.sequence}`,type:'userMessage',content:params.input};turn.items.push(item);this.event('item/completed',{threadId:params.threadId,turnId:turn.id,item});return{turnId:turn.id};
    }
    if(method==='turn/interrupt'){
      const turn=this.turns.find(t=>t.id===params.turnId);turn.status='interrupted';this.event('turn/completed',{threadId:params.threadId,turn:structuredClone(turn)});return{};
    }
    throw new Error(`Unknown method: ${method}`);
  }
  complete(threadId,turn){turn.status='completed';this.event('turn/completed',{threadId,turn:structuredClone(turn)});const next=this.queues.get(threadId)?.[0];if(next)setTimeout(()=>this.rpc('thread/queue/start',{threadId,queuedSubmissionId:next.id}),30);}
  respond(id,result){
    this.calls.push({method:'respond',id,result});
    const request=this.requests.get(JSON.stringify(id));this.requests.delete(JSON.stringify(id));
    this.event('serverRequest/resolved',{threadId:request.params.threadId,requestId:id});
    this.complete(request.params.threadId,this.turns.find(t=>t.id===request.params.turnId));
  }
}
