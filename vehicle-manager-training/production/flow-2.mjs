export async function run({c,segment,delay,outline,clearFocus,tab}){
 await segment('10',async()=>{await c.click('.ant-drawer-close');await c.type('input[aria-label="搜索"]','');await c.eval(`document.querySelector('.ant-select-clear')?.click()`);await c.clickText('新增车辆');},500);
 await segment('11',async()=>{await c.type('#business-record_vin','TEST0000000000003');await outline('#business-record_vin');},600);
 await segment('12',async()=>{await clearFocus();await c.click('#business-record_status');await delay(300);await c.clickText('可用','.ant-select-item-option-content');},500);
 await segment('13',async()=>{await c.type('#business-record_name','培训演示车');await c.type('#business-record_physicalLocation','演示车间 A 区');await outline('#business-record_physicalLocation');},500);
 await segment('14',async()=>{await clearFocus();await c.type('#business-record_project','DEMO');await c.type('#business-record_model','培训车型 C');await c.type('#business-record_owner','演示成员');},400);
 await segment('15',async()=>{await c.type('#business-record_reason','培训演示：首次建立车辆档案');await outline('#business-record_reason');},600);
 await segment('16',async()=>{await clearFocus();await c.click('.ant-modal-footer .ant-btn-primary');await delay(800);await c.type('input[aria-label="搜索"]','培训演示车');},700);
 await segment('17',async()=>{await c.clickText('培训演示车','strong');await c.click('button[aria-label="编辑 培训演示车"]');await c.type('#business-record_physicalLocation','演示车间 B 区');await c.type('#business-record_reason','培训演示：车辆移位');await c.click('.ant-modal-footer .ant-btn-primary');await delay(600);},800);
}
