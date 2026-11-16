/**
 * #3731: switching an existing agent's Runtime or CLI. An ACP agent that moves to Windows, or to a CLI with no ACP, goes back to
 * terminal / native execution (cli_adapter removed, skipPermissions kept); one that moves to another ACP-capable CLI stays ACP.
 * A switch whose result would not load again is refused before anything is stopped or written. (The fixture is
 * agent-runtime-fleet.test.ts's: the real FleetManager and Runtime wiring, inert providers.)
 */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("node:child_process",async original=>({...await original<typeof import("node:child_process")>(),spawn:()=>{throw Error("No processes in runtime migration tests");},execFile:()=>{throw Error("No CLI");},execFileSync:()=>{throw Error("No CLI");},execSync:()=>{throw Error("No CLI");},spawnSync:()=>{throw Error("No CLI");}}));
vi.mock("../src/logger.js",()=>({createLogger:()=>({info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn(),child(){return this;}})}));
import {FleetManager} from "../src/fleet-manager.js";
import {TmuxManager} from "../src/tmux-manager.js";
import {WindowsAgents} from "../src/windows-agents.js";
import {registerWindowsProfiles} from "../src/native-instance-registry.js";
import type {WindowsCliExecutor} from "../src/windows-cli.js";
const a="12345678-1234-4321-abcd-123456789012",b="22345678-1234-4321-abcd-123456789012",oldId="32345678-1234-4321-abcd-123456789012";
const fixtures:Array<{home:string;fm:FleetManager}>=[];
beforeEach(()=>{vi.stubEnv("AGEND_WINDOWS_CLI","1");vi.stubEnv("AGEND_REMOTE_RUNTIME","1");vi.spyOn(TmuxManager,"sessionExistsStrict").mockResolvedValue(false);});
afterEach(()=>{for(const {home,fm} of fixtures.splice(0)){fm.stormWindow.shutdown();fm.spawnGate.shutdown();if(!resolve(home).startsWith(resolve(tmpdir())+sep))throw Error("Unsafe fixture cleanup");rmSync(home,{recursive:true,force:true});}vi.restoreAllMocks();vi.unstubAllEnvs();});
function fixture(windows=false){
 const home=mkdtempSync(join(tmpdir(),"agend-runtime-switch-")),instanceDir=join(home,"instances","agent-1");mkdirSync(instanceDir,{recursive:true});
 const old={id:oldId,name:"Helper",cli:"codex",cwd:"C:\\original",sandbox:"read-only",description:"Role",instructions:"Keep instructions",createdAt:1,threadId:a,fleet_instance:"agent-1",machineId:a,turns:[{id:b,prompt:"Before migration",output:"Retained reply",status:"completed",startedAt:1,finishedAt:2}]};
 if(windows)writeFileSync(join(home,"windows-agents.json"),JSON.stringify({version:1,agents:[old],requests:{}}));
 const fm=new FleetManager(home),any=fm as any;fixtures.push({home,fm});
 const before:any={working_directory:windows?old.cwd:home,backend:windows?"codex":"claude-code",display_name:"Helper",description:"Role",systemPrompt:"Keep instructions",tags:["test"],topic_id:7,channel_id:"chat",tool_set:"worker",dashboard:{tasks:false},...(windows?{runtime:"windows",native_agent_id:oldId,machine_id:a,native_sandbox:"read-only"}:{})};
 fm.fleetConfig={defaults:{backend:"claude-code"},instances:{"agent-1":before},teams:{review:{members:["agent-1"]}}} as any;
 const cli={id:"codex",path:"C:\\codex.exe",runnable:true,readOnlySupport:true,supports:{execution:true,resume:true,mcp:true}};
 const machines=new Map([[a,{id:a,bootId:a,status:"online",platform:"win32",paneProtocol:1,inventory:{clis:[cli]}}],[b,{id:b,bootId:b,status:"online",platform:"win32",paneProtocol:1,inventory:{clis:[cli]}}]]);
 const bridge={probe:vi.fn(async()=>({clis:[cli]})),prepareWorkspace:vi.fn(async(id:string,_allowed:()=>boolean,machineId?:string)=>`C:\\managed-${machineId||"local"}\\${id}`),hasActiveTask:()=>false,get:()=>null,start:()=>{throw Error("No provider execution");},cancel:()=>{throw Error("No cancellation");}} as unknown as WindowsCliExecutor;
 any.runtimeWindowsExecutor=()=>bridge;any.runtimeCoordinator=()=>({machine:(id:string)=>machines.get(id)});
 any.backendAvailabilityRows=()=>[{backend:"claude-code",state:"usable"},{backend:"codex",state:"usable"}];
 const save=vi.fn();any.saveFleetConfig=save;any.getUiStatus=()=>({instances:Object.keys(fm.fleetConfig!.instances)});
 any.emitSseEvent=vi.fn((event:string,value:any)=>{if(event==="message")fm.webChatHistory.record(value);});
 any.stopInstance=vi.fn(async(name:string)=>{fm.lifecycle.invalidate(name);fm.lifecycle.daemons.delete(name);const file=join(instanceDir,"window-id");if(existsSync(file))unlinkSync(file);return {backgroundWorkEnded:false};});
 fm.webChatHistory.record({instance:"agent-1",sender:"You",role:"user",text:"Shared AgEnD history",ts:new Date(0).toISOString()});
 const service=fm.agentRuntimeChanges();
 const body=(runtime="windows",machineId:string|undefined=b)=>({requestId:crypto.randomUUID(),expectedRevision:service.describe("agent-1").revision,runtime,...(runtime==="windows"&&machineId?{machineId}:{}),backend:"codex",sandbox:"read-only",startNewConversation:true});
 return {home,instanceDir,fm,any,before,bridge,machines,save,service,body};
}
import {AgentRuntimeChanges,type AgentRuntimeChangeHost} from "../src/agent-runtime-change.js";
import {adapterAfterRuntimeChange,runtimeConfigProblem} from "../src/adapters/config.js";
const rows=()=>["claude-code","codex","grok","antigravity"].map(backend=>({backend,state:"usable"}));
function acpAgent(r:ReturnType<typeof fixture>,backend="grok"){
 Object.assign(r.before,{backend,cli_adapter:"acp",skipPermissions:false});delete r.before.backend_options;r.any.backendAvailabilityRows=rows;r.any.backendAvailabilityFor=()=>rows();
 return r.fm.fleetConfig!.instances["agent-1"]!;
}
describe("an ACP agent's Runtime / CLI switch",()=>{
 it("to Windows: native execution, cli_adapter removed, skipPermissions kept, and the file still loads",async()=>{
  const r=fixture();acpAgent(r);
  await r.service.change("agent-1",r.body(),()=>true);
  const config=r.fm.fleetConfig!.instances["agent-1"]!;
  expect(config).toMatchObject({runtime:"windows",machine_id:b,backend:"codex",skipPermissions:false});
  expect(config).not.toHaveProperty("cli_adapter");
  expect(runtimeConfigProblem(config,"claude-code")).toBeNull();
  expect(r.save).toHaveBeenCalled();
 });
 it("in WSL to a CLI with no ACP (grok → claude-code): back to the terminal, cli_adapter removed, skipPermissions kept",async()=>{
  const r=fixture();acpAgent(r);
  await r.service.change("agent-1",{...r.body("wsl"),backend:"claude-code"},()=>true);
  const config=r.fm.fleetConfig!.instances["agent-1"]!;
  expect(config).toMatchObject({runtime:"wsl",backend:"claude-code",skipPermissions:false});
  expect(config).not.toHaveProperty("cli_adapter");
  expect(runtimeConfigProblem(config,"claude-code")).toBeNull();
 });
 it("in WSL to another CLI that has ACP (grok → antigravity): stays ACP — the choice is to keep the mode the person picked, since both CLIs have an official ACP and nothing but the CLI changed",async()=>{
  const r=fixture();acpAgent(r);
  await r.service.change("agent-1",{...r.body("wsl"),backend:"antigravity"},()=>true);
  const config=r.fm.fleetConfig!.instances["agent-1"]!;
  expect(config).toMatchObject({runtime:"wsl",backend:"antigravity",cli_adapter:"acp",skipPermissions:false});
  expect(runtimeConfigProblem(config,"claude-code")).toBeNull();
 });
 it("describe() says whether the agent is ACP now (the dialog's note)",()=>{
  const r=fixture();expect(r.service.describe("agent-1").cliAdapter).toBe("tmux");
  acpAgent(r);expect(r.service.describe("agent-1").cliAdapter).toBe("acp");
 });
});

describe("a switch whose result would not load is refused before anything is stopped or written",()=>{
 const host=(prepared:Record<string,unknown>)=>{
  const config={working_directory:"/w",backend:"grok",cli_adapter:"acp"} as any,discard=vi.fn(),save=vi.fn(),stopped=vi.fn();let epoch=0;
  const h:AgentRuntimeChangeHost={config:()=>config,defaults:()=>({backend:"claude-code"}),generation:()=>0,epoch:()=>epoch,idle:()=>true,
   transition:async(_n,run)=>run(async()=>{epoch++;stopped();}),prepare:async()=>({config:{...config,...prepared} as any,discard}),closed:async()=>true,fresh:()=>()=>{},save,changed:()=>{}};
  const service=new AgentRuntimeChanges(h);
  return {service,discard,save,stopped,input:()=>({requestId:crypto.randomUUID(),expectedRevision:service.describe("agent-1").revision,runtime:"wsl" as const,backend:"grok",model:"",directory:"",sandbox:"read-only" as const,adapter:"exec" as const,startNewConversation:true as const})};
 };
 it.each([
  ["a Windows agent that still names an adapter",{runtime:"windows",cli_adapter:"acp"},/cli_adapter is not accepted for a Windows runtime agent/],
  ["an adapter its backend cannot run",{backend:"claude-code",cli_adapter:"acp"},/cli_adapter "acp" is not supported yet for backend "claude-code"/],
  ["a named account with acp",{backend:"grok",cli_adapter:"acp",backend_options:{grok:{credential_profile:"work"}}},/named account/],
 ])("%s",async(_why,prepared,message)=>{
  const h=host(prepared);
  await expect(h.service.change("agent-1",h.input(),()=>true)).rejects.toThrow(message);
  await expect(h.service.change("agent-1",h.input(),()=>true)).rejects.toThrow(/nothing was changed/);
  expect(h.save).not.toHaveBeenCalled();expect(h.stopped).not.toHaveBeenCalled();expect(h.discard).toHaveBeenCalled();
 });
 it("a result that loads is saved",async()=>{
  const h=host({backend:"antigravity"});
  await h.service.change("agent-1",h.input(),()=>true);
  expect(h.save).toHaveBeenCalledOnce();
 });
});

describe("what a switch does to cli_adapter, as a rule",()=>{
 it("windows or a backend without ACP drops it; a backend with ACP keeps it; none stays none",()=>{
  expect(adapterAfterRuntimeChange({cli_adapter:"acp",runtime:"windows",backend:"grok"})).not.toHaveProperty("cli_adapter");
  expect(adapterAfterRuntimeChange({cli_adapter:"acp",runtime:"wsl",backend:"codex"})).not.toHaveProperty("cli_adapter");
  expect(adapterAfterRuntimeChange({cli_adapter:"acp",runtime:"wsl",backend:"antigravity"})).toMatchObject({cli_adapter:"acp"});
  expect(adapterAfterRuntimeChange({cli_adapter:"acp",runtime:"wsl"},"grok")).toMatchObject({cli_adapter:"acp"});     // the fleet default's backend
  expect(adapterAfterRuntimeChange({runtime:"windows",backend:"codex"})).toEqual({runtime:"windows",backend:"codex"});
 });
});
