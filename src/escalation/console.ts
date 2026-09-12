/**
 * Operator console.
 *
 * Minimal on purpose: a queue, a live view of the session, a way to act on it,
 * and a way to hand control back. What matters is that none of it is mocked -
 * the screenshot is the session the automation was using, the control list is
 * the live perception of that page, and pressing a button here drives the same
 * browser through the same policy gate.
 *
 * A production console would stream frames rather than poll PNGs and would talk
 * to a session host over a socket instead of calling the broker in-process.
 * Both are transport changes behind `EscalationBroker`; the control-transfer
 * semantics it enforces are the part that would carry over unchanged.
 */

import express from 'express';
import type { Server } from 'node:http';
import type { EscalationBroker } from './broker.js';

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8"><title>Handspan operator console</title>
<style>
 body{font:13px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;background:#12151c;color:#e6e9ef}
 header{padding:10px 16px;background:#1b2030;border-bottom:1px solid #2a3145;font-weight:600}
 main{display:grid;grid-template-columns:340px 1fr;gap:0;height:calc(100vh - 43px)}
 #queue{border-right:1px solid #2a3145;overflow:auto;padding:10px}
 #stage{overflow:auto;padding:12px}
 .card{background:#1b2030;border:1px solid #2a3145;border-radius:6px;padding:10px;margin-bottom:8px;cursor:pointer}
 .card.sel{border-color:#5b8def}
 .reason{color:#ffb86b;font-weight:600}
 .muted{color:#9aa4bb}
 button{font:inherit;border:1px solid #3b4560;color:#e6e9ef;border-radius:5px;padding:4px 9px;cursor:pointer;background:#252c3f}
 button:hover{background:#303950}
 button.primary{background:#2f5fd0;border-color:#4472d8}
 button.danger{background:#8a2f3a;border-color:#b03b48}
 input,select{font:inherit;background:#131722;border:1px solid #3b4560;color:#e6e9ef;border-radius:5px;padding:4px 6px}
 img{max-width:100%;border:1px solid #2a3145;border-radius:4px;background:#fff}
 table{border-collapse:collapse;width:100%;font-size:12px}
 td,th{border-bottom:1px solid #2a3145;padding:3px 6px;text-align:left;vertical-align:top}
 .row-actions{white-space:nowrap}
 pre{background:#131722;padding:8px;border-radius:5px;overflow:auto;max-height:180px;font-size:11px}
 .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
</style>
<header>Handspan &mdash; operator console <span class="muted" id="ctl"></span></header>
<main>
  <div id="queue"></div>
  <div id="stage"><p class="muted">Select an intervention.</p></div>
</main>
<script>
let sel=null, who=localStorage.getItem('op')||('operator-'+Math.random().toString(36).slice(2,6));
localStorage.setItem('op',who);
const j=(u,o)=>fetch(u,o).then(r=>r.json());

async function refresh(){
  const {interventions,controller,liveSessionUrl}=await j('/api/state');
  document.getElementById('ctl').textContent='| control: '+controller+' | you: '+who+(liveSessionUrl?' | devtools: '+liveSessionUrl:'');
  const q=document.getElementById('queue');
  q.innerHTML=interventions.map(i=>
    '<div class="card '+(i.id===sel?'sel':'')+'" onclick="pick(\\''+i.id+'\\')">'+
    '<div class="reason">'+i.reason+'</div>'+
    '<div>'+esc(i.detail)+'</div>'+
    '<div class="muted">'+i.state+(i.claimedBy?' by '+esc(i.claimedBy):'')+' &middot; '+i.id+'</div></div>').join('')
    ||'<p class="muted">No interventions. The run is proceeding on its own.</p>';
  if(sel) await draw();
}
function esc(s){return String(s??'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));}
async function pick(id){sel=id;await refresh();}

async function draw(){
  const i=(await j('/api/state')).interventions.find(x=>x.id===sel);
  if(!i)return;
  const s=document.getElementById('stage');
  const claimed=i.state==='claimed';
  let body='<h3>'+esc(i.reason)+' <span class="muted">'+i.id+'</span></h3>'+
    '<p>'+esc(i.detail)+'</p>'+
    '<table><tr><th>capability</th><td>'+esc(i.context.capabilityId||i.context.goal||'-')+'</td></tr>'+
    '<tr><th>step</th><td>'+esc(i.context.stepId||'-')+' &mdash; '+esc(i.context.stepIntent||'')+'</td></tr>'+
    '<tr><th>expected</th><td>'+esc(i.context.expected||'-')+'</td></tr>'+
    '<tr><th>observed</th><td>'+esc(i.context.observed||'-')+'</td></tr>'+
    '<tr><th>asked to do</th><td><b>'+esc(i.context.askedToDo)+'</b></td></tr></table>';
  if(!claimed&&i.state==='pending') body+='<div class="bar"><button class="primary" onclick="claim()">Take control of the live session</button></div>';
  if(i.state==='resolved'||i.state==='expired') body+='<p class="muted">Resolved: '+esc(JSON.stringify(i.resolution))+'</p>';
  if(claimed){
    body+='<div class="bar"><b>You hold control.</b>'+
      '<button class="primary" onclick="resolve(\\'resume\\')">Hand back &amp; resume</button>'+
      '<button onclick="resolveOutcome()">Hand back as business outcome</button>'+
      '<button class="danger" onclick="resolve(\\'abort\\')">Abort run</button></div>'+
      '<div class="bar"><input id="url" placeholder="navigate to url" size="40"><button onclick="act({kind:\\'navigate\\',url:document.getElementById(\\'url\\').value})">Go</button></div>'+
      '<div id="live"></div>';
  }
  if(i.operatorActions.length) body+='<h4>Your actions on this session</h4><pre>'+esc(i.operatorActions.map(a=>a.at+'  '+a.kind+'  '+(a.target||'')+'  '+(a.allowed?'ok':'BLOCKED: '+a.reason)).join('\\n'))+'</pre>';
  s.innerHTML=body;
  if(claimed) await live();
}

async function live(){
  const d=await j('/api/interventions/'+sel+'/live');
  document.getElementById('live').innerHTML=
    '<img src="/api/interventions/'+sel+'/screen?t='+Date.now()+'">'+
    '<h4>Controls on the live page</h4><table><tr><th>role</th><th>name</th><th>value</th><th>frame</th><th></th></tr>'+
    d.controls.map(c=>'<tr><td>'+esc(c.role)+'</td><td>'+esc(c.name)+'</td><td>'+esc(c.value??'')+'</td><td>'+esc(c.frame)+'</td>'+
      '<td class="row-actions">'+
      (c.role==='textbox'||c.role==='password'?'<input size="10" id="v_'+c.handle+'"><button onclick="act({kind:\\'fill\\',handle:\\''+c.handle+'\\',value:document.getElementById(\\'v_'+c.handle+'\\').value})">fill</button>':'')+
      (c.role==='combobox'?'<input size="10" id="v_'+c.handle+'"><button onclick="act({kind:\\'select\\',handle:\\''+c.handle+'\\',value:document.getElementById(\\'v_'+c.handle+'\\').value})">select</button>':'')+
      '<button onclick="act({kind:\\'click\\',handle:\\''+c.handle+'\\'})">click</button></td></tr>').join('')+'</table>';
}

async function claim(){await j('/api/interventions/'+sel+'/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({by:who})});await refresh();}
async function act(req){const r=await j('/api/interventions/'+sel+'/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req)});if(!r.ok)alert('Refused: '+r.reason);await draw();}
async function resolve(action,outcomeId){await j('/api/interventions/'+sel+'/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,outcomeId,by:who,note:''})});sel=null;await refresh();}
function resolveOutcome(){const id=prompt('Outcome id declared by the capability, e.g. MEMBER_NOT_FOUND');if(id)resolve('outcome',id);}
setInterval(refresh,2000); refresh();
</script>`;

export interface ConsoleHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * The console's HTTP surface, separated from binding a port so it can be
 * driven directly in tests. Every route is a thin translation of a broker
 * call: the console has no authority of its own.
 */
export function buildConsoleApp(broker: EscalationBroker): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => res.type('html').send(PAGE));

  app.get('/api/state', (_req, res) => {
    res.json({
      controller: broker.control.current,
      liveSessionUrl: broker.liveSessionUrl,
      interventions: broker.list(),
    });
  });

  app.post('/api/interventions/:id/claim', (req, res) => {
    try {
      res.json(broker.claim(req.params.id, String((req.body as { by?: string }).by ?? 'operator')));
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  });

  app.post('/api/interventions/:id/heartbeat', (req, res) => {
    try {
      res.json(broker.heartbeat(req.params.id));
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  });

  app.get('/api/interventions/:id/live', async (req, res) => {
    try {
      const obs = await broker.observeForOperator(req.params.id);
      res.json({
        url: obs.url,
        controls: obs.controls.map((c) => ({
          handle: c.handle,
          role: c.role,
          name: c.name,
          value: c.value,
          frame: c.framePath.map((f) => f.name ?? `#${f.index}`).join('/') || 'top',
        })),
      });
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  });

  app.get('/api/interventions/:id/screen', async (req, res) => {
    try {
      // The content type is set only once the bytes are in hand. Setting it
      // first left an error response labelled as an image, so a refusal reached
      // the operator as a broken picture rather than a reason.
      const png = await broker.screenshotForOperator(req.params.id);
      res.type('png').send(png);
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  });

  app.post('/api/interventions/:id/act', async (req, res) => {
    try {
      res.json(await broker.operatorAct(req.params.id, req.body));
    } catch (err) {
      res.status(409).json({ ok: false, reason: String(err) });
    }
  });

  app.post('/api/interventions/:id/resolve', (req, res) => {
    const b = req.body as { action: 'resume' | 'abort' | 'outcome'; outcomeId?: string; by?: string; note?: string };
    try {
      res.json(
        broker.resolve(req.params.id, {
          action: b.action,
          outcomeId: b.outcomeId,
          note: b.note,
          by: b.by ?? 'operator',
          at: new Date().toISOString(),
        }),
      );
    } catch (err) {
      res.status(409).json({ error: String(err) });
    }
  });

  return app;
}

export function startOperatorConsole(broker: EscalationBroker, port: number): Promise<ConsoleHandle> {
  const app = buildConsoleApp(broker);
  return new Promise((resolve) => {
    const server: Server = app.listen(port, () => {
      // Read the port back rather than echoing what was asked for: 0 means
      // "pick a free one", and the caller needs the one that was picked.
      const bound = (server.address() as { port: number }).port;
      resolve({
        url: `http://localhost:${bound}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
