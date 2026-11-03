# Settings UI preview and validation evidence

Source: songsid/AgEnD pull-request branch `Junsionloh:improve/settings-ui`.
Source HEAD: `d0ba9824895a54791fc8433b700b4b74af275e2e`.
Base: `release/2.3.5-alpha` at `4c8a747dcdcd9b082fa6d088e8e9ad05b11746d9`.

All JPG files are unedited screenshots captured from a real browser rendering the native AgEnD web application from the source HEAD above. They are not generated images or HTML mockups. The server uses an isolated scratch home and synthetic Agent, connection, Runtime and sign-in data; CLI execution, provider sign-in, lifecycle actions and business writes are disabled. The development checkout retains its package.json version label in the header; this is not a packaged release build.

Desktop: 1920 x 1080. Mobile: 390 x 844. Language: Traditional Chinese. Theme: light. Viewports and console results are recorded in evidence/browser-verification.json. The preview server and temporary authentication data were removed after capture.

The PR's program branch contains no preview binaries. This separate assets branch preserves the screenshots and focused validation/reversal evidence for review.

Validation at the exact source HEAD: both TypeScript checks and full build/postbuild passed; 31 focused suites / 531 tests passed without skips. Existing text assertions were run on LF-normalized source. Full CI, native CLI sign-in and real cross-machine acceptance are not claimed.