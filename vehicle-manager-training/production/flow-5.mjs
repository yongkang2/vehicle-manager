import fs from 'node:fs/promises';
import path from 'node:path';
export async function run({c,segment,delay,clearFocus,nav,ROOT}){
 await c.eval(`document.querySelector('.personal-drawer .ant-drawer-close')?.click()`);await delay(400);
 await segment('43',async()=>{await c.click('button[aria-label="个人工作空间"]');await delay(350);await c.clickText('恢复团队同步','.personal-drawer button');await delay(350);await c.click('.ant-modal-confirm-btns .ant-btn-primary');await delay(500);await c.click('.personal-drawer .ant-drawer-close');},700);
 const result=await c.eval(`(async()=>{const s=await(await fetch('/api/status')).json();const r=await fetch('/api/business/sync',{method:'POST',headers:{'X-App-Request':'vehicle-manager','X-Workspace-Token':s.workspaceToken}});if(!r.ok)throw Error(await r.text());return r.json()})()`);
 if(result.pending||result.conflicts.length)throw Error('Demo still has pending/conflicts');
 await segment('44',async()=>{await clearFocus();await nav('共享同步');await delay(350);await nav('车辆总览');await c.type('input[aria-label="搜索"]','');},1500);
 await fs.writeFile(path.join(ROOT,'production/final-demo-sync.json'),JSON.stringify(result,null,2));
}
