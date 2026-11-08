// Usage: node bundle-scan.mjs <bundle-dir>
// Scans every relative import of the bundle's modules (what `import`/`export ... from`/`import()` name) against the bundle's own module list,
// then loads each module on its own in a fresh Node process, reporting the ones that fail with ERR_MODULE_NOT_FOUND.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const bundle = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8"));
const modules = manifest.modules.filter(n => n.endsWith(".js"));
console.log(`bundle: ${modules.length} JavaScript modules listed in bundle-manifest.json`);

const missing = [];
for (const name of modules) {
  const code = readFileSync(join(bundle, "dist", name), "utf8");
  for (const found of code.matchAll(/(?:^|\n)[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const target = found[1] ?? found[2];
    if (target.startsWith("./") && !manifest.modules.includes(target.slice(2))) missing.push(`${name} -> ${target}`);
  }
}
console.log(missing.length === 0 ? "scan: every relative import is in the bundle" : `scan: ${missing.length} relative import(s) the bundle does not carry:\n  ${missing.join("\n  ")}`);

const SKIP = new Set(["runtime-cli.js"]); // starts the CLI on import
const failures = [];
for (const name of modules.filter(n => !SKIP.has(n))) {
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(bundle, "dist", name)).href)})`], { cwd: bundle, stdio: "pipe", timeout: 20000 });
  } catch (error) {
    const text = String(error.stderr ?? "");
    // The path of the missing file, relative to the bundle (the machine's own directory names are not part of the evidence).
    const file = (text.match(/Cannot find module '[^']*[\\/]([^\\/']+)'/) ?? [])[1];
    if (/ERR_MODULE_NOT_FOUND/.test(text)) failures.push(`${name}: ERR_MODULE_NOT_FOUND, cannot find module '<bundle>/dist/${file ?? "?"}'`);
  }
}
console.log(failures.length === 0 ? "load: no module fails with ERR_MODULE_NOT_FOUND" : `load: ${failures.length} module(s) fail with ERR_MODULE_NOT_FOUND:\n  ${failures.join("\n  ")}`);
process.exitCode = missing.length + failures.length === 0 ? 0 : 1;
