/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

export function adminCreditsHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Otto 积分管理</title>
<style>
:root{--ink:#18221e;--muted:#66716c;--line:#dce3df;--panel:#fff;--subtle:#edf2ef;--accent:#176a4b;--accent-hover:#11563c;--accent-soft:#e5f1eb;--danger:#aa3f35;--danger-soft:#faece9;--radius:10px;--shadow:0 12px 36px rgba(26,42,34,.12)}
*{box-sizing:border-box}body{margin:0;background:#f4f6f5;color:var(--ink);font-family:Inter,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.5}
button,input{font:inherit}button{cursor:pointer}:focus-visible{outline:3px solid rgba(23,106,75,.24);outline-offset:2px}
.hidden{display:none!important}
.header{background:var(--panel);border-bottom:1px solid var(--line);padding:16px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}
.header h1{font-size:22px;margin:0;letter-spacing:-.02em}
.header a{color:var(--muted);font-size:12px}
.main{max-width:960px;margin:0 auto;padding:28px 20px 60px}
.auth-notice{max-width:720px;margin:28px auto 0;padding:18px 20px;border:1px solid var(--line);border-left:4px solid var(--danger);border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow)}
.auth-notice h2{font-size:17px;margin:0 0 7px}.auth-notice p{color:var(--muted);margin:0 0 13px}.auth-notice a{display:inline-block;color:#fff;background:var(--accent);border-radius:7px;padding:9px 13px;text-decoration:none;font-weight:700}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:22px 24px;margin-bottom:20px}
.card h2{font-size:16px;margin:0 0 14px;letter-spacing:-.015em}
.balance{display:flex;gap:24px;flex-wrap:wrap}
.balance-item{flex:1;min-width:140px;padding:16px;background:var(--subtle);border-radius:8px;text-align:center}
.balance-item strong{display:block;font-size:32px;letter-spacing:-.03em;line-height:1.1}
.balance-item span{display:block;color:var(--muted);font-size:11px;margin-top:6px}
.balance-item.warn strong{color:var(--danger)}
.balance-item.ok strong{color:var(--accent)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.field{display:grid;gap:6px;margin:10px 0}
.field label{font-size:12px;font-weight:700;color:#46534d}
.field input,.field select{width:100%;height:40px;border:1px solid var(--line);border-radius:7px;padding:0 10px;background:#fff;color:var(--ink);outline:none}
.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(23,106,75,.1)}
.btn{border-radius:7px;font-weight:700;padding:9px 15px;transition:.14s;border:1px solid var(--accent);background:var(--accent);color:#fff}
.btn:hover{background:var(--accent-hover)}
.btn-outline{border:1px solid var(--line);background:#fff;color:var(--ink)}
.btn-outline:hover{background:#f8faf9}
.btn-danger{border:1px solid var(--danger);background:var(--danger);color:#fff;margin-left:8px}
.btn-danger:hover{opacity:.9}
.btn:disabled{opacity:.5;cursor:default}
.code-list{display:grid;gap:6px;max-height:300px;overflow:auto}
.code-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--subtle);border-radius:7px;border:1px solid var(--line)}
.code-row b{font:bold 15px/1 monospace;letter-spacing:.04em}
.code-row span{font-size:11px;color:var(--muted)}
.code-row.redeemed{opacity:.5}
.txn-table{width:100%;font-size:12px;border-collapse:collapse}
.txn-table th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px}
.txn-table td{padding:9px 10px;border-top:1px solid var(--line)}
.txn-table .plus{color:var(--accent)}
.txn-table .minus{color:var(--danger)}
.empty{text-align:center;color:var(--muted);padding:28px}
.msg{padding:10px 12px;border-radius:7px;margin:10px 0;font-size:12px}
.msg-ok{background:var(--accent-soft);color:var(--accent)}
.msg-err{background:var(--danger-soft);color:var(--danger)}
.nav-back{margin-bottom:20px}
.nav-back a{color:var(--muted);font-size:12px}
</style></head><body>
<div class="header"><h1>💰 Otto 企业积分管理</h1><div><a href="/enterprise/admin">← 返回账号管理</a></div></div>
<section id="authNotice" class="auth-notice hidden" aria-labelledby="authTitle">
  <h2 id="authTitle">需要管理员登录</h2>
  <p id="authMessage">请先返回账号管理页完成管理员登录，再进入积分管理。</p>
  <a href="/enterprise/admin">返回管理员登录</a>
</section>
<main id="creditsContent" class="main">
  <div class="card" id="balanceCard"><h2>积分余额</h2><div class="balance"><div class="balance-item ok"><strong id="bal">--</strong><span>可用积分</span></div><div class="balance-item"><strong id="todayConsumed">--</strong><span>今日消耗</span></div><div class="balance-item"><strong id="totalConsumed">--</strong><span>累计消耗</span></div><div class="balance-item"><strong id="totalTopped">--</strong><span>累计充值</span></div></div></div>

  <div class="card"><h2>管理员直接充值</h2>
    <div style="display:flex;gap:10px;align-items:flex-end">
      <div class="field" style="flex:1;margin:0"><label>充值积分数量</label><input id="topupAmount" type="number" min="1" value="1000" placeholder="输入积分数量"></div>
      <div class="field" style="flex:1;margin:0"><label>备注</label><input id="topupNote" placeholder="充值备注（可选）"></div>
      <button id="topupButton" class="btn" type="button" style="height:40px;white-space:nowrap">确认充值</button>
    </div><div id="topupMsg"></div>
  </div>

  <div class="card"><h2>生成兑换码</h2>
    <div style="display:flex;gap:10px;align-items:flex-end">
      <div class="field" style="flex:1;margin:0"><label>单个面额</label><input id="codeAmount" type="number" min="1" value="100" placeholder="面额"></div>
      <div class="field" style="flex:0 0 80px;margin:0"><label>数量</label><input id="codeCount" type="number" min="1" max="100" value="10"></div>
      <button id="createCodesButton" class="btn" type="button" style="height:40px">生成</button>
    </div><div id="codeMsg"></div>
  </div>

  <div class="card"><h2>兑换码列表</h2>
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <button class="btn btn-outline" type="button" data-code-status="active">可用</button>
      <button class="btn btn-outline" type="button" data-code-status="redeemed">已用</button>
      <button class="btn btn-outline" type="button" data-code-status="revoked">已作废</button>
      <button class="btn btn-outline" type="button" data-code-status="">全部</button>
    </div>
    <div id="codeList" class="code-list"><div class="empty">点击上方按钮加载</div></div>
  </div>

  <div class="card"><h2>交易流水</h2>
    <div style="max-height:300px;overflow:auto"><table class="txn-table"><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>操作人</th><th>说明</th></tr></thead><tbody id="txnBody"><tr><td colspan="5" class="empty">加载中...</td></tr></tbody></table></div></div>
</main>
<script>
function $(id){return document.getElementById(id)}
const KEY='otto.enterprise.admin.session';
let TOKEN=sessionStorage.getItem(KEY)||'';
function finiteNumber(value){const number=Number(value);return Number.isFinite(number)?number:0}
function formatNumber(value){return new Intl.NumberFormat('zh-CN').format(finiteNumber(value))}
function authorizationError(message){const error=new Error(message);error.authorization=true;return error}
function requireAdminLogin(message){TOKEN='';sessionStorage.removeItem(KEY);$('authMessage').textContent=message||'请先返回账号管理页完成管理员登录，再进入积分管理。';$('authNotice').classList.remove('hidden');$('creditsContent').classList.add('hidden')}
function showCredits(){$('authNotice').classList.add('hidden');$('creditsContent').classList.remove('hidden')}
async function api(path,options){
  if(!TOKEN){requireAdminLogin('请先返回账号管理页完成管理员登录，再进入积分管理。');throw authorizationError('需要管理员登录')}
  const request=Object.assign({},options||{});
  request.headers=Object.assign({'content-type':'application/json','authorization':'Bearer '+TOKEN},request.headers||{});
  const r=await fetch(path,request);
  const data=await r.json().catch(()=>({}));
  if(r.status===401||r.status===403){requireAdminLogin('管理员登录已失效，请返回账号管理页重新登录。');throw authorizationError('管理员登录已失效')}
  if(!r.ok)throw new Error(data.error||'请求失败');
  return data
}
function msg(element,text,ok){
  const box=document.createElement('div');
  box.className='msg msg-'+(ok?'ok':'err');
  box.textContent=String(text||'');
  element.replaceChildren(box);
  setTimeout(()=>{if(element.firstChild===box)element.replaceChildren()},3000)
}
function emptyBlock(text){
  const empty=document.createElement('div');
  empty.className='empty';
  empty.textContent=text;
  return empty
}
function emptyTableRow(text){
  const row=document.createElement('tr');
  const cell=document.createElement('td');
  cell.colSpan=5;
  cell.className='empty';
  cell.textContent=text;
  row.appendChild(cell);
  return row
}
async function loadBalance(){
  try{
    const data=await api('/enterprise/credits/balance');
    $('bal').textContent=formatNumber(data.balance);
    $('todayConsumed').textContent=formatNumber(data.todayConsumed);
    $('totalConsumed').textContent=formatNumber(data.totalConsumed);
    $('totalTopped').textContent=formatNumber(data.totalToppedUp);
    const low=finiteNumber(data.balance)<finiteNumber(data.todayConsumed)*3;
    $('bal').parentElement.className='balance-item'+(low?' warn':' ok')
  }catch(error){if(!error.authorization)$('bal').textContent='ERR'}
}
async function doTopup(){
  const amount=+$('topupAmount').value;
  if(!Number.isSafeInteger(amount)||amount<=0){msg($('topupMsg'),'请输入正整数积分数量',false);return}
  try{
    await api('/enterprise/credits/topup',{method:'POST',body:JSON.stringify({amount:amount,note:$('topupNote').value})});
    msg($('topupMsg'),'充值成功',true);
    await Promise.all([loadBalance(),loadTxns()])
  }catch(error){if(!error.authorization)msg($('topupMsg'),error.message,false)}
}
async function doCreateCodes(){
  const amount=+$('codeAmount').value;
  const count=+$('codeCount').value;
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(count)||count<1||count>100){msg($('codeMsg'),'面额和数量必须是有效正整数',false);return}
  try{
    const data=await api('/enterprise/credits/redeem-codes',{method:'POST',body:JSON.stringify({creditAmount:amount,count:count})});
    const codes=Array.isArray(data.codes)?data.codes:[];
    msg($('codeMsg'),'已生成 '+codes.length+' 个兑换码',true);
    await loadCodes('active')
  }catch(error){if(!error.authorization)msg($('codeMsg'),error.message,false)}
}
function renderCodes(codes){
  const list=$('codeList');
  if(codes.length===0){list.replaceChildren(emptyBlock('暂无兑换码'));return}
  const fragment=document.createDocumentFragment();
  codes.forEach(code=>{
    const row=document.createElement('div');
    row.className='code-row'+(code.status==='active'?'':' redeemed');
    const identity=document.createElement('div');
    const codeText=document.createElement('b');
    codeText.textContent=String(code.code||'');
    const amountText=document.createElement('small');
    amountText.textContent=' '+formatNumber(code.creditAmount)+' 积分';
    identity.append(codeText,amountText);
    const actions=document.createElement('div');
    const statusText=document.createElement('span');
    statusText.textContent=String(code.status||'');
    actions.appendChild(statusText);
    if(code.redeemedBy){
      const redeemer=document.createElement('span');
      redeemer.textContent=' by '+String(code.redeemedBy);
      actions.appendChild(redeemer)
    }
    if(code.status==='active'){
      const button=document.createElement('button');
      button.type='button';
      button.className='btn btn-danger';
      button.style.fontSize='11px';
      button.style.padding='4px 8px';
      button.textContent='作废';
      const id=String(code.id||'');
      button.addEventListener('click',()=>revokeCode(id));
      actions.appendChild(button)
    }
    row.append(identity,actions);
    fragment.appendChild(row)
  });
  list.replaceChildren(fragment)
}
async function loadCodes(status){
  try{
    const suffix=status?'?status='+encodeURIComponent(status):'';
    const data=await api('/enterprise/credits/redeem-codes'+suffix);
    renderCodes(Array.isArray(data.codes)?data.codes:[])
  }catch(error){if(!error.authorization)$('codeList').replaceChildren(emptyBlock('加载失败'))}
}
async function revokeCode(id){
  try{await api('/enterprise/credits/redeem-codes/'+encodeURIComponent(id)+'/revoke',{method:'POST'});await loadCodes('active')}
  catch(error){if(!error.authorization)msg($('codeMsg'),error.message,false)}
}
function renderTransactions(rows){
  const body=$('txnBody');
  if(rows.length===0){body.replaceChildren(emptyTableRow('暂无交易记录'));return}
  const fragment=document.createDocumentFragment();
  rows.forEach(row=>{
    const tableRow=document.createElement('tr');
    const timeCell=document.createElement('td');
    timeCell.textContent=String(row.createdAt||'').slice(0,19);
    const typeCell=document.createElement('td');
    typeCell.textContent=String(row.type||'');
    const amount=finiteNumber(row.amount);
    const amountCell=document.createElement('td');
    amountCell.className=amount>=0?'plus':'minus';
    amountCell.textContent=(amount>=0?'+':'')+formatNumber(amount);
    const accountCell=document.createElement('td');
    accountCell.textContent=String(row.accountName||'-');
    const descriptionCell=document.createElement('td');
    descriptionCell.textContent=String(row.description||'');
    tableRow.append(timeCell,typeCell,amountCell,accountCell,descriptionCell);
    fragment.appendChild(tableRow)
  });
  body.replaceChildren(fragment)
}
async function loadTxns(){
  try{const data=await api('/enterprise/credits/transactions?limit=50');renderTransactions(Array.isArray(data.transactions)?data.transactions:[])}
  catch(error){if(!error.authorization)$('txnBody').replaceChildren(emptyTableRow('加载失败'))}
}
$('topupButton').addEventListener('click',doTopup);
$('createCodesButton').addEventListener('click',doCreateCodes);
document.querySelectorAll('[data-code-status]').forEach(button=>button.addEventListener('click',()=>loadCodes(button.dataset.codeStatus||'')));
async function initialize(){
  if(!TOKEN){requireAdminLogin('请先返回账号管理页完成管理员登录，再进入积分管理。');return}
  showCredits();
  await Promise.all([loadBalance(),loadCodes('active'),loadTxns()])
}
initialize();
</script></body></html>`;
}
