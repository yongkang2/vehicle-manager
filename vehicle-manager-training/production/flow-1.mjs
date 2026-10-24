import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export async function run({c,segment,delay,hover,outline,clearFocus,nav,ROOT}){
 if(!process.env.TRAINING_APPROVAL_HELPER)throw Error('Set TRAINING_APPROVAL_HELPER to a reviewed helper for the disposable demo environment; the original temporary helper is not bundled.');
 await segment('01',async()=>{await hover('.auth-logo')},800);
 await segment('02',async()=>{await c.clickText('注册本地账号','[role="tab"]');await delay(600);await c.clickText('登录','[role="tab"]');await c.type('#username','newcomer');await c.type('#password','Training-Only-2026!');},400);
 await segment('03',async()=>{await c.click('button[type="submit"]');await delay(700);await c.type('input[aria-label="共享文件夹路径"]',ROOT.replaceAll('/','\\')+'\\production\\demo-share');await c.clickText('测试连接');await delay(700);},500);
 await segment('04',async()=>{await outline('.connection-result');await c.clickText('申请加入');await delay(800);},800);
 await segment('05',async()=>{await clearFocus();await delay(600);},600);
 console.log('Approving synthetic newcomer through API, off camera');
 console.log((await exec('node',[process.env.TRAINING_APPROVAL_HELPER])).stdout);
 await c.click('button[aria-label="刷新"]');await delay(1200);await c.overlay();
 await segment('06',async()=>{await outline('.workspace-topbar');},900);
 await segment('07',async()=>{await clearFocus();await outline('.sidebar nav');await hover('.sidebar nav button');},900);
 await segment('08',async()=>{await clearFocus();await c.type('input[aria-label="搜索"]','演示车 A01');await c.click('.business-filters .ant-select');await c.clickText('可用','.ant-select-item-option-content');await delay(500);},600);
 await segment('09',async()=>{await c.click('.record-link');await delay(500);},800);
}
