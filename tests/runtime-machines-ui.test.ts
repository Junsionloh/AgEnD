import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p:AppPage, Panel:any, Create:any, catalog:any, windowsCatalog:any, windowsInventory:any, models:any, app:any, routes:any, connectCommand:any;
const originalFetch=globalThis.fetch;
const idA="12345678-1234-4321-abcd-123456789012", idB="22345678-1234-4321-abcd-123456789012";
const requests:Array<{path:string;body:any}>=[];
const cli=()=>({id:"codex",path:"C:\\tools\\codex.exe",runnable:true,authenticated:true,version:"1.0",readOnlySupport:true,supports:{execution:true,resume:true,mcp:true},models:[]});
const machine=(id:string,name:string,status="online")=>({id,name,status,...(status==="pending"?{pairingFingerprint:"ABCD-1234-5678"}:{}),platform:"win32",version:"1.0",lastSeenAt:Date.now(),inventoryUpdatedAt:Date.now(),inventory:{home:`C:\\${name}`,clis:[cli(),{id:"muse",path:null,runnable:false}]}});
let machines:any[], enabled:boolean;
const response=(body:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const button=(text:string)=>p.root.querySelectorAll("button").find((item:any)=>item.textContent.trim()===text);
const choose=async(id:string)=>{const input=p.root.querySelectorAll(".agent-runtime-picker input").find((item:any)=>item.value===`machine:${id}`);input.checked=true;fire(input,"change");await settle(5);};

beforeAll(async()=>{
  p=page({url:"http://localhost/settings/runtimes",storage:{agend_lang:"en"}});
  globalThis.fetch=(async(path:string,options:any={})=>{
    const body=options.body?JSON.parse(options.body):null;requests.push({path,body});
    if(path==="/ui/runtimes")return response({enabled,machines});
    if(path==="/ui/windows-cli/probe") {
      if(body?.force) windowsInventory={...windowsInventory,hostname:"REFRESHED-DESKTOP"};
      return response(windowsInventory);
    }
    if(path==="/ui/windows-cli/tasks")return response({tasks:[]});
    const diagnostic=/^\/ui\/runtimes\/machines\/([^/]+)\/(inventory|probe|tasks)$/.exec(path);
    if(diagnostic){const target=machines.find(item=>item.id===diagnostic[1]);return response(diagnostic[2]==="tasks"?{tasks:[]}:{inventory:target?.inventory || null});}
    if(path==="/api/settings/runtimes")return response({switches:{windows_cli:{on:false,configured:false,environment:null},remote_runtime:{on:enabled,configured:enabled,environment:null}},max_agents_per_machine:{value:4,min:1,max:16,default:4},local_origin:"http://127.0.0.1:19280"});
    if(path==="/ui/runtimes/pairing")return response({pairingId:"test",code:"PAIR-TEST-CODE",expiresAt:Date.now()+60000});
    if(path===`/ui/runtimes/machines/${idB}/approve`){machines=machines.map(item=>item.id===idB?{...item,status:"online"}:item);return response({ok:true});}
    if(path.startsWith("/ui/models?")){const id=new URL(path,"http://localhost").searchParams.get("machineId");return response({models:[{id:id===idA?"model-a":"model-b",label:id===idA?"Model A":"Model B"}],source:"cli-cache"});}
    if(path==="/ui/backends")return response({backends:[{name:"claude-code",installed:true}],defaultBackend:"claude-code"});
    if(path==="/ui/instances")return response({name:"remote-agent",agent:{name:body.topic_name,cwd:body.directory || "C:\\managed"}});
    return response({});
  }) as any;
  const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});
  catalog=await import("/ui/js/runtime-catalog.js");models=await import("/ui/js/settings-catalog.js");app=await import("/assets/app-store.js");
  windowsCatalog=await import("/ui/js/windows-cli-catalog.js");
  const runtimeUi=await import("/ui/js/panel-runtimes.js");Panel=runtimeUi.RuntimesPanel;connectCommand=runtimeUi.runtimeConnectCommand;Create=(await import("/ui/js/panel-fleet.js")).CreateInstanceDialog;routes=await import("/assets/app-route.js");
});
beforeEach(()=>{requests.length=0;enabled=true;machines=[machine(idA,"Desktop"),machine(idB,"Laptop","pending")];windowsInventory={home:"C:\\Test",hostname:"WINDOWS-DESK",probedAt:1,clis:[cli()]};windowsCatalog.forgetWindowsCliCatalog();catalog.forgetRuntimeCatalog();models.forgetCatalogs();app.appStore.set({windowsCli:false});});
afterEach(async()=>{await p.unmount();catalog.forgetRuntimeCatalog();});
afterAll(()=>{p.restore();globalThis.fetch=originalFetch;});

describe("remote machine UI",()=>{
  it("identifies the host Windows computer in the local summary and actual diagnostics without running detection",async()=>{
    app.appStore.set({windowsCli:true});
    await p.mount(h(Panel,{navKey:"diagnostic-host"}));await settle(12);
    const localTarget=p.root.querySelector(".runtime-native-local .windows-cli-target-name");
    expect(localTarget).not.toBeNull();expect(localTarget.textContent).toBe("WINDOWS-DESK");
    const diagnostics=p.root.querySelector(".runtime-local-diagnostics");
    expect(diagnostics.querySelector("summary small").textContent).toBe("WINDOWS-DESK");
    const diagnosticTarget=diagnostics.querySelector(".windows-cli-target-name");
    expect(diagnosticTarget).not.toBeNull();expect(diagnosticTarget.textContent).toBe("WINDOWS-DESK");
    expect(diagnostics.querySelector(".windows-cli-target").textContent).toContain("Windows on the AgEnD host");
    expect(requests.filter(item=>item.path==="/ui/windows-cli/probe")).toHaveLength(1);
    expect(requests.some(item=>item.body?.force===true)).toBe(false);
  });
  it("keeps legacy computer names unknown until an explicit detection updates all diagnostic labels",async()=>{
    delete windowsInventory.hostname;app.appStore.set({windowsCli:true});
    await p.mount(h(Panel,{navKey:"legacy-diagnostic-host"}));await settle(12);
    const targets=()=>p.root.querySelectorAll(".windows-cli-target-name").map((item:any)=>item.textContent);
    expect(targets()).toEqual(["Computer name not reported","Computer name not reported"]);
    expect(p.root.querySelector(".runtime-local-diagnostics").textContent).toContain("Detect again to read the Windows computer name.");
    expect(requests.some(item=>item.body?.force===true)).toBe(false);
    p.root.querySelector(".windows-cli-probe").click();await settle(12);
    expect(targets()).toEqual(["REFRESHED-DESKTOP","REFRESHED-DESKTOP"]);
    expect(p.root.querySelector(".runtime-local-diagnostics summary small").textContent).toBe("REFRESHED-DESKTOP");
    expect(requests.filter(item=>item.body?.force===true)).toHaveLength(1);
  });
  it("selects paired computers and keeps diagnostic drafts, models, paths and probes on their owner",async()=>{
    app.appStore.set({windowsCli:true});machines=[machine(idA,"Desktop"),machine(idB,"Laptop")];
    machines[0].inventory.clis[0].models=[{id:"model-a",label:"Model A"}];machines[1].inventory.clis[0].models=[{id:"model-b",label:"Model B"}];
    await p.mount(h(Panel,{navKey:"diagnostic-selection"}));await settle(12);
    const select=async(id:string)=>{const picker=p.root.querySelector(".runtime-diagnostic-target select");picker.value=id;fire(picker,"change");await settle(12);};
    await select(idA);
    expect(p.root.querySelector("#windows-cwd").value).toBe("C:\\Desktop");
    expect(p.root.querySelector(".runtime-local-diagnostics .windows-cli-target-name").textContent).toBe("Desktop");
    const prompt=p.root.querySelector("#windows-prompt");prompt.value="Desktop draft";fire(prompt,"input");
    const model=p.root.querySelector("#windows-model");model.value="model-a";fire(model,"change");await settle();
    const before=requests.length;p.root.querySelector(".windows-cli-probe").click();await settle(12);
    expect(requests.slice(before).some(item=>item.path===`/ui/runtimes/machines/${idA}/probe`)).toBe(true);
    expect(requests.slice(before).some(item=>item.path==="/ui/windows-cli/probe")).toBe(false);
    await select(idB);
    expect(p.root.querySelector("#windows-cwd").value).toBe("C:\\Laptop");expect(p.root.querySelector("#windows-prompt").value).toBe("");
    expect(p.root.querySelector("#windows-model").textContent).toContain("Model B");expect(p.root.querySelector("#windows-model").textContent).not.toContain("Model A");
    await select(idA);expect(p.root.querySelector("#windows-prompt").value).toBe("Desktop draft");expect(p.root.querySelector("#windows-model").value).toBe("model-a");
  });
  it("ignores a late inventory after switching computers and keeps a revoked selection unavailable",async()=>{
    app.appStore.set({windowsCli:true});machines=[machine(idA,"Desktop"),machine(idB,"Laptop")];
    const fixtureFetch=globalThis.fetch;let release!:(value:unknown)=>void;
    globalThis.fetch=(async(path:any,options:any)=>path===`/ui/runtimes/machines/${idA}/inventory`?new Promise(resolve=>{release=resolve;}):fixtureFetch(path,options)) as any;
    try{
      await p.mount(h(Panel,{navKey:"held-computer-inventory"}));await settle(12);
      const picker=()=>p.root.querySelector(".runtime-diagnostic-target select");
      picker().value=idA;fire(picker(),"change");await settle(8);
      picker().value=idB;fire(picker(),"change");await settle(12);
      release(response({inventory:machine(idA,"Desktop").inventory}));await settle(12);
      expect(p.root.querySelector("#windows-cwd").value).toBe("C:\\Laptop");
      expect(p.root.querySelector(".runtime-local-diagnostics .windows-cli-target-name").textContent).toBe("Laptop");
      machines=machines.map(item=>item.id===idB?{...item,status:"revoked"}:item);button("Refresh machines").click();await settle(12);
      expect(picker().value).toBe(idB);expect(p.root.textContent).toContain("This Runtime is unavailable or no longer approved.");
      expect(p.root.querySelector(".windows-cli-probe").disabled).toBe(true);
      expect(requests.filter(item=>item.path==="/ui/windows-cli/probe")).toHaveLength(1);
    }finally{globalThis.fetch=fixtureFetch;}
  });
  it("waits for the selected computer's history, submits once and blocks an unconfirmed outcome",async()=>{
    machines=[machine(idA,"Desktop")];const fixtureFetch=globalThis.fetch,root=`/ui/runtimes/machines/${idA}/tasks`;
    let release!:(value:unknown)=>void,first=true,task:any=null;const sent:any[]=[];
    globalThis.fetch=(async(path:any,options:any={})=>{
      if(path!==root)return fixtureFetch(path,options);
      if(options.method==="POST") {const body=JSON.parse(options.body);sent.push(body);task={id:body.requestId,cli:body.cli,cwd:body.cwd,sandbox:body.sandbox,startedAt:1,status:"failed",output:"",outcomeConfirmed:false};return response({task},202);}
      if(first){first=false;return new Promise(resolve=>{release=resolve;});}return response({tasks:task?[task]:[]});
    }) as any;
    try{
      await p.mount(h(Panel,{navKey:"remote-diagnostic-submission"}));await settle(12);
      const prompt=p.root.querySelector("#windows-prompt");prompt.value="Fixture analysis";fire(prompt,"input");await settle();
      const submit=()=>p.root.querySelector(".windows-cli-composer button[type=submit]");expect(submit().disabled).toBe(true);
      release(response({tasks:[]}));await settle(12);expect(submit().disabled).toBe(false);
      const form=p.root.querySelector(".windows-cli-composer form");fire(form,"submit");fire(form,"submit");await settle(12);
      expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({cwd:"C:\\Desktop",prompt:"Fixture analysis",cli:"codex",sandbox:"read-only"});
      expect(submit().disabled).toBe(true);expect(p.root.textContent).toContain("A task outcome is unconfirmed.");
      expect(requests.some(item=>item.path.startsWith("/ui/windows-cli/"))).toBe(false);
    }finally{globalThis.fetch=fixtureFetch;}
  });
  it("supports remote-only diagnostics and disables offline actions without falling back to the host",async()=>{
    machines=[machine(idA,"Offline desk","offline")];await p.mount(h(Panel,{navKey:"remote-only-diagnostics"}));await settle(12);
    expect(p.root.querySelector(".runtime-diagnostic-target select").value).toBe(idA);
    expect(p.root.querySelector("#windows-cwd").value).toBe("C:\\Offline desk");
    expect(p.root.querySelector(".windows-cli-probe").disabled).toBe(true);
    expect(p.root.querySelector(".windows-cli-composer button[type=submit]").disabled).toBe(true);
    expect(p.root.textContent).toContain("This computer is offline.");expect(requests.some(item=>item.path.startsWith("/ui/windows-cli/"))).toBe(false);
  });
  it("keeps existing Windows settings addresses as aliases of Runtime",()=>{
    for(const path of ["/settings/runtimes","/settings/windows-cli","/ui/windows-cli"])expect(routes.parseRoute(path)).toEqual({panel:"settings",section:"runtimes"});
    expect(routes.sectionPath("windows-cli")).toBe("/settings/runtimes");
  });
  it("shows actual machines and installed product marks, and approves a pending computer",async()=>{
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.textContent).toContain("Desktop");expect(p.root.textContent).toContain("Awaiting approval");
    expect(p.root.querySelectorAll('.runtime-machines [data-cli="codex"]').length).toBe(2);expect(p.root.querySelector('[data-cli="muse"]')).toBeNull();
    expect(p.root.querySelector(".runtime-pairing-fingerprint").textContent).toBe("ABCD-1234-5678");
    button("Approve computer").click();await settle(8);
    expect(requests).toContainEqual({path:`/ui/runtimes/machines/${idB}/approve`,body:{fingerprint:"ABCD-1234-5678"}});
    expect(p.root.querySelector(`[data-machine-id="${idB}"]`).textContent).toContain("Online");
  });
  it("creates a transient pairing code with an interactive CLI command, then hides it",async()=>{
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);button("Connect a computer").click();await settle(8);
    const download=p.root.querySelector(".runtime-pairing .runtime-bundle-download");
    expect(download.textContent).toContain("Download Windows Runtime");
    expect(download.getAttribute("href")).toBe("/ui/runtimes/download/windows");
    expect(p.root.textContent).toContain("transfer the ZIP to the Windows computer");
    expect(p.root.querySelector(".runtime-pair-code").value).toBe("PAIR-TEST-CODE");
    expect(p.root.querySelector(".runtime-command").value).toContain("agend-runtime.cmd connect --server");
    expect(p.root.querySelector(".runtime-command").value).not.toContain("PAIR-TEST-CODE");
    // S-30: while pairing, the ZIP is the panel's step 1 — one download button, not one in the header too.
    expect(p.root.querySelectorAll(".runtime-bundle-download").length).toBe(1);
    button("Hide pairing code").click();await settle();expect(p.root.querySelector(".runtime-pair-code")).toBeNull();
    expect(p.root.querySelectorAll(".runtime-bundle-download").length).toBe(1);   // the header's is back
  });
  it("S-30: a computer card names its platform and host name, never a version slot that is always \"Not reported\"",async()=>{
    machines=[{...machine(idA,"Desktop"),version:undefined,hostname:"DESKTOP-7Q2"},{...machine(idB,"Laptop","pending"),version:undefined}];
    await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.querySelector(`[data-machine-id="${idA}"] header p`).textContent).toBe("win32 · DESKTOP-7Q2");
    expect(p.root.querySelector(`[data-machine-id="${idB}"] header p`).textContent).toBe("win32");
    expect(p.root.querySelector(".runtime-machines").textContent).not.toContain("Not reported");
  });
  it("keeps local Runtime settings visible while remote connections are disabled",async()=>{
    enabled=false;machines=[];await p.mount(h(Panel,{navKey:"runtime"}));await settle(8);
    expect(p.root.textContent).toContain("Other Windows PCs can connect once “Allow other Windows PCs to pair” is on.");expect(p.root.textContent).toContain("This computer");expect(button("Connect a computer").disabled).toBe(true);
  });
  it("creates a remote agent with an optional workspace while local Windows CLI is disabled",async()=>{
    expect(app.appStore.get().windowsCli).toBe(false);
    await p.mount(h(Create,{onClose(){}}));await settle(8);await choose(idA);button("Next").click();await settle(8);
    expect(p.root.textContent).toContain("Working directory on Desktop (optional)");
    expect(requests.some(item=>item.path===`/ui/models?backend=codex&runtime=windows&machineId=${idA}`)).toBe(true);
    const name=p.root.querySelectorAll(".agent-runtime-fields input")[1];name.value="Remote helper";fire(name,"input");await settle();
    button("Create").click();await settle(8);
    const submitted=requests.find(item=>item.path==="/ui/instances");expect(submitted?.body).toMatchObject({runtime:"windows",machineId:idA,topic_name:"Remote helper",backend:"codex"});
    expect(submitted?.body).not.toHaveProperty("directory");expect(p.root.textContent).toContain("Agent created");
    expect(requests.some(item=>item.path==="/ui/windows-cli/probe")).toBe(false);
  });
  it("isolates machine drafts, directories and model catalogs",async()=>{
    machines=[machine(idA,"Desktop"),machine(idB,"Laptop")];await p.mount(h(Create,{onClose(){}}));await settle(8);await choose(idA);button("Next").click();await settle(8);
    const adapter=()=>p.root.querySelector("#native-create-adapter");adapter().value="pane";fire(adapter(),"change");await settle();
    let dir=p.root.querySelector(".agent-runtime-fields input");dir.value="C:\\DesktopOnly";fire(dir,"input");await settle();button("Back").click();await settle();await choose(idB);button("Next").click();await settle(8);
    dir=p.root.querySelector(".agent-runtime-fields input");expect(dir.value).toBe("");expect(adapter().value).toBe("exec");
    const ids=p.root.querySelectorAll(".model-pick option").map((item:any)=>item.value);expect(ids).toContain("model-b");expect(ids).not.toContain("model-a");
    button("Back").click();await settle();await choose(idA);button("Next").click();await settle(8);expect(p.root.querySelector(".agent-runtime-fields input").value).toBe("C:\\DesktopOnly");expect(adapter().value).toBe("pane");
    button("Create").click();await settle(8);expect(requests.find(row=>row.path==="/ui/instances")?.body).toMatchObject({native_adapter:"pane",machineId:idA});
  });
  it("shows offline machines without enabling selection or silently falling back to another computer",async()=>{
    machines=[machine(idA,"Desktop","offline")];await p.mount(h(Create,{onClose(){}}));await settle(8);
    expect(p.root.querySelectorAll(".agent-runtime-picker input").find((item:any)=>item.value===`machine:${idA}`).disabled).toBe(true);
    expect(button("Next").disabled).toBe(true);expect(requests.some(item=>item.path==="/ui/instances")).toBe(false);
  });
});

describe("machine snapshot boundary",()=>{
  it("never places shell syntax, URL credentials or cleartext remote addresses in the copyable command",()=>{
    expect(connectCommand("https://runtime.example.com:443")).toBe('.\\agend-runtime.cmd connect --server "https://runtime.example.com"');
    expect(connectCommand("http://localhost:19280")).toContain('"http://localhost:19280"');
    for(const bad of ["http://192.168.1.2:19280","https://user:password@example.com","https://example.com/?x=$(calc)","https://$(calc)","https://example.com/path","https://example.com;calc"])expect(connectCommand(bad)).toBe("");
  });
  it("coalesces reads and keeps the last good snapshot after a network failure, clearing it on lost authorization",async()=>{
    let resolve!:(value:any)=>void;let count=0;let mode="pending";
    const pending=new Promise<any>(done=>{resolve=done;});
    const store=catalog.createRuntimeCatalog({fetcher:async()=>{count++;return mode==="pending"?pending:mode==="fail"?response({error:"unavailable"},503):response({error:"unauthorized"},403);}});
    const a=store.load(),b=store.load();resolve(response({enabled:true,machines}));await Promise.all([a,b]);expect(count).toBe(1);expect(store.get().data.machines).toHaveLength(2);
    mode="fail";await store.load({force:true});expect(store.get().data.machines).toHaveLength(2);expect(store.get().error).toBe("unavailable");
    mode="auth";await store.load({force:true});expect(store.get().data).toBeNull();store.clear();
  });
});
