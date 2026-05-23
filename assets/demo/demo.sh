#!/usr/bin/env bash
# Curated reenactment of a Reviewgate turn for the README demo GIF.
# Output strings (verdict lines, pending.md format) mirror the real CLI.
# Rendered via VHS — see assets/demo/demo.tape.
set -u

# ── colors ───────────────────────────────────────────────────────────────
B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[34m'
MAG=$'\033[35m'; CYN=$'\033[36m'; GRY=$'\033[90m'

p()  { printf '%b\n' "$1"; }
s()  { sleep "$1"; }

clear
p "${GRY}# Pairing with Claude Code in a Reviewgate-enabled repo.${R}"
p "${GRY}# Claude just added a login route and tries to finish its turn…${R}"
s 1.4

p ""
p "${MAG}●${R} ${B}Edit${R} ${CYN}src/routes/auth.ts${R}"
s .5
p "  ${GRN}+ app.post(\"/login\", (req, res) => {${R}"
p "  ${GRN}+   const user = db.query(\`SELECT * FROM users WHERE name='\${req.body.name}'\`)${R}"
p "  ${GRN}+   res.json(user)${R}"
p "  ${GRN}+ })${R}"
s 1.4

p ""
p "${D}⏹  Claude ends its turn${R}  ${GRY}→  Stop hook fires${R}"
s 1.1

p ""
p "${BLU}🔍 Reviewgate${R} ${D}· spawning reviewer panel (codex · gemini)…${R}"
s .8
p "   ${GRY}codex   ▸ reviewing diff (1 file, +4 −0)…${R}"; s .7
p "   ${GRY}gemini  ▸ reviewing diff (1 file, +4 −0)…${R}"; s 1.3

p ""
p "${RED}${B}⛔ Reviewgate: BLOCK — FAIL on iteration 1${R}   ${RED}(1 CRITICAL)${R}"
p "   ${D}Claude cannot end its turn until every finding is resolved.${R}"
s 1.6

p ""
p "${B}📄 .reviewgate/pending.md${R}"
p "${GRY}┌────────────────────────────────────────────────────────────────┐${R}"
p "${GRY}│${R} ${B}## F-001${R}  ${RED}[CRITICAL]${R}  SQL injection in /login            ${GRY}│${R}"
p "${GRY}│${R} ${D}src/routes/auth.ts:2 — user input interpolated into a SQL${R}    ${GRY}│${R}"
p "${GRY}│${R} ${D}string. Use a parameterised query.${R}                          ${GRY}│${R}"
p "${GRY}│${R} ${YEL}confirmed_by:${R} codex, gemini   ${D}→ fix, or reject w/ reason${R}  ${GRY}│${R}"
p "${GRY}└────────────────────────────────────────────────────────────────┘${R}"
s 2.2

p ""
p "${MAG}●${R} ${B}Edit${R} ${CYN}src/routes/auth.ts${R}  ${D}(Claude addresses the finding)${R}"
s .6
p "  ${RED}- const user = db.query(\`SELECT * FROM users WHERE name='\${req.body.name}'\`)${R}"
p "  ${GRN}+ const user = db.query(\"SELECT * FROM users WHERE name = ?\", [req.body.name])${R}"
s 1.6

p ""
p "${D}⏹  Claude ends its turn${R}  ${GRY}→  re-review${R}"
s .9
p "${BLU}🔍 Reviewgate${R} ${D}· iteration 2…${R}"
s .7
p "   ${GRY}codex   ▸${R} ${GRN}no findings${R}"; s .6
p "   ${GRY}gemini  ▸${R} ${GRN}no findings${R}"; s 1.2

p ""
p "${GRN}${B}✅ Reviewgate: DONE — PASS on iteration 2${R}"
p "   ${D}Turn released. You review the final diff and commit — never the gate.${R}"
s 2.6
