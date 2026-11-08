Evidence for the Windows Runtime bundle fix (runtime-bundle/): before and after, run on a real Windows Node.

- `runtime-bundle-before-after.png`: the captured output below, rendered.
- `captured-output.txt`: the output, verbatim apart from the bundle's directory, shown as `<bundle>`.
- `make-bundle.sh`: builds the bundle the way the tests do (portable compile of the bundle's modules, then `scripts/build-runtime.mjs`).
- `bundle-scan.mjs <bundle>`: lists the relative imports the bundle does not carry, then loads each module in its own Node process.
- `start-pane-service.ps1 -Bundle <bundle>`: starts `dist\runtime-pane-service.js` the way the Runtime does and reports whether it came up; stops only the process it started.
