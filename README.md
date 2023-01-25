## Introduction

This repository serves as my way to help me setup and maintain my Mac. It takes the effort out of installing everything manually. Everything needed to install my preferred setup of macOS is detailed in this readme. Feel free to explore, learn and copy parts for your own dotfiles.

### Setting up your Mac

After backing up your old Mac you may now follow these install instructions to setup a new one.

1. Update macOS to the latest version through system preferences
2. [Generate a new public and private SSH key](https://docs.github.com/en/github/authenticating-to-github/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent) by running:

```zsh
    curl https://raw.githubusercontent.com/tommybarvaag/dotfiles/HEAD/ssh.sh | sh -s "<your-email-address>"
```

3. Clone this repo to `~/.dotfiles` with:

```zsh
    git clone --recursive git@github.com:tommybarvaag/dotfiles.git ~/.dotfiles
```

4. Run the installation with:

```zsh
~/.dotfiles/fresh.sh
```

5. Restart your computer to finalize the process

Your Mac is now ready to use!
