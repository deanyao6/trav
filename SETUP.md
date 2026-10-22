# One-time setup (about 10 minutes, on your Mac)

## 1. Put the repo outside Documents/Desktop/Downloads
The sandbox hides those folders, so the repo can't live there.
```bash
mv ~/Desktop/trav ~/trav
cd ~/trav
brew install pnpm            # the sandbox can't install it later
```
If your other code lives in a folder like `~/code` or `~/Projects`, add it to `sandbox.filesystem.denyRead` and `permissions.deny` in `.claude/settings.json` (as long as `~/trav` isn't inside it).

## 2. Claude Code uses your Max plan
```bash
claude            # then /login with your Claude account if needed; quit after
claude auth status   # should show claude.ai, not an API key
```
The overnight script unsets `ANTHROPIC_API_KEY` so Claude Code can't fall back to your Console credits.

Open `claude` once inside `~/trav` interactively and accept the workspace trust prompt, so the project settings and the guard hook are active in headless runs.

## 3. GitHub: a token that can only touch this repo
1. The private repo `deanyao6/trav` already exists and is `origin`.
2. Create a **fine-grained personal access token** at https://github.com/settings/personal-access-tokens/new. Repository access: **Only select repositories → `deanyao6/trav`**. Permissions: **Contents: Read and write** (Metadata: Read is added automatically; nothing else). Expiry: 7 days. Copy the `github_pat_...` value.
3. Wire it into this repo only (your global GitHub login is ignored here). `read -rs` waits for you to paste the token (nothing is shown) and keeps it out of your shell history:
```bash
cd ~/trav
git config --local credential.helper ""        # disables the macOS keychain for this repo
git config --local --add credential.helper "store --file=$PWD/.git/trav-credentials"
read -rs TOKEN && printf 'https://deanyao6:%s@github.com\n' "$TOKEN" > .git/trav-credentials && unset TOKEN
chmod 600 .git/trav-credentials
git push origin main                           # should succeed without a password prompt
```

## 4. Trav's own API key (separate from Claude Code)
1. In the Claude Console, create a **workspace** called `trav` and set its **spend limit to $50**. That is the hard cap.
2. Create an API key in that workspace.
3. `cp .env.example .env` and paste it as `TRAV_ANTHROPIC_API_KEY`. Leave `TRAV_LIVE_BUDGET_USD=45` (the app stops itself a bit before the Console cap).

## 5. Quick safety check before you sleep
In `~/trav`, run `claude` interactively and ask it to: "read ~/.ssh/config", "run ls ~/Documents", and "git push to https://github.com/deanyao6/OLI.git". All three should be **blocked** by the sandbox or a "BLOCKED by Trav guard" message, not just politely declined. Then ask it to "run node --version" and "run git status"; both should work. Finally ask it to "use the market-researcher agent to do one web search for Splitwise"; that should work (the guard lets only research agents browse). Quit.

If sandboxing isn't available on your machine, Claude Code refuses to start (that's intended: `failIfUnavailable`).

## 6. Run
Plug the Mac in and leave the lid open (the script keeps it awake with `caffeinate`).
```bash
./scripts/overnight.sh 9
```
In the morning: read `MORNING_REPORT.md`, then glance at `.claude/hooks/blocked.log`. Anything blocked that looks like it came from a web page is a prompt-injection attempt that the guard caught.
