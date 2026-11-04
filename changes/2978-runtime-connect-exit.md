---
section: Fixed
---
- `connect-agend.bat` no longer closes silently when AgEnD ends the connection. The window stays open and explains why (computer revoked or not recognised, another Runtime took over the same pairing, or a rejected message) and what to do next, and the Runtime exits with a non-zero code. A profile that still holds jobs from a different AgEnD server no longer replays them to the new server, which used to make it close the connection right after "Connected".
