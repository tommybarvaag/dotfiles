-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

-- Use the Go port of tsserver (fast, native monorepo support).
-- Redundant with the `lang.typescript.tsgo` extra but makes intent explicit.
vim.g.lazyvim_ts_lsp = "tsgo"
