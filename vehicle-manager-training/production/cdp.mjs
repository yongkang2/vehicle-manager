import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../package.json',import.meta.url));
const WebSocket=require('ws');
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export class CDP {
  constructor(ws){this.ws=ws;this.n=0;this.pending=new Map();this.handlers=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}else for(const f of this.handlers.get(m.method)||[])f(m.params);});}
  static async connect(port=19422){const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const target=targets.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:14410'))||targets.find(t=>t.type==='page'&&t.url==='about:blank')||targets.find(t=>t.type==='page');const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});return new CDP(ws);}
  on(name,handler){if(!this.handlers.has(name))this.handlers.set(name,[]);this.handlers.get(name).push(handler);}
  send(method,params={}){const id=++this.n;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.pending.delete(id))reject(new Error(`CDP timeout ${method}`))},20000).unref();});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
  async click(selector,index=0){const xy=await this.eval(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await this.clickXY(xy.x,xy.y);}
  async clickText(text,selector='button',index=0){const xy=await this.eval(`(()=>{const es=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.textContent.replace(/\\s/g,'')===${JSON.stringify(text.replace(/\s/g,''))}&&e.getBoundingClientRect().width);const e=es[${index}];if(!e)throw Error('Missing text '+${JSON.stringify(text)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await this.clickXY(xy.x,xy.y);}
  async clickXY(x,y){await this.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await this.eval(`window.__trainingCursor?.(${x},${y},true)`);await delay(160);await this.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});await delay(350);}
  async type(selector,text,index=0){await this.click(selector,index);await this.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await this.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});await this.send('Input.insertText',{text});await delay(200);}
  async screenshot(filename){const {data}=await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(filename,Buffer.from(data,'base64'));return filename;}
  async files(selector,files){const {root}=await this.send('DOM.getDocument');const {nodeId}=await this.send('DOM.querySelector',{nodeId:root.nodeId,selector});await this.send('DOM.setFileInputFiles',{nodeId,files});await delay(1000);}
  async prepare(){await this.send('Page.enable');await this.send('Page.bringToFront');await this.send('Runtime.enable');await this.send('Emulation.setDeviceMetricsOverride',{width:1600,height:780,deviceScaleFactor:1.2,mobile:false});await this.send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('vdm-language','zh');`});}
  async overlay(){await this.eval(`(()=>{document.querySelector('#training-cursor')?.remove();const c=document.createElement('div');c.id='training-cursor';c.style='position:fixed;z-index:2147483647;pointer-events:none;width:26px;height:26px;border:3px solid #ffb703;border-radius:50%;background:#ffb70333;transform:translate(-50%,-50%);transition:left .18s,top .18s;left:1860px;top:990px;box-shadow:0 0 0 4px #fff8';document.body.append(c);window.__trainingCursor=(x,y,click)=>{c.style.left=x+'px';c.style.top=y+'px';if(click){c.animate([{transform:'translate(-50%,-50%) scale(1)'},{transform:'translate(-50%,-50%) scale(1.7)'},{transform:'translate(-50%,-50%) scale(1)'}],{duration:550})}};})()`);}
  close(){this.ws.close();}
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/cdp.mjs')){
  const c=await CDP.connect(Number(process.env.CDP_PORT||19422));
  try{await c.prepare();const [cmd,...args]=process.argv.slice(2);if(cmd==='eval')console.log(JSON.stringify(await c.eval(args.join(' ')),null,2));else if(cmd==='shot')console.log(await c.screenshot(args[0]));else if(cmd==='click')await c.click(args[0],Number(args[1]||0));else if(cmd==='text')await c.clickText(args[0],args[1]||'button',Number(args[2]||0));else if(cmd==='type')await c.type(args[0],args[1],Number(args[2]||0));else if(cmd==='files')await c.files(args[0],args.slice(1));else if(cmd==='navigate'){await c.send('Page.navigate',{url:args[0]});await delay(1000);await c.overlay();}else if(cmd==='overlay')await c.overlay();}
  finally{c.close();}
}
