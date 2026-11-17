/**
 * #3731: the "Change runtime and CLI" dialog says what happens to an ACP agent: back to the terminal (Windows, or a CLI with no
 * ACP), or it stays ACP (another CLI that has it). (The harness is agent-runtime-settings-ui.test.ts's.)
 */
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from "vitest";
import {page,settle,h,type AppPage} from "./helpers/app-harness.js";
import {fire} from "./helpers/mini-dom.js";
const a="12345678-1234-4321-abcd-123456789012",b="22345678-1234-4321-abcd-123456789012",originalFetch=globalThis.fetch;
let p:AppPage,Dialog:any,Section:any,app:any,catalog:any,windows:any,models:any,posts:any[],reads:string[],complete:(()=>void)|null,error=false;
const source:any={revision:"a".repeat(64),runtime:"wsl",directory:"/wsl-private",backend:"grok",cliAdapter:"acp",model:"old-model",adapter:"exec",sandbox:"read-only",general:false};
const inst:any={working_directory:source.directory,backend:source.backend,cli_adapter:"acp"};
const cli={id:"codex",path:"C:\\codex.exe",runnable:true,readOnlySupport:true,supports:{execution:true,resume:true,mcp:true}};
const response=(body:any,status=200)=>({ok:status<400,status,json:async()=>body});
const button=(label:string)=>p.root.querySelectorAll("dialog button").find((node:any)=>node.textContent.trim()===label);
beforeAll(async()=>{
 p=page({url:"http://localhost/settings/agents",storage:{agend_lang:"en"}});
 globalThis.fetch=(async(path:string,options:any={})=>{
  reads?.push(path);
  if(path==="/ui/instances/agent-1/runtime"){
   if(options.method==="POST"){posts.push(JSON.parse(options.body));return new Promise((yes,no)=>{complete=()=>error?no(Error("Connection lost")):yes(response({ok:true}));});}return response(source);
  }
  if(path==="/ui/runtimes")return response({enabled:true,machines:[{id:a,name:"Desktop",status:"online",inventory:{clis:[cli]}},{id:b,name:"Laptop",status:"online",inventory:{clis:[cli,{...cli,id:"grok",readOnlySupport:false}]}}]});
  if(path==="/ui/backends")return response({backends:[{name:"claude-code",installed:true,state:"usable"},{name:"grok",installed:true,state:"usable",adapters:["tmux","acp"]},{name:"antigravity",installed:true,state:"usable",adapters:["tmux","acp"]}]});
  if(path==="/ui/windows-cli/probe")return response({clis:[cli]});
  if(path.startsWith("/ui/models?"))return response({models:[{id:"model-b",label:"Laptop model"}],source:"cli-cache"});
  return response({});
 }) as any;
 const {setLang}=await import("/assets/app-i18n.js");setLang("en",{store:false});app=await import("/assets/app-store.js");catalog=await import("/ui/js/runtime-catalog.js");windows=await import("/ui/js/windows-cli-catalog.js");models=await import("/ui/js/settings-catalog.js");Section=(await import("/ui/js/agent-runtime-settings.js")).AgentRuntimeSettings;Dialog=(await import("/ui/js/agent-runtime-settings.js")).AgentRuntimeChangeDialog;
});
beforeEach(()=>{posts=[];reads=[];complete=null;error=false;app.appStore.set({windowsCli:true});catalog.forgetRuntimeCatalog();windows.forgetWindowsCliCatalog();models.forgetCatalogs();});
afterEach(async()=>{await p.unmount();catalog.forgetRuntimeCatalog();});afterAll(()=>{p.restore();globalThis.fetch=originalFetch;});
const note=()=>p.root.querySelector(".agent-runtime-acp");
describe("the runtime dialog and an ACP agent",()=>{
 it("moving to a Windows computer says it goes back to the terminal (tmux)",async()=>{
  await p.mount(h(Dialog,{name:"agent-1",inst,onClose:vi.fn(),onChanged:vi.fn()}));await settle(8);
  const remote=p.root.querySelectorAll('.agent-runtime-picker input').find((node:any)=>node.value===`machine:${b}`);remote.checked=true;fire(remote,"change");await settle(6);
  button("Next").click();await settle(5);
  expect(note()?.textContent).toMatch(/runs over ACP now\. After the switch it goes back to terminal mode \(tmux\).*cannot run on Windows or with a CLI that has no ACP/);
 });
 it("moving to a Windows computer with grok on it (a CLI that has ACP elsewhere) still says it goes back to the terminal",async()=>{
  await p.mount(h(Dialog,{name:"agent-1",inst,onClose:vi.fn(),onChanged:vi.fn()}));await settle(8);
  const remote=p.root.querySelectorAll('.agent-runtime-picker input').find((node:any)=>node.value===`machine:${b}`);remote.checked=true;fire(remote,"change");await settle(5);
  p.root.querySelector('.agent-runtime-change .cli-picker-trigger').click();await settle();
  p.root.querySelectorAll('[role="menuitemradio"]').find((node:any)=>node.querySelector('[data-cli="grok"]')).click();await settle(3);
  button("Next").click();await settle(5);
  expect(note()?.textContent).toMatch(/goes back to terminal mode \(tmux\)/);
  expect(note()?.textContent).not.toMatch(/stays in ACP mode/);
 });
 it("staying on this host with a CLI that has ACP says it stays ACP",async()=>{
  await p.mount(h(Dialog,{name:"agent-1",inst,onClose:vi.fn(),onChanged:vi.fn()}));await settle(8);
  button("Next").click();await settle(6);
  expect(note()?.textContent).toMatch(/runs over ACP now\. .*supports ACP too, so it stays in ACP mode after the switch/);
  expect(note()?.textContent).not.toMatch(/goes back to terminal mode/);
 });
 it("a terminal agent gets no such note",async()=>{
  const plain:any={...inst};delete plain.cli_adapter;
  await p.mount(h(Dialog,{name:"agent-1",inst:plain,onClose:vi.fn(),onChanged:vi.fn()}));await settle(8);
  button("Next").click();await settle(6);
  expect(note()).toBeNull();
 });
});
