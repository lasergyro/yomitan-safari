# Agent notes

- The repository is a fork of Yomitan (the dictionary pop-up) ported to Safari on macOS. Work happens on branch
  `safari-refactor`: the dictionary engine runs in the native Safari app extension (JavaScriptCore over the system
  SQLite) and the browser extension keeps display and UI. What was built is in [native/README.md](native/README.md);
  the plan, its status and the decision log are in [plan/](plan/) (start at [plan/README.md](plan/README.md)); building
  is in [README.md](README.md), and verifying against the installed extension in real Safari is in [DEV.md](DEV.md).
- Messages to and from other Claude sessions (which repository belongs to which session, messaging a running one
  directly, a planner issue for an offline one) follow `~/dotfiles/repos/SESSIONS.md`.
