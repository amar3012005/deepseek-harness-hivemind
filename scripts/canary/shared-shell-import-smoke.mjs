/** Inspect actual immutable shell module namespaces without starting agent/plugin work. */
import { JSDOM } from 'jsdom'
import {readFileSync,readdirSync}from'node:fs'
import {join,resolve}from'node:path'
import {pathToFileURL}from'node:url'
import vm from'node:vm'
const root=resolve(process.argv[2]||'/opt/deepseek-harness')
const dom=new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>',{url:'https://next.singulancelabs.com/'})
for(const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','getComputedStyle'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true})
globalThis.requestAnimationFrame=f=>setTimeout(f,0);globalThis.cancelAnimationFrame=clearTimeout
const factories=new Map();let modules
const sentinel=new Error('immutable-shell-namespace-captured')
const facade={load(row){factories.set(row.id,row.factory)},create(input){modules=input.staticModules;throw sentinel}}
globalThis.__ModuleLoader__=facade;dom.window.__ModuleLoader__=facade
const errors=[];const previous=console.error;console.error=(...a)=>{if(a[0]!==sentinel)errors.push(String(a[0]))}
try{
 await import(pathToFileURL(join(root,'apps/web/dist/assets/harness-shell.js')).href)
 await dom.window.__DSH_EMBED_INITIAL_MOUNT__
 if(!modules||errors.length)throw Error('actual shell module import failed')
 const primitives=modules['@deepseek-ai/dsh-client-ui-primitives'],React=modules.react
 if(typeof primitives?.IconBellOutline16!=='function')throw Error('actual shell bell export missing')
 const {renderToStaticMarkup}=await import(pathToFileURL(join(root,'node_modules/react-dom/server.node.js')).href)
 const html=renderToStaticMarkup(React.createElement(primitives.IconBellOutline16))
 if(!html.includes('<svg'))throw Error('actual shared bell render failed')
 // Load actual compiled native module factories; never apply their plugins.
 for(const group of readdirSync(join(root,'packages'))){for(const pkg of readdirSync(join(root,'packages',group))){const base=join(root,'packages',group,pkg,'lib');for(const file of ['client.js','client/index.js']){try{const s=readFileSync(join(base,file),'utf8');if(s.includes('window.__ModuleLoader__.load('))vm.runInThisContext(s,{filename:join(base,file)})}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e}}}}
 const cache=new Map(Object.entries(modules));const inProgress=new Set();let propertyReads=0
 function requireActual(id){if(cache.has(id))return wrap(id,cache.get(id));if(inProgress.has(id))throw Error('native module cycle '+id);const f=factories.get(id);if(!f)throw Error('actual compiled dependency missing '+id);inProgress.add(id);const value=f(requireActual);inProgress.delete(id);cache.set(id,value);return wrap(id,value)}
 function wrap(id,value){if(!value||(typeof value!=='object'&&typeof value!=='function'))return value;return new Proxy(value,{get(target,key,receiver){if(typeof key==='string'&&!['__esModule','then'].includes(key)){propertyReads++;if(!(key in target))throw Error('actual dependency export missing '+id+':'+key)}return Reflect.get(target,key,receiver)}})}
 requireActual('@deepseek-ai/dsh-client-ui-chat')
 console.log(JSON.stringify({actualShellImported:true,actualSharedBellRendered:true,chatFactoryDependenciesResolved:true,dependencyPropertyReads:propertyReads,sharedPrimitiveExports:Object.keys(primitives).length,pluginWorkStarted:false}))
}finally{console.error=previous;dom.window.close()}
