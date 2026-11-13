// Resume only a previously created disposable training fixture; never the user's data.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { once } from 'node:events'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')
const scratch=path.join(repo,'.runtime/training-v1.9.1')
const state=JSON.parse(await fs.readFile(path.join(scratch,'demo-state.json'),'utf8'))
const dataDir=path.resolve(state.demo,'local')
if(!dataDir.startsWith(scratch+path.sep)||state.appVersion!=='1.9.1')throw Error('Unsafe training data directory')
const appRoot=path.join(scratch,'app')
const {createApp}=await import(pathToFileURL(path.join(appRoot,'dist-server/server/app.js')))
const {BrowserPresence,installBrowserPresence}=await import(pathToFileURL(path.join(appRoot,'dist-server/server/browser-presence.js')))
const presence=new BrowserPresence({onEmpty(){}}), presenceToken=randomBytes(32).toString('hex'), controlToken=randomBytes(32).toString('hex')
let closing=false, server, dispose, timer
async function stop(){if(closing)return;closing=true;clearInterval(timer);presence.stop();dispose?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await client.close();await fs.rm(path.join(dataDir,'service.json'),{force:true});await fs.writeFile(path.join(scratch,'demo-stopped.json'),JSON.stringify({stoppedAt:new Date().toISOString(),demo:state.demo,method:'actual Stop.cmd / authenticated graceful shutdown'}));process.exit(0)}
const client=createApp({dataDir,staticDir:path.join(appRoot,'dist'),browserPresence:presence,presenceToken,controlToken,onShutdown:()=>{setTimeout(()=>void stop(),100)}})
server=client.app.listen(14411,'127.0.0.1')
dispose=installBrowserPresence(server,presence,{token:presenceToken})
if(!server.listening)await once(server,'listening')
const instanceId=createHash('sha256').update(dataDir.toLowerCase()).digest('hex')
await fs.writeFile(path.join(dataDir,'service.json'),JSON.stringify({pid:process.pid,port:14411,instanceId,controlToken,version:'1.9.1'}))
await fs.rm(path.join(scratch,'demo-stopped.json'),{force:true})
timer=setInterval(()=>{void client.tick().catch(e=>console.error(e.code||e.name))},30000).unref()
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop())
console.log(JSON.stringify({ready:true,base:state.base,version:'1.9.1',resumed:true,dataDir}))
