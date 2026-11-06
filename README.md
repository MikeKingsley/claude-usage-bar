# usage-bar

A one-line bar above the Claude prompt box showing your session usage, weekly usage and prompt-cache time left, each as a rounded progress bar with its reset time. It refreshes every 30 seconds.

- **Keep cache warm (♨):** when on, the mod sends a tiny `ok` request over your existing conversation shortly before the prompt cache expires, so it stays warm while you are idle. It never pings while a turn is running and stops after 12 pings in a row without a message from you. The remembered choice carries across sessions.
- **Skill breakdown (▸):** expands the bar to list your most used skills and the skills costing the most. Cost is an estimate from weighted token counts, not exact dollars.
- **Cache window:** defaults to 60 minutes. Inside the expanded view, switch it to 5 minutes if that matches your cache.

The session and weekly meters need a subscription plan that reports rate limits; otherwise they show "n/a". The bar is drawn above the prompt in the terminal and the Claude desktop app.

## Install

In a terminal session:

```
/plugin install usage-bar --marketplace MikeKingsley/claude-usage-bar
```

From a shell:

```
claude plugin install usage-bar --marketplace MikeKingsley/claude-usage-bar
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `MikeKingsley/claude-usage-bar`, then Add plugin.
