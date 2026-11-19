---
section: Fixed
---
- **A task card's timeline now shows when its watchers were changed (AGEND-309).** Adding or removing a watcher was recorded, but the card's page left it out; it now appears as a line such as "Ann changed watchers: +ops, −dev-b" (under **History** too). Over the public link, a main task kept out of sight is no longer numbered by its sub tasks: their `parentId` and the `parent` of their "created" event read as none (the card's read, the board's, the work drawer's and the search's). The dashboard and admin sessions still see it.
