const output=document.createElement('pre');output.style='position:fixed;z-index:99999;background:white;color:black;top:0;left:0;max-height:40vh;overflow:auto';document.body.append(output);
function report(s){if(output.textContent.length<10000)output.textContent+='\n'+s}
const rawError=console.error;console.error=(...a)=>{report('CONSOLE '+a.map(String).join(' '));rawError(...a)};
window.addEventListener('error',e=>report(e.error?.stack||e.message));
window.addEventListener('unhandledrejection',e=>report(e.reason?.stack||e.reason));
(async()=>{
const cc=await System.import('cc');window.addEventListener('error',()=>cc.game.pause(),{once:true});
// The isolated verification copy does not contact the project's runtime inspector.
window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=3;}close(){}send(){}};
const capture=await cc.createSceneTraceArchiveCapture();
const app=new (await System.import('./application.js')).Application();await app.init(cc);
const originalInit=cc.game.init.bind(cc.game);
cc.game.init=(options)=>originalInit({...options,trace:{maxCommands:200000,archive:capture.writer}});
cc.director.on(cc.Director.EVENT_AFTER_SCENE_LAUNCH,()=>{const Type=cc.js.getClassByName('RandomSpheres');const c=Type&&cc.director.getScene().getComponentInChildren(Type);if(c&&!cc.getWorkerCapabilities){c.mode=0;report('Worker feature absent in checkout: verification uses MAIN_THREAD, count='+c.count)}});
let frames=0;
cc.director.on(cc.Director.EVENT_AFTER_DRAW,()=>{if(cc.traceRuntime.recording && ++frames===3){cc.stopSceneTrace();cc.game.pause();setTimeout(finish,0)}});
async function finish(){try{
report('Recorded; waiting for storage '+JSON.stringify(capture.status));await capture.drain();const pair=await capture.read();
const parsed=cc.readTraceArchive(pair.text,pair.binary);report('Commands '+parsed.file.commands.length+'; unsupported '+JSON.stringify(parsed.file.commands.filter(c=>c.unsupported).slice(0,5)));
cc.director.root.frameMove(0); const beforeImage=document.getElementById('GameCanvas').toDataURL();
const before=cc.director.getScene().getComponentsInChildren(cc.MeshRenderer).length;
const player=cc.openSceneTraceArchive(pair.text,pair.binary);report('Baseline restored');
while(!player.done&&!player.halted){player.stepFrame();await new Promise(r=>setTimeout(r,0));}
report('Replay: '+player.cursor+'/'+player.file.commands.length+' halted='+player.halted+' '+JSON.stringify(player.lastStep));
cc.director.root.frameMove(0);report('Canvas pixels equal '+(beforeImage===document.getElementById('GameCanvas').toDataURL()));
report('MeshRenderer count '+cc.director.getScene().getComponentsInChildren(cc.MeshRenderer).length+' expected '+before);
}catch(e){report(e.stack)}}
report('Starting actual published scene');await app.start();
})().catch(e=>report(e.stack));
