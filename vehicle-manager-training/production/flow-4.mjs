import fs from 'node:fs/promises';
import path from 'node:path';
export async function run({c,segment,delay,outline,clearFocus,tab,closeModal,nav,ROOT}){
 const share=path.resolve(ROOT,'production/demo-share'),away=path.resolve(ROOT,'production/demo-share-temporarily-offline');
 if(!share.startsWith(path.resolve(ROOT,'production')+path.sep)||path.basename(share)!=='demo-share')throw Error('Unsafe demo target');
 const browserAPI=async(url,method='GET',body)=>c.eval(`(async()=>{const status=await(await fetch('/api/status')).json();const r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'X-App-Request':'vehicle-manager','X-Workspace-Token':status.workspaceToken,'Content-Type':'application/json'},${body===undefined?'':`body:JSON.stringify(${JSON.stringify(body)}),`}credentials:'same-origin'});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data})()`);
 await segment('33',async()=>{await clearFocus();await nav('报告档案');await c.clickText('DOVE_demo_after.xlsx','.record-link');},700);
 await segment('34',async()=>{await tab('故障记录 (1)');await delay(500);await tab('控制器 (3)');},700);
 await segment('35',async()=>{await closeModal();await outline('button[aria-label="下载原件"]');await c.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.resolve(ROOT,'production/downloads')});await c.click('button[aria-label="下载原件"]');},700);
 await segment('36',async()=>{await clearFocus();await c.click('input[aria-label="Select row 1"]');await c.click('input[aria-label="Select row 2"]');await c.clickText('对比两份报告');},700);
 await segment('37',async()=>{await outline('.ant-modal .ant-alert');},700);
 await segment('38',async()=>{await clearFocus();await closeModal();await nav('变更历史');await c.click('.change-entry details summary');},700);
 await segment('39',async()=>{await nav('共享同步');await c.clickText('立即同步');await delay(700);await outline('.sync-summary');},700);
 await segment('40',async()=>{await clearFocus();await outline('.sync-title');},700);
 await segment('41',async()=>{await clearFocus();await fs.rename(share,away);try{await c.click('button[aria-label="刷新"]');await delay(500);await outline('.workspace-topbar .ant-tag');await delay(800);}finally{await fs.rename(away,share);}},700);
 await segment('42',async()=>{await clearFocus();await c.click('button[aria-label="刷新"]');await nav('车辆总览');await nav('共享同步');await c.clickText('立即同步');await delay(500);await outline('.sync-summary');},700);
 console.log('Preparing genuine paused demo session through offline edit and login, off camera');
 const before=await browserAPI('/api/business/records');const car=before.find(r=>r.kind==='vehicle'&&r.data.vin==='TEST0000000000003');
 if(!car)throw Error('Training car missing');
 await fs.rename(share,away);
 try{
   await browserAPI('/api/business/records/'+car.id,'PUT',{data:{...car.data,notes:'虚构培训数据：离线修改与恢复同步示例'},version:car.version,reason:'培训演示：离线修改后核对并恢复同步'});
   const state=await browserAPI('/api/business/sync');if(!state.pending)throw Error('Expected genuine pending operation');
   await browserAPI('/api/logout','POST');
   await c.eval(`fetch('/api/login',{method:'POST',headers:{'X-App-Request':'vehicle-manager','Content-Type':'application/json'},body:JSON.stringify({username:'newcomer',password:'Training-Only-2026!'})}).then(async r=>{if(!r.ok)throw Error(await r.text());return r.json()})`);
 }finally{await fs.rename(away,share);}
 await c.send('Page.reload');await delay(1200);await c.overlay();
 const paused=await c.eval(`fetch('/api/status').then(r=>r.json()).then(s=>s.syncPaused)`);if(!paused)throw Error('Actual session not paused');
 await segment('43',async()=>{await c.click('button[aria-label="个人工作空间"]');await delay(400);await c.clickText('恢复团队同步');await c.clickText('保存','.ant-modal-confirm-btns button');await delay(500);await c.click('.personal-drawer .ant-drawer-close');},700);
 await browserAPI('/api/business/sync','POST');
 await segment('44',async()=>{await clearFocus();await nav('车辆总览');await c.type('input[aria-label="搜索"]','');},1500);
 const final=await browserAPI('/api/business/sync');await fs.writeFile(path.join(ROOT,'production/final-demo-sync.json'),JSON.stringify(final,null,2));
}
