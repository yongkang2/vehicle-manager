export async function run({c,segment,delay,outline,clearFocus,tab,closeModal,nav,ROOT}){
 await segment('18',async()=>{await c.click('.ant-drawer-close');await c.type('input[aria-label="搜索"]','演示车 A01');await c.clickText('演示车 A01','strong');await tab('部件清单');},700);
 await segment('19',async()=>{await c.click('button[aria-label="更多 VCU"]');await delay(450);await c.clickText('取消','.ant-modal-footer button');},700);
 await segment('20',async()=>{await tab('改装记录');await delay(700);await tab('车载设备');},700);
 await segment('21',async()=>{await tab('附件');await outline('.ant-drawer .ant-upload');},700);
 await segment('22',async()=>{await clearFocus();await c.click('.ant-drawer-close');await nav('DOVE 导入');await c.files('input[type="file"][multiple]',[ROOT+'/production/fixtures/DOVE_demo_before.xlsx',ROOT+'/production/fixtures/DOVE_demo_after.xlsx']);},700);
 await segment('23',async()=>{await outline('.dove-batch-toolbar .muted');},700);
 await segment('24',async()=>{await clearFocus();await c.clickText('上传并预览 (2)');await delay(2000);},700);
 await segment('25',async()=>{await outline('.dove-import-confirm-file .ant-descriptions');},700);
 await segment('26',async()=>{await clearFocus();await c.eval(`document.querySelectorAll('.dove-import-confirm-file')[1].scrollIntoView({block:'start',behavior:'smooth'})`);await delay(500);},700);
 await segment('27',async()=>{await outline('.ant-modal-footer .ant-btn-primary');},700);
 await segment('28',async()=>{await clearFocus();await outline('.dove-import-confirm-file .ant-checkbox-wrapper');},700);
 await segment('29',async()=>{await clearFocus();await c.eval(`document.querySelectorAll('.dove-import-confirm-file')[1].querySelector('.ant-table').scrollIntoView({block:'center',behavior:'smooth'})`);await delay(500);},700);
 await segment('30',async()=>{await c.eval(`(()=>{const e=[...document.querySelectorAll('.dove-import-confirm-file .ant-tag')].find(e=>e.textContent==='保留当前值');e?.scrollIntoView({block:'center',behavior:'smooth'});if(e)e.style.outline='3px solid #ffb703'})()`);},700);
 await segment('31',async()=>{await c.click('.dove-import-confirm-file .ant-checkbox-wrapper',1);await delay(500);},700);
 await segment('32',async()=>{await c.click('.ant-modal-footer .ant-btn-primary');await delay(1500);await outline('.dove-batch-table');},1000);
}
