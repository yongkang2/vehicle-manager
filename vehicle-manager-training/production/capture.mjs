import fs from 'node:fs/promises';
import path from 'node:path';
import {CDP, ROOT, delay} from './cdp.mjs';
const directory=path.join(ROOT,'production','capture');await fs.mkdir(directory,{recursive:true});
const c=await CDP.connect();await c.prepare();await c.overlay();
const rerecord=new Set((process.env.RERECORD||'').split(','));const captures=(await fs.readFile(path.join(directory,'capture.json'),'utf8').then(JSON.parse).catch(()=>[])).filter(s=>!rerecord.has(s.name));let frame=captures.reduce((n,s)=>Math.max(n,...s.frames.map(f=>Number(path.basename(f.filename).match(/\d+/)?.[0]||0))),0),current=null,writes=[];
c.on('Page.screencastFrame',event=>{
  void c.send('Page.screencastFrameAck',{sessionId:event.sessionId});
  if(!current)return;
  const filename=path.join(directory,`frame-${String(++frame).padStart(6,'0')}.jpg`);
  const time=performance.now();
  current.frames.push({filename,time});
  writes.push(fs.writeFile(filename,Buffer.from(event.data,'base64')));
});
await c.send('Page.startScreencast',{format:'jpeg',quality:90,maxWidth:1920,maxHeight:936,everyNthFrame:1});
async function shot(){const {data}=await c.send('Page.captureScreenshot',{format:'jpeg',quality:94,captureBeyondViewport:false});const filename=path.join(directory,`frame-${String(++frame).padStart(6,'0')}.jpg`);current.frames.push({filename,time:performance.now()});await fs.writeFile(filename,Buffer.from(data,'base64'));}
async function segment(name,fn,hold=700){if(captures.some(s=>s.name===name)){console.log('SKIP',name);return;}current={name,start:performance.now(),frames:[]};console.log('SCENE',name);await shot();try{await fn();await delay(hold);await shot();current.end=performance.now();captures.push(current);await fs.writeFile(path.join(directory,'capture.json'),JSON.stringify(captures,null,2));}catch(error){await c.screenshot(path.join(directory,'error.png'));console.error(await c.eval('document.body.innerText'));throw error;}finally{current=null;}}
async function hover(selector){const r=await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);if(r)await c.eval(`window.__trainingCursor?.(${r.x},${r.y},false)`);}
async function outline(selector){await c.eval(`(()=>{document.querySelectorAll('[data-training-focus]').forEach(e=>{e.style.outline='';e.removeAttribute('data-training-focus')});const e=document.querySelector(${JSON.stringify(selector)});if(e){e.scrollIntoView({block:'center',behavior:'smooth'});e.style.outline='3px solid #ffb703';e.style.outlineOffset='4px';e.setAttribute('data-training-focus','')}})()`);await delay(400);}
async function clearFocus(){await c.eval(`document.querySelectorAll('[data-training-focus]').forEach(e=>{e.style.outline='';e.removeAttribute('data-training-focus')})`);}
async function tab(text){await c.clickText(text,'[role="tab"]');await delay(250);}
async function buttonContaining(text){const s=await c.eval(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.includes(${JSON.stringify(text)})&&e.getBoundingClientRect().width);if(!e)throw Error('Missing button '+${JSON.stringify(text)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await c.clickXY(s.x,s.y);}
async function closeModal(){await c.click('.ant-modal-wrap:not([style*="display: none"]) .ant-modal-close');}
async function nav(text){await c.clickText(text,'.sidebar nav button');await delay(500);}
const helpers={c,segment,delay,hover,outline,clearFocus,tab,buttonContaining,closeModal,nav,ROOT};
try{
 const stage=process.argv[2]||'1';const flow=await import(`./flow-${stage}.mjs?`+Date.now());await flow.run(helpers);
}finally{await c.send('Page.stopScreencast');await Promise.all(writes);await fs.writeFile(path.join(directory,'capture.json'),JSON.stringify(captures,null,2));c.close();console.log(`Captured ${captures.length} scenes, ${frame} frames`);}
