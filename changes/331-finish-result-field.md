---
section: Fixed
---
- **Finishing a card without a result now says which field takes it (AGEND-331).** A real agent put its summary in `comment` when it moved a card to review or done, and was told only "finishing needs a result", so it tried again with the same mistake before finding `result`. The two refusals (finishing, and resubmitting from review) now say the result goes in the `result` field and that a comment is not one. Nothing else about when a result is needed has changed.
