Screenshots for the "No project is hard to miss" PR (#4394), from `scripts/manual/smoke/smoke-task-board-sort.mts` (MATRIX=full, same seed).
The smoke file used for both is the one at the PR head bcd75449efb2a644fad43bbf39c2ac0d190b10b2.
- before/: release/2.3.5-alpha at acf22f6dc3554d3f793e9bb7f38bee1bf6a8d6d5 (that smoke file copied in), SHOTS_ONLY=1.
- after/: the PR head bcd75449efb2a644fad43bbf39c2ac0d190b10b2.
- `*-1b-home-tile.png` (phone): Home scrolled to the No project tile.
- `results-measures.json` in each: what the smoke measured (after: the new controls; both: the page head's Instances, New project and search, the same before and after).
Earlier sets: f8f693b60 (after at 63fb1c502c67351844d0e42712bedde3d7c5181f, reachable on assets/no-project-visible-shot-source-63fb1c502), 7bba1bc57 (at 6a99f281c), 12bf65cb6 (at 00882ec8c).
