## Before leaving the old Mac

- Run `brew bundle dump --file=~/.dotfiles/Brewfile --force --describe`
- List non-Homebrew apps with `ls /Applications/ | sort`
- Confirm VS Code Settings Sync is enabled
- Export Raycast settings
- Back up `~/.config/dotfiles/local.env`
- Back up `~/.gitconfig.local`
- Back up SSH keys, or confirm 1Password SSH agent is ready
- Check `~/Library/Fonts/` for custom fonts
- Check `/etc/hosts` for custom entries
- Check cron jobs and launch agents
- Check global packages with `pnpm list -g`
- Review `~/.config/` for unmanaged app config you still need
- Confirm browser and JetBrains sync is enabled
- Check local databases, Docker volumes, Ollama, and LM Studio assets
- Commit and push this repo

## On the new Mac

1. Sign in to Apple ID.
2. Update macOS.
3. Run `xcode-select --install`.
4. Run `curl -fsSL https://raw.githubusercontent.com/tommybarvaag/dotfiles/main/ssh.sh | bash -s "<email>"`.
5. Add the public key to GitHub.
6. Clone `git@github.com:tommybarvaag/dotfiles.git` to `~/.dotfiles`.
7. Run `~/.dotfiles/install.sh`.
8. Restart the terminal.
9. Restore `~/.config/dotfiles/local.env`.
10. Restore `~/.gitconfig.local`.
11. Run `~/.dotfiles/vscode.sh` if any tracked VS Code extensions are missing.
12. Import Raycast settings.
13. Sign in to apps, starting with 1Password.
14. Clone work repos.
15. Run `gh auth login`.
16. Open a project, build it, and verify the shell tooling works.

## Always manual

- Apple ID and iCloud sync decisions
- Mail, calendar, and other account logins
- Touch ID, Bluetooth pairing, printers, and FileVault
- Notification settings and login items
- Docker Desktop sign-in
- Ollama and LM Studio model downloads
