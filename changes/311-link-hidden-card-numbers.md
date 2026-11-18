---
section: Fixed
---
- **Over the public link, a card kept out of sight is no longer numbered in a visible card's dependencies, history or cascades (AGEND-311).** Besides a main task's number (AGEND-309), the number of a hidden card could still be read from a visible card's `dependsOn` and `unmetDeps` (the card's read, its sub tasks', the board's, the work drawer's and the search's), from an "updated" event's `changes.dependsOn` in its history, and from the `cascade` / `restored` of a sub task's "moved" event. Those numbers are now left out (an "updated" event with nothing visible left is not shown). The page looks the same; the dashboard and admin sessions still see every number.
