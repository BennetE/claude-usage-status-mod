# usage-status

A Claude Code mod for the status line:

- a live timer for the running request, and each finished request's duration under its last reply
- the 5h and 7d plan limits as bars, with a `┊` marker where even use of the window would be by now
- the session cost

On weekdays (Mon 00:00 – Fri 17:00, local time) the 7d limit is shown as `5d` and paced over the working time in its window, weekends left out. On a worked weekend it shows `7d`, paced over the whole week.

```
⏱ 1m12s  │  5h ███┊█▎░░░░░ 42% · 5d █▊░░┊░░░░░░ 18%  │  $2.40
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-status --marketplace BennetE/claude-usage-status-mod
```

Answer `y` to add the marketplace, then choose the user scope. From a shell:

```
claude plugin install usage-status --marketplace BennetE/claude-usage-status-mod
```

Needs a Claude Code version with hooks modules (mods), and `python3` on the PATH for the Stop hook.

## Update

Auto-update is off for added marketplaces unless enabled under `/plugin` → Marketplaces. By hand:

```
claude plugin marketplace update claude-usage-status-mod
claude plugin update usage-status
```

Bump `version` in `.claude-plugin/plugin.json` with every change.

## Develop

```
claude plugin test .
claude plugin validate .
```
