# Grok model-cache fix — PR #2986

Submitted head: `7078204eb038f36b475037e1da2d1e023a25bc43`. Base: `0c156694e87dac240afe74a77b338ad7987e67ed`.

The code PR is independent of UI PR #2978. These public artifacts contain the focused validation commands, changed-file hashes, two compilable behavioral reversals, and an unedited real browser smoke screenshot. No credential cache or production configuration is included.

The screenshot comes from the local WSL deployment with the Settings UI preview from #2978; it demonstrates the model/cache source behavior rather than the standalone PR base layout. See `evidence/browser-preview.json`.

All code/tests were validated at `d4fb89e8944f7d85089111a8e5151c50e31082c7`; the final commit only renames the unchanged changelog pair to #2986. Windows git archive emitted CRLF text; `evidence/validation.json` records both submitted LF git-blob hashes and tested CRLF archive hashes, proving their equivalence after newline conversion. Full suites remain for CI.
