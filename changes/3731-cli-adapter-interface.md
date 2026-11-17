---
section: Changed
---
- **Instances now run through an adapter interface, with tmux as the only adapter (#3731).** Nothing about how an instance runs changes: the same tmux pane, launch command, delivery and cancel path. Terminal-only operations ask whether the adapter has a pane instead of assuming one. A new optional `cli_adapter` setting (per instance or under `defaults`) accepts only `tmux`; any other value is refused when the configuration loads.
