/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 园区资源管理后台。页面只保存管理员短期会话到 sessionStorage；
 * 会议室、停车位等真实数据全部由 enterprise API 持久化。
 */

export function parkAdminHTML(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Otto 园区服务后台</title>
<style>
:root{--ink:#17211d;--muted:#66716b;--line:#d9e1dd;--paper:#f3f6f4;--panel:#fff;--accent:#176a4b;--accent-dark:#10553b;--soft:#e6f1eb;--danger:#a33e35;--shadow:0 18px 50px rgba(18,36,28,.12)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}button,input,textarea{font:inherit}button{cursor:pointer}.hidden{display:none!important}
.shell{min-height:100vh;display:grid;grid-template-columns:246px minmax(0,1fr)}.rail{position:sticky;top:0;height:100vh;padding:28px 22px;background:#14241d;color:#edf5f1;display:flex;flex-direction:column}.brand{font-size:26px;font-weight:900;letter-spacing:-.05em}.brand b{color:#68d1a7}.rail h1{font-size:22px;line-height:1.25;margin:34px 0 8px}.rail p{color:#9cafA5;font-size:12px;margin:0}.nav{margin-top:30px;display:grid;gap:7px}.nav a{color:#d5e2dc;text-decoration:none;padding:10px 11px;border:1px solid #30483d;border-radius:9px}.nav a.active{background:#203a2f;border-color:#456657;color:#fff}.rail-foot{margin-top:auto;display:grid;gap:10px}.rail-foot a,.rail-foot button{color:#aebfb6;background:none;border:0;text-decoration:none;text-align:left;padding:0}.rail-foot a:hover,.rail-foot button:hover{color:#fff}
.workspace{padding:32px clamp(22px,4vw,58px) 60px;min-width:0}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:23px}.eyebrow{font-size:10px;letter-spacing:.16em;font-weight:850;color:var(--accent);text-transform:uppercase}.top h2{font-size:31px;line-height:1.15;letter-spacing:-.045em;margin:5px 0}.top p{color:var(--muted);margin:0}.status{border-radius:999px;padding:7px 11px;background:var(--soft);color:#245d47;font-size:12px;font-weight:750}
.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;box-shadow:0 1px 2px rgba(18,36,28,.04)}.login{max-width:560px;padding:27px}.login h3{font-size:22px;margin:0 0 6px}.login p{color:var(--muted);margin:0 0 20px}.grid{display:grid;grid-template-columns:minmax(280px,.72fr) minmax(0,1.28fr);gap:16px;align-items:start}.settings,.room-form{padding:21px}.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:17px}.card-head h3{font-size:19px;margin:0}.card-head p{color:var(--muted);font-size:12px;margin:3px 0 0}.field{display:grid;gap:6px;margin-bottom:13px}.field label{font-size:12px;font-weight:750;color:#46524c}.field input,.field textarea{width:100%;border:1px solid #cbd5d0;border-radius:9px;background:#fff;padding:10px 11px;outline:none}.field input{height:43px}.field textarea{resize:vertical}.field input:focus,.field textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(23,106,75,.11)}.check{display:flex;align-items:center;gap:8px;margin:3px 0 16px}.check input{width:17px;height:17px}.actions{display:flex;gap:9px;flex-wrap:wrap}.primary,.secondary,.danger{min-height:41px;border-radius:8px;padding:0 15px;font-weight:760}.primary{border:1px solid var(--accent);background:var(--accent);color:#fff}.primary:hover{background:var(--accent-dark)}.secondary{border:1px solid #cbd5d0;background:#fff;color:var(--ink)}.secondary:hover{background:#f7faf8}.danger{border:1px solid #dfb3ae;background:#fff;color:var(--danger)}button:disabled{opacity:.55;cursor:default}
.notice,.error{padding:10px 12px;border-radius:8px;margin:12px 0}.notice{background:var(--soft);color:#245d47;border:1px solid #cfe3d8}.error{background:#faece9;color:var(--danger);border:1px solid #ecc8c2}.rooms{grid-column:1/-1;padding:21px}.room-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.room{border:1px solid var(--line);border-radius:11px;overflow:hidden;background:#fff}.room-image{aspect-ratio:16/9;background:linear-gradient(135deg,#dce9e2,#b9cec2);display:grid;place-items:center;color:#3c5d4d;font-weight:800;overflow:hidden}.room-image img{width:100%;height:100%;display:block;object-fit:cover}.room-body{padding:14px}.room-title{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.room-title strong{font-size:16px}.badge{font-size:10px;border-radius:999px;padding:3px 7px;background:var(--soft);color:#245d47;white-space:nowrap}.badge.off{background:#ecefed;color:#68716d}.room-meta{color:var(--muted);font-size:12px;margin:7px 0}.tags{display:flex;gap:5px;flex-wrap:wrap;margin:9px 0 13px}.tag{font-size:10px;border-radius:5px;background:#edf2ef;padding:3px 6px;color:#53605a}.empty{padding:36px;text-align:center;color:var(--muted);border:1px dashed #cbd5d0;border-radius:10px}
.availability{grid-column:1/-1;padding:21px}.availability-toolbar{display:flex;align-items:flex-end;gap:12px;margin-bottom:16px}.availability-toolbar .field{margin:0;min-width:230px}.slot-grid{display:grid;gap:9px}.slot-row{display:grid;grid-template-columns:minmax(140px,1fr) repeat(2,minmax(180px,.7fr));gap:9px;align-items:stretch}.slot-room{display:grid;align-content:center;padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:#f7faf8}.slot-room strong{font-size:14px}.slot-room span{color:var(--muted);font-size:11px}.slot{display:grid;gap:3px;align-content:center;min-height:58px;padding:9px 12px;border-radius:9px;border:1px solid transparent;color:#fff;text-align:left}.slot strong{font-size:12px}.slot span{font-size:10px;opacity:.9}.slot.available{background:#258254;border-color:#3a9669}.slot.booked{background:#b94842;border-color:#cd5a53}.slot.closed{background:#717976;border-color:#858d89}.slot.booked:disabled{opacity:1}.slot-legend{display:flex;gap:14px;color:var(--muted);font-size:11px;margin-top:12px}.slot-legend b{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}.slot-legend .green{background:#258254}.slot-legend .red{background:#b94842}.slot-legend .gray{background:#717976}
.image-preview{aspect-ratio:16/9;border:1px dashed #bdcbc4;border-radius:9px;background:#edf3f0;display:grid;place-items:center;color:#617169;overflow:hidden;margin-bottom:10px}.image-preview img{width:100%;height:100%;object-fit:cover}.file{font-size:12px}.login-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.login-fields .field{margin:0}.login-actions{display:flex;align-items:flex-end;gap:10px;margin-top:14px}
@media(max-width:1050px){.grid{grid-template-columns:1fr}.rooms,.availability{grid-column:auto}.room-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.shell{display:block}.rail{position:relative;height:auto}.rail p,.nav{display:none}.rail-foot{margin-top:18px}.workspace{padding:22px 15px 40px}.top{align-items:flex-start;flex-direction:column}.room-grid,.login-fields,.slot-row{grid-template-columns:1fr}.availability-toolbar{align-items:stretch;flex-direction:column}.availability-toolbar .field{min-width:0;width:100%}}
</style>
</head>
<body>
<main class="shell">
  <aside class="rail">
    <div class="brand">otto<b>✦</b></div>
    <h1>园区服务后台</h1>
    <p>管理会议室、停车资源和用户端可见信息。宏创服务器到位后，本页面原样迁移。</p>
    <nav class="nav"><a class="active" href="#resources">资源设置</a><a href="/enterprise/admin">企业账号与人员</a></nav>
    <div class="rail-foot"><button id="logout" type="button">退出管理员身份</button><a href="/enterprise/admin">返回账号管理</a></div>
  </aside>
  <section class="workspace">
    <header class="top"><div><div class="eyebrow">PARK OPERATIONS</div><h2>园区资源设置</h2><p>这里是园区内部后台，普通 Otto 用户不会看到。</p></div><span id="status" class="status">等待登录</span></header>

    <section id="loginCard" class="card login">
      <h3>管理员登录</h3><p>使用企业管理员账号登录。与企业账号后台共用同一套身份。</p>
      <form id="loginForm">
        <div class="login-fields">
          <div class="field"><label for="identifier">账号或手机号</label><input id="identifier" autocomplete="username" required></div>
          <div class="field"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" minlength="8" required></div>
        </div>
        <div class="login-actions"><button id="loginButton" class="primary" type="submit">进入园区后台</button></div>
        <div id="loginError" class="error hidden" role="alert"></div>
      </form>
    </section>

    <section id="content" class="grid hidden">
      <form id="settingsForm" class="card settings">
        <div class="card-head"><div><h3>停车资源</h3><p>用户办理停车位时可看到园区总车位数。</p></div></div>
        <div class="field"><label for="parkingTotal">园区总车位数</label><input id="parkingTotal" type="number" min="0" max="100000" step="1" required></div>
        <div class="field"><label for="parkingNote">停车说明</label><textarea id="parkingNote" rows="4" placeholder="例如：固定车位需由客服确认，新能源车位优先分配。"></textarea></div>
        <button class="primary" type="submit">保存停车设置</button>
        <div id="settingsNotice" class="notice hidden" role="status"></div>
      </form>

      <form id="roomForm" class="card room-form">
        <div class="card-head"><div><h3 id="roomFormTitle">新增会议室</h3><p>保存后立即出现在 Otto 会议室预约页面。</p></div><button id="resetRoom" class="secondary" type="button">清空</button></div>
        <input id="roomId" type="hidden">
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label for="roomName">会议室名称</label><input id="roomName" placeholder="例如：创新厅" required></div>
          <div class="field"><label for="roomLocation">位置</label><input id="roomLocation" placeholder="例如：A 座 2 层" required></div>
          <div class="field"><label for="roomCapacity">容纳人数</label><input id="roomCapacity" type="number" min="1" max="1000" value="12" required></div>
          <div class="field"><label for="roomHours">开放时间</label><input id="roomHours" value="工作日 09:00–18:00"></div>
        </div>
        <div class="field"><label for="roomEquipment">设备（用逗号分隔）</label><input id="roomEquipment" value="投屏，视频会议，白板"></div>
        <div class="field"><label for="roomImage">会议室照片</label><div id="imagePreview" class="image-preview">未上传时使用 Otto 默认会议室图片</div><input id="roomImage" class="file" type="file" accept="image/png,image/jpeg,image/webp"></div>
        <label class="check"><input id="roomEnabled" type="checkbox" checked>用户端可预约</label>
        <div class="actions"><button id="saveRoom" class="primary" type="submit">保存会议室</button><button id="deleteRoom" class="danger hidden" type="button">删除会议室</button></div>
        <div id="roomNotice" class="notice hidden" role="status"></div>
        <div id="roomError" class="error hidden" role="alert"></div>
      </form>

      <section class="card rooms">
        <div class="card-head"><div><h3>会议室清单</h3><p>点击卡片可编辑；停用后的会议室不会出现在用户端。</p></div><span id="roomCount" class="status">0 间</span></div>
        <div id="roomGrid" class="room-grid"></div>
      </section>

      <section class="card availability">
        <div class="card-head"><div><h3>发布可预约时间</h3><p>选择日期后，点击灰色时段可开放为绿色；点击绿色可关闭。红色代表用户已经预约，不能关闭。</p></div><span id="slotStatus" class="status">等待选择日期</span></div>
        <div class="availability-toolbar">
          <div class="field"><label for="slotDate">预约日期（只能选择未来日期）</label><input id="slotDate" type="date"></div>
          <button id="openAllSlots" class="primary" type="button">开放当日全部时段</button>
          <button id="closeAllSlots" class="secondary" type="button">关闭当日未预约时段</button>
        </div>
        <div id="slotGrid" class="slot-grid"></div>
        <div class="slot-legend"><span><b class="green"></b>绿色：可预约</span><span><b class="red"></b>红色：已预约</span><span><b class="gray"></b>灰色：未开放</span></div>
        <div id="slotNotice" class="notice hidden" role="status"></div>
      </section>
    </section>
  </section>
</main>
<script>
const KEY='otto.enterprise.admin.session';
const $=id=>document.getElementById(id);
let token=sessionStorage.getItem(KEY)||'';
let rooms=[];
let slots=[];
let currentImageUrl=null;
function localDate(offset){const date=new Date();date.setHours(12,0,0,0);date.setDate(date.getDate()+offset);return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0')}
function show(id,message){const el=$(id);el.textContent=message||'';el.classList.toggle('hidden',!message)}
function headers(){return {'Content-Type':'application/json','X-Otto-Admin-Token':token}}
async function api(path,options){const response=await fetch(path,{...options,headers:{...headers(),...(options&&options.headers||{})}});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error||'请求失败');error.status=response.status;throw error}return data}
function setLoggedIn(value){$('loginCard').classList.toggle('hidden',value);$('content').classList.toggle('hidden',!value);$('status').textContent=value?'园区管理员已登录':'等待登录'}
function resetRoom(){currentImageUrl=null;$('roomId').value='';$('roomName').value='';$('roomLocation').value='';$('roomCapacity').value='12';$('roomHours').value='工作日 09:00–18:00';$('roomEquipment').value='投屏，视频会议，白板';$('roomEnabled').checked=true;$('roomImage').value='';$('roomFormTitle').textContent='新增会议室';$('saveRoom').textContent='保存会议室';$('deleteRoom').classList.add('hidden');$('imagePreview').replaceChildren(document.createTextNode('未上传时使用 Otto 默认会议室图片'));show('roomNotice','');show('roomError','')}
function imageNode(room){const wrap=document.createElement('div');wrap.className='room-image';if(room.imageUrl){const img=document.createElement('img');img.src=room.imageUrl;img.alt=room.name+'照片';wrap.appendChild(img)}else{wrap.textContent='Otto 默认会议室图片'}return wrap}
function renderRooms(){const grid=$('roomGrid');grid.replaceChildren();$('roomCount').textContent=rooms.length+' 间';if(!rooms.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='还没有会议室，请在上方创建。';grid.appendChild(empty);return}rooms.forEach(room=>{const card=document.createElement('article');card.className='room';card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label','编辑会议室：'+room.name);card.appendChild(imageNode(room));const body=document.createElement('div');body.className='room-body';const title=document.createElement('div');title.className='room-title';const strong=document.createElement('strong');strong.textContent=room.name;const badge=document.createElement('span');badge.className='badge'+(room.enabled?'':' off');badge.textContent=room.enabled?'可预约':'已停用';title.append(strong,badge);const meta=document.createElement('div');meta.className='room-meta';meta.textContent=room.location+' · '+room.capacity+' 人 · '+room.priceHalfDay+' 元/半天 · '+(room.openingHours||'开放时间待定');const tags=document.createElement('div');tags.className='tags';room.equipment.forEach(text=>{const tag=document.createElement('span');tag.className='tag';tag.textContent=text;tags.appendChild(tag)});const edit=document.createElement('button');edit.className='secondary';edit.type='button';edit.textContent='编辑';edit.addEventListener('click',event=>{event.stopPropagation();editRoom(room)});body.append(title,meta,tags,edit);card.appendChild(body);card.addEventListener('click',()=>editRoom(room));card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();editRoom(room)}});grid.appendChild(card)})}
function renderSlots(){const grid=$('slotGrid');grid.replaceChildren();const activeRooms=rooms.filter(room=>room.enabled);$('slotStatus').textContent=$('slotDate').value+' · '+slots.filter(slot=>slot.status==='available').length+' 个可预约时段';if(!activeRooms.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='还没有启用的会议室。';grid.appendChild(empty);return}activeRooms.forEach(room=>{const row=document.createElement('div');row.className='slot-row';const info=document.createElement('div');info.className='slot-room';const name=document.createElement('strong');name.textContent=room.name;const meta=document.createElement('span');meta.textContent=room.capacity+' 人 · '+room.priceHalfDay+' 元/半天';info.append(name,meta);row.appendChild(info);['morning','afternoon'].forEach(slotKey=>{const slot=slots.find(item=>item.roomId===room.id&&item.slotKey===slotKey);const status=slot&&slot.status||'closed';const button=document.createElement('button');button.type='button';button.className='slot '+status;button.disabled=status==='booked';const label=document.createElement('strong');label.textContent=slotKey==='morning'?'上午 09:00–12:00':'下午 14:00–18:00';const state=document.createElement('span');state.textContent=status==='available'?'可预约 · 点击关闭':status==='booked'?'已预约 · 不可关闭':'未开放 · 点击开放';button.append(label,state);button.addEventListener('click',()=>setSlot(room.id,slotKey,status!=='available'));row.appendChild(button)});grid.appendChild(row)})}
async function loadSlots(){const date=$('slotDate').value;if(!date)return;try{const data=await api('/enterprise/park-meeting-slots?from='+encodeURIComponent(date)+'&to='+encodeURIComponent(date));slots=data.meetingSlots||[];renderSlots()}catch(error){show('slotNotice',error.message)}}
async function setSlot(roomId,slotKey,enabled){show('slotNotice','');try{await api('/enterprise/park-meeting-slots',{method:'PUT',body:JSON.stringify({roomId,date:$('slotDate').value,slotKey,enabled})});await loadSlots();show('slotNotice',enabled?'时段已开放，用户端显示为绿色。':'时段已关闭，用户端显示为灰色。')}catch(error){show('slotNotice',error.message)}}
async function setAllSlots(enabled){const targets=[];rooms.filter(room=>room.enabled).forEach(room=>['morning','afternoon'].forEach(slotKey=>{const slot=slots.find(item=>item.roomId===room.id&&item.slotKey===slotKey);if(!slot||slot.status!=='booked')targets.push(setSlot(room.id,slotKey,enabled))}));await Promise.all(targets);await loadSlots()}
function editRoom(room){$('roomId').value=room.id;$('roomName').value=room.name;$('roomLocation').value=room.location;$('roomCapacity').value=String(room.capacity);$('roomHours').value=room.openingHours||'';$('roomEquipment').value=room.equipment.join('，');$('roomEnabled').checked=room.enabled;currentImageUrl=room.imageUrl||null;$('roomFormTitle').textContent='编辑会议室';$('saveRoom').textContent='保存修改';$('deleteRoom').classList.remove('hidden');$('roomImage').value='';const preview=$('imagePreview');preview.replaceChildren();if(currentImageUrl){const img=document.createElement('img');img.src=currentImageUrl;img.alt=room.name+'照片预览';preview.appendChild(img)}else preview.textContent='当前使用 Otto 默认会议室图片';$('roomForm').scrollIntoView({behavior:'smooth',block:'start'})}
async function compressImage(file){if(!file)return null;if(!/^image\\/(png|jpeg|webp)$/.test(file.type))throw new Error('请选择 PNG、JPG 或 WebP 图片');const source=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file)});const image=await new Promise((resolve,reject)=>{const item=new Image();item.onload=()=>resolve(item);item.onerror=()=>reject(new Error('图片无法打开'));item.src=source});const maxWidth=1280,maxHeight=720,scale=Math.min(1,maxWidth/image.width,maxHeight/image.height);const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const output=canvas.toDataURL('image/jpeg',.78);if(output.length>850000)throw new Error('图片压缩后仍过大，请选择更小的照片');return output}
async function load(){try{const [settingsData,roomsData]=await Promise.all([api('/enterprise/park-settings'),api('/enterprise/park-meeting-rooms')]);$('parkingTotal').value=String(settingsData.settings.parkingTotal);$('parkingNote').value=settingsData.settings.parkingNote||'';rooms=roomsData.meetingRooms||[];renderRooms();setLoggedIn(true);await loadSlots()}catch(error){if(error.status===401||error.status===403){token='';sessionStorage.removeItem(KEY);setLoggedIn(false);show('loginError','请使用企业管理员账号登录')}else{show('loginError',error.message)}}}
$('loginForm').addEventListener('submit',async event=>{event.preventDefault();show('loginError','');$('loginButton').disabled=true;try{const data=await fetch('/enterprise/auth/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:$('identifier').value.trim(),password:$('password').value})}).then(async response=>{const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'登录失败');return body});token=data.token;sessionStorage.setItem(KEY,token);$('password').value='';await load()}catch(error){show('loginError',error.message)}finally{$('loginButton').disabled=false}});
$('logout').addEventListener('click',()=>{token='';sessionStorage.removeItem(KEY);setLoggedIn(false);show('loginError','已退出园区管理员身份')});
$('settingsForm').addEventListener('submit',async event=>{event.preventDefault();show('settingsNotice','');try{const data=await api('/enterprise/park-settings',{method:'PUT',body:JSON.stringify({parkingTotal:Number($('parkingTotal').value),parkingNote:$('parkingNote').value})});$('parkingTotal').value=String(data.settings.parkingTotal);show('settingsNotice','停车设置已保存，Otto 用户端刷新后即可看到。')}catch(error){show('settingsNotice',error.message)}});
$('roomImage').addEventListener('change',async()=>{show('roomError','');try{currentImageUrl=await compressImage($('roomImage').files[0]);const preview=$('imagePreview');preview.replaceChildren();if(currentImageUrl){const img=document.createElement('img');img.src=currentImageUrl;img.alt='会议室照片预览';preview.appendChild(img)}}catch(error){currentImageUrl=null;$('roomImage').value='';show('roomError',error.message)}});
$('roomForm').addEventListener('submit',async event=>{event.preventDefault();show('roomNotice','');show('roomError','');$('saveRoom').disabled=true;const id=$('roomId').value;const payload={name:$('roomName').value,location:$('roomLocation').value,capacity:Number($('roomCapacity').value),openingHours:$('roomHours').value,equipment:$('roomEquipment').value.split(/[，,]/).map(item=>item.trim()).filter(Boolean),imageUrl:currentImageUrl,enabled:$('roomEnabled').checked};try{await api(id?'/enterprise/park-meeting-rooms/'+encodeURIComponent(id):'/enterprise/park-meeting-rooms',{method:id?'PUT':'POST',body:JSON.stringify(payload)});show('roomNotice',id?'会议室修改已保存。':'会议室已创建。');const data=await api('/enterprise/park-meeting-rooms');rooms=data.meetingRooms||[];renderRooms();resetRoom()}catch(error){show('roomError',error.message)}finally{$('saveRoom').disabled=false}});
$('deleteRoom').addEventListener('click',async()=>{const id=$('roomId').value;if(!id||!confirm('确认删除这间会议室？已经提交的历史预约单不会被删除。'))return;try{await api('/enterprise/park-meeting-rooms/'+encodeURIComponent(id),{method:'DELETE'});const data=await api('/enterprise/park-meeting-rooms');rooms=data.meetingRooms||[];renderRooms();resetRoom()}catch(error){show('roomError',error.message)}});
$('slotDate').min=localDate(1);$('slotDate').max=localDate(30);$('slotDate').value=localDate(1);$('slotDate').addEventListener('change',()=>{void loadSlots()});
$('openAllSlots').addEventListener('click',()=>{void setAllSlots(true)});$('closeAllSlots').addEventListener('click',()=>{void setAllSlots(false)});
$('resetRoom').addEventListener('click',resetRoom);
resetRoom();if(token)load();else setLoggedIn(false);
</script>
</body>
</html>`;
}
