# Agent Visualiser usage data

This branch holds **encrypted** usage updates for the Agent Visualiser phone app.
Each file is sealed for the devices listed in `devices/`: only those phones can read it.
`index.json` only says which files changed and when.

It is rewritten automatically (each update replaces the branch's single commit).
To add a phone, open the app's Data tab -> Automatic updates.
