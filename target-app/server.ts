/**
 * Mock core-servicing app: the stand-in for a bank back-office system.
 *
 * Two things it has to do well:
 *   1. Be genuinely awkward to automate (see views.ts).
 *   2. Produce, on demand, every runtime condition replay has to survive.
 *
 * Fault injection is driven through /_admin/fault so tests and the demo script
 * can arm a condition and then run an ordinary replay against it. Nothing here
 * is reachable from the automation's own allowlist.
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import { MEMBERS, PRODUCTS } from './data.js';
import * as V from './views.js';

const PORT = Number(process.env.TARGET_APP_PORT ?? 8099);
const OPERATOR_ID = process.env.MERIDIAN_USERNAME ?? 'tellersvc';
/**
 * Which build of the vendor product this instance is. Running a second instance
 * with TARGET_APP_VARIANT=v9 stands in for a second institution on a later,
 * differently branded release of the same software.
 */
const DEFAULT_VARIANT: 'v8' | 'v9' = process.env.TARGET_APP_VARIANT === 'v9' ? 'v9' : 'v8';
const OPERATOR_PW = process.env.MERIDIAN_PASSWORD ?? 'demo-pass-not-real';

type FaultKind = 'none' | 'slow' | 'app_error' | 'session_expire' | 'always_notice' | 'search_validation';

interface Session {
  id: string;
  signedOn: boolean;
  noticeAcked: boolean;
  variant: 'v8' | 'v9';
  pending?: { token: string; memberNumber: string; prod: string; amt: string };
}

const sessions = new Map<string, Session>();

/**
 * Armed fault. `onPath` lets a test place the fault at a specific point in a
 * flow rather than on the next request, which matters: a session that expires
 * on the entry screen is trivially recovered, while one that expires halfway
 * through forces the recovery to rebuild everything the flow had already done.
 */
let fault: { kind: FaultKind; remaining: number; onPath?: string } = { kind: 'none', remaining: 0 };

function takeFault(path: string): FaultKind {
  if (fault.kind === 'none' || fault.remaining <= 0) return 'none';
  if (fault.onPath && !path.includes(fault.onPath)) return 'none';
  fault.remaining -= 1;
  const k = fault.kind;
  if (fault.remaining <= 0) fault = { kind: 'none', remaining: 0 };
  return k;
}

const app = express();
app.use(express.urlencoded({ extended: false }));

function cookies(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function session(req: express.Request, res: express.Response): Session {
  const sid = cookies(req.headers.cookie)['MRDNSESS'];
  let s = sid ? sessions.get(sid) : undefined;
  if (!s) {
    s = { id: randomUUID(), signedOn: false, noticeAcked: false, variant: DEFAULT_VARIANT };
    sessions.set(s.id, s);
    res.setHeader('Set-Cookie', `MRDNSESS=${s.id}; Path=/; HttpOnly`);
  }
  const variant = String(req.query.variant ?? '');
  if (variant === 'v8' || variant === 'v9') s.variant = variant;
  return s;
}

const view = (s: Session) => V.VARIANTS[s.variant]!;

/** Applies the armed fault. Returns true when the request has been answered. */
async function faultGate(req: express.Request, res: express.Response, s: Session): Promise<boolean> {
  const kind = takeFault(req.path);
  if (kind === 'slow') {
    await new Promise((r) => setTimeout(r, 6500));
    return false;
  }
  if (kind === 'app_error') {
    res.status(500).send(V.appError(view(s), randomUUID().slice(0, 8).toUpperCase()));
    return true;
  }
  if (kind === 'session_expire') {
    s.signedOn = false;
    res.send(V.expired(view(s)));
    return true;
  }
  if (kind === 'always_notice') {
    s.noticeAcked = false;
    return false;
  }
  return false;
}

/** Everything except /login and the admin hooks requires a signed-on session. */
app.use(async (req, res, next) => {
  if (req.path.startsWith('/_admin')) return next();
  const s = session(req, res);
  if (await faultGate(req, res, s)) return;
  if (!s.signedOn && req.path !== '/login' && req.path !== '/logout') {
    res.send(V.loginPage(view(s)));
    return;
  }
  next();
});

app.get('/', (req, res) => res.send(V.frameset(view(session(req, res)))));
app.get('/nav', (req, res) => res.send(V.navFrame(view(session(req, res)))));

app.get('/main', (req, res) => {
  const s = session(req, res);
  res.send(V.mainFrame(view(s), !s.noticeAcked));
});

app.post('/notice/ack', (req, res) => {
  const s = session(req, res);
  s.noticeAcked = true;
  res.send(V.mainFrame(view(s), false));
});

app.post('/login', (req, res) => {
  const s = session(req, res);
  const { op, pw } = req.body as { op?: string; pw?: string };
  if (op === OPERATOR_ID && pw === OPERATOR_PW) {
    s.signedOn = true;
    res.redirect('/');
    return;
  }
  res.send(V.loginPage(view(s), 'Sign-on failed. Operator ID or password is not valid.'));
});

app.get('/logout', (req, res) => {
  const s = session(req, res);
  s.signedOn = false;
  s.noticeAcked = false;
  res.send(V.loginPage(view(s)));
});

app.get('/member/search', (req, res) => res.send(V.searchForm(view(session(req, res)))));

app.post('/member/search', (req, res) => {
  const s = session(req, res);
  const v = view(s);
  const raw = String((req.body as { mbr_no?: string }).mbr_no ?? '').trim();

  if (!/^\d{5}$/.test(raw)) {
    res.send(V.searchForm(v, 'Member Number must be exactly 5 numeric digits.'));
    return;
  }
  const m = MEMBERS[raw];
  if (!m) {
    res.send(V.notFound(v, raw));
    return;
  }
  if (m.restricted) {
    res.status(403).send(V.restricted(v, raw));
    return;
  }
  res.redirect(`/member/${raw}`);
});

app.get('/member/:id', (req, res) => {
  const s = session(req, res);
  const m = MEMBERS[String(req.params.id)];
  if (!m || m.restricted) {
    res.send(V.notFound(view(s), String(req.params.id)));
    return;
  }
  res.send(V.memberDetail(view(s), m));
});

app.get('/member/:id/subaccount', (req, res) => {
  const s = session(req, res);
  const m = MEMBERS[String(req.params.id)];
  if (!m) return void res.send(V.notFound(view(s), String(req.params.id)));
  res.send(V.subaccountForm(view(s), m));
});

app.post('/member/:id/subaccount', (req, res) => {
  const s = session(req, res);
  const v = view(s);
  const m = MEMBERS[String(req.params.id)];
  if (!m) return void res.send(V.notFound(v, String(req.params.id)));

  const { prod, amt } = req.body as { prod?: string; amt?: string };
  if (!prod) return void res.send(V.subaccountForm(v, m, 'Product is required.'));
  if (!PRODUCTS.some((p) => p.code === prod)) {
    return void res.send(V.subaccountForm(v, m, 'Product code is not valid for this member class.'));
  }
  if (!/^\d+(\.\d{1,2})?$/.test(String(amt ?? ''))) {
    return void res.send(V.subaccountForm(v, m, 'Initial Deposit must be a numeric amount.'));
  }
  const token = randomUUID().slice(0, 8);
  s.pending = { token, memberNumber: m.memberNumber, prod, amt: String(amt) };
  res.send(V.subaccountConfirm(v, m, prod, String(amt), token));
});

app.post('/member/:id/subaccount/post', (req, res) => {
  const s = session(req, res);
  const v = view(s);
  const m = MEMBERS[String(req.params.id)];
  const token = String((req.body as { token?: string }).token ?? '');
  if (!m || !s.pending || s.pending.token !== token) {
    return void res.send(V.appError(v, 'STALE-TOKEN'));
  }
  const suffix = String(2000 + m.shares.length).padStart(4, '0');
  s.pending = undefined;
  res.send(V.subaccountPosted(v, m, suffix));
});

app.get('/reports', (req, res) => res.send(V.reports(view(session(req, res)))));

// --- test/demo control plane; not part of the automated surface -------------
app.post('/_admin/fault', express.json(), (req, res) => {
  const { kind, count, onPath } = req.body as { kind?: FaultKind; count?: number; onPath?: string };
  fault = {
    kind: (kind ?? 'none') as FaultKind,
    remaining: kind && kind !== 'none' ? (count ?? 1) : 0,
    onPath,
  };
  res.json({ ok: true, fault });
});
app.post('/_admin/reset', (req, res) => {
  sessions.clear();
  fault = { kind: 'none', remaining: 0 };
  res.json({ ok: true });
});
app.get('/_admin/health', (_req, res) => res.json({ ok: true, fault }));

app.listen(PORT, () => {
  console.log(`[target-app] Meridian Core Servicing (mock, ${DEFAULT_VARIANT}) on http://localhost:${PORT}`);
  console.log(`[target-app] operator ${OPERATOR_ID} / members ${Object.keys(MEMBERS).join(', ')}`);
});
