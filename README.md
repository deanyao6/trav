# trav

all in one ai travel agent

## Group chat simulator (`pnpm sim`)

`pnpm install`, then `TRAV_OFFLINE=1 pnpm sim` and open http://127.0.0.1:5179 (127.0.0.1 only; `TRAV_SIM_PORT` changes the port). Pick a trip on the left, choose who you're sending as, and chat; `@trav` answers in the thread and private items (like each person's ticket) land in that member's DM tab on the right. By default (`TRAV_SIM_BACKEND=auto`) the simulator runs the real Trav runtime. Until the approval handler lands (T-030), tapping Approve or 👍 on a proposal there does nothing except show a status line, so for the full Barcelona demo (ask for Razzmatazz tickets, approve, receipt plus per-person QR tickets) run `TRAV_SIM_BACKEND=scripted TRAV_OFFLINE=1 pnpm sim`.
