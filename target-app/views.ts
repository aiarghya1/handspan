/**
 * Markup for the mock app. Deliberately written the way a 2003-era
 * server-rendered admin console was written:
 *
 *   - a frameset, so the automation has to reason about frames
 *   - nested table layout with no semantic landmarks
 *   - form fields carry `name` only: no id, no <label for>, no test ids
 *   - submits are <input type="submit" value="..."> and inline-JS anchors
 *
 * The only stable, human-visible handle on any control is the text sitting
 * next to it. That is the whole point: it forces the perception layer to do
 * the label-association work that a real legacy surface demands.
 */

import { MEMBERS, PRODUCTS, type Member } from './data.js';

export interface Variant {
  /** Vendor release label. v9 renames a few controls, standing in for a second tenant. */
  id: 'v8' | 'v9';
  brand: string;
  retrieveLabel: string;
  savingsLabel: string;
}

export const VARIANTS: Record<string, Variant> = {
  v8: { id: 'v8', brand: 'MERIDIAN CORE SERVICING 8.4', retrieveLabel: 'Retrieve', savingsLabel: 'REGULAR SHARE SAVINGS' },
  v9: { id: 'v9', brand: 'Meridian Servicing Suite 9.1', retrieveLabel: 'Search', savingsLabel: 'REGULAR SAVINGS' },
};

const CSS = `
  body { font: 12px Verdana, Geneva, sans-serif; background: #d4d0c8; margin: 0; padding: 0; }
  table { border-collapse: collapse; }
  td { font: 12px Verdana, Geneva, sans-serif; padding: 2px 4px; }
  .hdr { background: #1f3864; color: #fff; padding: 5px 8px; font-weight: bold; letter-spacing: .04em; }
  .panel { border: 2px inset #fff; background: #ece9d8; margin: 8px; padding: 6px; }
  .err { background: #ffe8e8; border: 1px solid #a00; color: #900; padding: 6px; margin: 8px; font-weight: bold; }
  .warn { background: #fffbe6; border: 1px solid #b8860b; padding: 6px; margin: 8px; }
  .ok { background: #eaffea; border: 1px solid #060; padding: 6px; margin: 8px; }
  .grid td { border: 1px solid #9a9a8c; }
  .grid .h td { background: #b6c4de; font-weight: bold; }
  .amt { text-align: right; font-family: "Courier New", monospace; }
  .modal { position: fixed; top: 80px; left: 60px; width: 440px; background: #ece9d8;
           border: 3px outset #fff; box-shadow: 4px 4px 0 #666; z-index: 99; }
  .navlnk { display: block; padding: 3px 6px; color: #1f3864; }
  input, select { font: 12px Verdana, sans-serif; }
`;

function page(title: string, body: string): string {
  return `<html><head><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

export function loginPage(v: Variant, error?: string): string {
  return page(
    `${v.brand} - Sign On`,
    `<div class="hdr">${v.brand}</div>
     ${error ? `<div class="err">${error}</div>` : ''}
     <form method="post" action="/login">
       <div class="panel"><table>
         <tr><td>Operator ID</td><td><input type="text" name="op" size="18"></td></tr>
         <tr><td>Password</td><td><input type="password" name="pw" size="18"></td></tr>
         <tr><td colspan="2"><input type="submit" value="Sign On"></td></tr>
       </table></div>
     </form>`,
  );
}

export function frameset(v: Variant): string {
  return `<html><head><title>${v.brand}</title></head>
    <frameset cols="170,*" frameborder="1">
      <frame name="nav" src="/nav">
      <frame name="main" src="/main">
    </frameset></html>`;
}

export function navFrame(v: Variant): string {
  return page(
    'Menu',
    `<div class="hdr" style="font-size:10px">MENU</div>
     <a class="navlnk" href="/member/search" target="main">Member Inquiry</a>
     <a class="navlnk" href="/main" target="main">Home</a>
     <a class="navlnk" href="/reports" target="main">Reports</a>
     <a class="navlnk" href="/logout" target="_top">Sign Off</a>`,
  );
}

export function mainFrame(v: Variant, showNotice: boolean): string {
  const notice = showNotice
    ? `<div class="modal" role="dialog">
         <div class="hdr">Scheduled Maintenance</div>
         <div style="padding:10px">
           Nightly batch begins at 23:00 ET. Postings after 22:45 may be dated to the next business day.
           <form method="post" action="/notice/ack" style="margin-top:10px">
             <input type="submit" value="Continue">
           </form>
         </div>
       </div>`
    : '';
  return page(
    'Home',
    `${notice}<div class="hdr">${v.brand}</div>
     <div class="panel">Select a function from the menu.</div>`,
  );
}

export function searchForm(v: Variant, error?: string): string {
  return page(
    'Member Inquiry',
    `<div class="hdr">MEMBER INQUIRY</div>
     ${error ? `<div class="err">${error}</div>` : ''}
     <form method="post" action="/member/search">
      <div class="panel"><table><tr><td>
        <table><tr>
          <td nowrap>Member Number</td>
          <td><input type="text" name="mbr_no" size="10" maxlength="5"></td>
          <td>&nbsp;&nbsp;</td>
          <td nowrap>Suffix</td>
          <td><input type="text" name="sfx" size="5"></td>
        </tr><tr>
          <td colspan="5" style="padding-top:8px">
            <input type="submit" value="${v.retrieveLabel}">
            <input type="reset" value="Clear">
          </td>
        </tr></table>
      </td></tr></table></div>
     </form>`,
  );
}

export function notFound(v: Variant, mbr: string): string {
  return page(
    'Member Inquiry',
    `<div class="hdr">MEMBER INQUIRY</div>
     <div class="err">No member found for ${mbr}.</div>
     <div class="panel"><a href="/member/search">Return to inquiry</a></div>`,
  );
}

export function restricted(v: Variant, mbr: string): string {
  return page(
    'Member Inquiry',
    `<div class="hdr">MEMBER INQUIRY</div>
     <div class="err">Access to member ${mbr} is restricted. Operator entitlement RS-04 required.</div>
     <div class="panel"><a href="/member/search">Return to inquiry</a></div>`,
  );
}

export function memberDetail(v: Variant, m: Member): string {
  const rows = m.shares
    .map((s) => {
      const product = s.product === 'REGULAR SHARE SAVINGS' ? v.savingsLabel : s.product;
      return `<tr><td>${s.suffix}</td><td nowrap>${product}</td>
              <td class="amt">${s.balance.toFixed(2)}</td>
              <td class="amt">${s.available.toFixed(2)}</td></tr>`;
    })
    .join('');
  return page(
    'Member Detail',
    `<div class="hdr">MEMBER DETAIL &nbsp;-&nbsp; ${m.memberNumber}</div>
     <div class="panel"><table><tr><td>
       <table><tr>
         <td nowrap>Name</td><td nowrap><b>${m.name}</b></td>
         <td>&nbsp;&nbsp;&nbsp;</td>
         <td nowrap>Status</td><td nowrap><b>${m.status}</b></td>
       </tr><tr>
         <td nowrap>Branch</td><td nowrap>${m.branch}</td>
         <td></td>
         <td nowrap>Tax ID</td><td nowrap>${m.taxId}</td>
       </tr></table>
     </td></tr></table></div>
     <div class="panel">
       <table class="grid" width="100%">
         <tr class="h"><td>Sfx</td><td>Product</td><td class="amt">Balance</td><td class="amt">Available</td></tr>
         ${rows || '<tr><td colspan="4">No shares on file.</td></tr>'}
       </table>
     </div>
     <div class="panel">
       <a href="/member/${m.memberNumber}/subaccount">Open Sub-Account</a>
       &nbsp;|&nbsp;
       <a href="/member/search">New Inquiry</a>
     </div>`,
  );
}

export function subaccountForm(v: Variant, m: Member, error?: string): string {
  const opts = PRODUCTS.map((p) => `<option value="${p.code}">${p.label}</option>`).join('');
  return page(
    'Open Sub-Account',
    `<div class="hdr">OPEN SUB-ACCOUNT &nbsp;-&nbsp; ${m.memberNumber}</div>
     ${error ? `<div class="err">${error}</div>` : ''}
     <form method="post" action="/member/${m.memberNumber}/subaccount">
       <div class="panel"><table>
         <tr><td nowrap>Product</td><td><select name="prod"><option value="">-- select --</option>${opts}</select></td></tr>
         <tr><td nowrap>Initial Deposit</td><td><input type="text" name="amt" size="12"></td></tr>
         <tr><td colspan="2" style="padding-top:8px"><input type="submit" value="Continue"></td></tr>
       </table></div>
     </form>`,
  );
}

export function subaccountConfirm(v: Variant, m: Member, prod: string, amt: string, token: string): string {
  const label = PRODUCTS.find((p) => p.code === prod)?.label ?? prod;
  return page(
    'Confirm Sub-Account',
    `<div class="hdr">CONFIRM SUB-ACCOUNT</div>
     <div class="warn">Review before posting. Posting creates a share record and cannot be reversed from this screen.</div>
     <div class="panel"><table>
       <tr><td nowrap>Member</td><td><b>${m.memberNumber} ${m.name}</b></td></tr>
       <tr><td nowrap>Product</td><td><b>${label}</b></td></tr>
       <tr><td nowrap>Initial Deposit</td><td><b>${amt}</b></td></tr>
     </table></div>
     <form method="post" action="/member/${m.memberNumber}/subaccount/post">
       <input type="hidden" name="token" value="${token}">
       <div class="panel"><input type="submit" value="Confirm and Post">
       &nbsp;<a href="/member/${m.memberNumber}">Cancel</a></div>
     </form>`,
  );
}

export function subaccountPosted(v: Variant, m: Member, suffix: string): string {
  return page(
    'Sub-Account Posted',
    `<div class="hdr">SUB-ACCOUNT POSTED</div>
     <div class="ok">Share ${m.memberNumber}-${suffix} created. Confirmation 8831-${suffix}.</div>
     <div class="panel"><a href="/member/${m.memberNumber}">Back to member</a></div>`,
  );
}

export function expired(v: Variant): string {
  return page(
    'Session Expired',
    `<div class="hdr">${v.brand}</div>
     <div class="err">Your session has expired due to inactivity. Please sign on again.</div>
     <form method="post" action="/login">
       <div class="panel"><table>
         <tr><td>Operator ID</td><td><input type="text" name="op" size="18"></td></tr>
         <tr><td>Password</td><td><input type="password" name="pw" size="18"></td></tr>
         <tr><td colspan="2"><input type="submit" value="Sign On"></td></tr>
       </table></div>
     </form>`,
  );
}

export function appError(v: Variant, ref: string): string {
  return page(
    'System Error',
    `<div class="hdr">${v.brand}</div>
     <div class="err">CICS ABEND ASRA &nbsp; TRAN=MBRI &nbsp; REF=${ref}<br>
     An unexpected condition occurred. Contact the service desk.</div>`,
  );
}

export function reports(v: Variant): string {
  return page('Reports', `<div class="hdr">REPORTS</div><div class="panel">No reports are entitled to this operator.</div>`);
}

export { MEMBERS };
